import dgram from "dgram";
import getMac from "getmac";
import {internalIpV4Sync} from "internal-ip";

import { Pilot as BulbPilot } from "../accessories/WizLight/pilot";
import { Pilot as SocketPilot } from "../accessories/WizSocket/pilot";
import { Device } from "../types";
import HomebridgeWizLan from "../wiz";
import { makeLogger } from "./logger";

function strMac() {
  return getMac().toUpperCase().replace(/:/g, "");
}

function strIp() {
  return internalIpV4Sync() ?? "0.0.0.0";
}

const BROADCAST_PORT = 38899;

function getNetworkConfig({ config }: HomebridgeWizLan) {
  return {
    ADDRESS: config.address ?? strIp(),
    PORT: config.port ?? 38900,
    BROADCAST: config.broadcast ?? "255.255.255.255",
    MAC: config.mac ?? strMac(),
  };
}

const getPilotQueue: {
  [mac: string]: {
    callbacks: ((error: Error | null, pilot: any) => void)[];
    timeout: NodeJS.Timeout;
  };
} = {};
export function getPilot<T>(
  wiz: HomebridgeWizLan,
  device: Device,
  callback: (error: Error | null, pilot: T) => void
) {
  if (device.mac in getPilotQueue) {
    // Piggyback on the already in-flight request — no extra UDP packet sent
    getPilotQueue[device.mac].callbacks.push(callback);
    return;
  }
  // No in-flight request for this device — fire immediately
  const timeout = setTimeout(() => {
    if (device.mac in getPilotQueue) {
      const { callbacks } = getPilotQueue[device.mac];
      delete getPilotQueue[device.mac];
      callbacks.forEach((f) => f(new Error(`No response from ${device.mac} within 1s`), null as any));
    }
  }, 1000);
  getPilotQueue[device.mac] = { callbacks: [callback], timeout };
  wiz.log.debug(`[getPilot] Sending getPilot to ${device.mac}`);
  wiz.socket.send(
    `{"method":"getPilot","params":{}}`,
    BROADCAST_PORT,
    device.ip,
    (error: Error | null) => {
      if (error !== null && device.mac in getPilotQueue) {
        clearTimeout(getPilotQueue[device.mac].timeout);
        wiz.log.debug(
          `[Socket] Failed to send getPilot to ${device.mac}: ${error.toString()}`
        );
        const { callbacks } = getPilotQueue[device.mac];
        delete getPilotQueue[device.mac];
        callbacks.forEach((f) => f(error, null as any));
      }
    }
  );
}

const setPilotQueue: {
  [mac: string]: { ip: string; complete: (error: Error | null) => void };
} = {};
const setPilotPending: {
  [mac: string]: {
    wiz: HomebridgeWizLan;
    device: Device;
    pilot: Partial<BulbPilot> | Partial<SocketPilot>;
    callbacks: ((error: Error | null) => void)[];
  };
} = {};

export function setPilot(
  wiz: HomebridgeWizLan,
  device: Device,
  pilot: Partial<BulbPilot> | Partial<SocketPilot>,
  callback: (error: Error | null) => void
) {
  if (device.mac in setPilotQueue) {
    // In-flight: coalesce into pending, keeping all accumulated callbacks
    const existing = setPilotPending[device.mac];
    setPilotPending[device.mac] = {
      wiz,
      device,
      pilot,
      callbacks: [...(existing?.callbacks ?? []), callback],
    };
    return;
  }
  sendSetPilot(wiz, device, pilot, [callback]);
}

function sendSetPilot(
  wiz: HomebridgeWizLan,
  device: Device,
  pilot: Partial<BulbPilot> | Partial<SocketPilot>,
  callbacks: ((error: Error | null) => void)[]
) {
  const { ip, mac } = device;
  const msg = JSON.stringify({
    method: "setPilot",
    env: "pro",
    params: Object.assign({ mac: device.mac, src: "udp" }, pilot),
  });
  const complete = (error: Error | null) => {
    if (setPilotQueue[mac]?.complete !== complete) return;
    clearTimeout(timeout);
    delete setPilotQueue[mac];
    flushPendingSetPilot(mac);
    callbacks.forEach((f) => f(error));
  };
  const timeout = setTimeout(() => {
    complete(new Error(`No setPilot response from ${ip} within 3s`));
  }, 3000);
  setPilotQueue[mac] = { ip, complete };
  wiz.log.debug(`[SetPilot][${ip}:${BROADCAST_PORT}] ${msg}`);
  wiz.socket.send(msg, BROADCAST_PORT, ip, (error: Error | null) => {
    if (error !== null) {
      wiz.log.debug(
        `[Socket] Failed to send setPilot to ${ip}: ${error.toString()}`
      );
      complete(error);
    }
  });
}

