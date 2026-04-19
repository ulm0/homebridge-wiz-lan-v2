import { PlatformAccessory } from "homebridge";

import HomebridgeWizLan from "../../wiz";
import { Device } from "../../types";
import {
  getPilot as _getPilot,
  setPilot as _setPilot,
} from "../../util/network";
import {
  transformOnOff,
} from "./characteristics";
import { WizPilot } from "../WizAccessory";

export interface Pilot extends WizPilot {
  mac: string;
  rssi: number;
  src: string;
  state: boolean;
}

// We need to cache all the state values
// since we need to send them all when
// updating, otherwise the bulb resets
// to default values
export const cachedPilot: { [mac: string]: Pilot } = {};

function updatePilot(
  wiz: HomebridgeWizLan,
  accessory: PlatformAccessory,
  _: Device,
  pilot: Pilot | Error
) {
  const { Service } = wiz;
  const service = accessory.getService(Service.Outlet)!;

  service
    .getCharacteristic(wiz.Characteristic.On)
    .updateValue(pilot instanceof Error ? pilot : transformOnOff(pilot));
}

// Write a custom getPilot/setPilot that takes this
// caching into account
export function getPilot(
  wiz: HomebridgeWizLan,
  accessory: PlatformAccessory,
  device: Device,
  onSuccess: (pilot: Pilot) => void,
  onError: (error: Error) => void
) {
  _getPilot<Pilot>(wiz, device, (error, pilot) => {
    if (error !== null) {
      const cached = cachedPilot[device.mac];
      if (cached) {
        wiz.log.warn(`[getPilot] No response from ${device.mac} within 1s, using cached state`);
        onSuccess(cached);
      } else {
        onError(error);
      }
      return;
    }
    cachedPilot[device.mac] = pilot;
    onSuccess(pilot);
  });
}

export function setPilot(
  wiz: HomebridgeWizLan,
  _: PlatformAccessory,
  device: Device,
  pilot: Partial<Pilot>,
  callback: (error: Error | null) => void
) {
  const oldPilot = cachedPilot[device.mac];
  if (typeof oldPilot == "undefined") {
    callback(new Error(`No cached state for ${device.mac}`));
    return;
  }
  const newPilot = {
    ...oldPilot,
    state: oldPilot.state ?? false,
    ...pilot,
    sceneId: undefined,
  };

  cachedPilot[device.mac] = {
    ...oldPilot,
    ...newPilot,
  } as any;
  return _setPilot(wiz, device, newPilot, (error) => {
    if (error !== null) {
      cachedPilot[device.mac] = oldPilot;
    }
    callback(error);
  });
}