function flushPendingSetPilot(mac: string) {
  if (mac in setPilotPending) {
    const { wiz, device, pilot, callbacks } = setPilotPending[mac];
    delete setPilotPending[mac];
    sendSetPilot(wiz, device, pilot, callbacks);
  }
}

export function createSocket(wiz: HomebridgeWizLan) {
  const log = makeLogger(wiz, "Socket");

  const socket = dgram.createSocket("udp4");

  socket.on("error", (err) => {
    log.error(`UDP Error: ${err}`);
  });

  socket.on("message", (msg, rinfo) => {
    const decryptedMsg = msg.toString("utf8");
    log.debug(
      `[${rinfo.address}:${rinfo.port}] Received message: ${decryptedMsg}`
    );
  });

  wiz.api.on("shutdown", () => {
    log.debug("Shutting down socket");
    socket.close();
  });

  return socket;
}

export function bindSocket(wiz: HomebridgeWizLan, onReady: () => void) {
  const log = makeLogger(wiz, "Socket");
  const { PORT, ADDRESS } = getNetworkConfig(wiz);
  log.info(`Setting up socket on ${ADDRESS ?? "0.0.0.0"}:${PORT}`);
  wiz.socket.bind(PORT, ADDRESS, () => {
    const sockAddress = wiz.socket.address();
    log.debug(
      `Socket Bound: UDP ${sockAddress.family} listening on ${sockAddress.address}:${sockAddress.port}`
    );
    wiz.socket.setBroadcast(true);
    onReady();
  });
}

export function registerDiscoveryHandler(
  wiz: HomebridgeWizLan,
  addDevice: (device: Device) => void
) {
  const log = makeLogger(wiz, "Discovery");

  log.debug("Initiating discovery handlers");

  try {
    wiz.socket.on("message", (msg, rinfo) => {
      const decryptedMsg = msg.toString("utf8");
      let response: any;
      const ip = rinfo.address;
      try {
        response = JSON.parse(decryptedMsg);
      } catch (err) {
        log.debug(
          `Error parsing JSON: ${err}\nFrom: ${rinfo.address} ${rinfo.port} Original: [${msg}] Decrypted: [${decryptedMsg}]`
        );
        return;
      }
      if (response.method === "registration") {
        const mac = response.result.mac;
        log.debug(`[${ip}@${mac}] Sending config request (getSystemConfig)`);
        // Send system config request
        wiz.socket.send(
          `{"method":"getSystemConfig","params":{}}`,
          BROADCAST_PORT,
          ip
        );
      } else if (response.method === "getSystemConfig") {
        const mac = response.result.mac;
        log.debug(`[${ip}@${mac}] Received config`);
        addDevice({
          ip,
          mac,
          model: response.result.moduleName,
        });
      } else if (response.method === "getPilot") {
        const mac = response.result.mac;
        if (mac in getPilotQueue) {
          const { callbacks, timeout } = getPilotQueue[mac];
          clearTimeout(timeout);
          delete getPilotQueue[mac];
          callbacks.forEach((f) => f(null, response.result));
        }
      } else if (response.method === "setPilot") {
        const queued = Object.values(setPilotQueue).find(({ ip }) => ip === rinfo.address);
        queued?.complete(response.error ? new Error(response.error.toString()) : null);
      }
    });
  } catch (err) {
    log.error(`Error: ${err}`);
  }
}

export function sendDiscoveryBroadcast(service: HomebridgeWizLan) {
  const { ADDRESS, MAC, BROADCAST } = getNetworkConfig(service);

  const log = makeLogger(service, "Discovery");
  log.info(`Sending discovery UDP broadcast to ${BROADCAST}:${BROADCAST_PORT}`);

  // Send generic discovery message
  service.socket.send(
    `{"method":"registration","params":{"phoneMac":"${MAC}","register":false,"phoneIp":"${ADDRESS}"}}`,
    BROADCAST_PORT,
    BROADCAST
  );

  // Send discovery message to listed devices
  if (Array.isArray(service.config.devices)) {
    for (const device of service.config.devices) {
      if (device.host) {
        log.info(`Sending discovery UDP broadcast to ${device.host}:${BROADCAST_PORT}`);
        service.socket.send(
          `{"method":"registration","params":{"phoneMac":"${MAC}","register":false,"phoneIp":"${ADDRESS}"}}`,
          BROADCAST_PORT,
          device.host
        );
      }
    }
  }
}
