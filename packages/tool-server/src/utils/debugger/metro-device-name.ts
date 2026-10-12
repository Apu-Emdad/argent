import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { classifyDevice } from "../device-info";
import { deviceSetForUdid, simctlPrefix } from "../ios-device-sets";
import { adbShell } from "../adb";

const execFileAsync = promisify(execFile);

const LOOKUP_TIMEOUT_MS = 3000;

/**
 * The device names Metro's inspector-proxy would report for a `list-devices`
 * id, so a UDID or serial can be matched to its debugger target once several
 * devices share one Metro.
 *
 * Metro never sees the UDID or serial; its `/json/list` only carries a
 * per-connection `logicalDeviceId` and the `deviceName` the app reported:
 * - iOS simulator: `UIDevice.name`, which is the simulator's name in simctl.
 * - Android: `AndroidInfoHelpers.getFriendlyDeviceName()`, i.e.
 *   `"<model> - <release> - API <sdk>"`, or the bare model on Genymotion.
 *
 * `exact` is true when the name identifies the device class with certainty
 * (iOS simulator), so a name that matches no target means the app is not
 * attached on this Metro rather than that our guess of the format was wrong.
 *
 * Best effort: a failed lookup returns no names and the caller keeps its old
 * behaviour. Successful lookups are cached; names change only on rename.
 */
export interface MetroDeviceNames {
  names: string[];
  exact: boolean;
}

const cache = new Map<string, MetroDeviceNames>();

export async function metroDeviceNamesFor(deviceId: string): Promise<MetroDeviceNames> {
  const cached = cache.get(deviceId);
  if (cached) return cached;
  let result: MetroDeviceNames = { names: [], exact: false };
  try {
    const platform = classifyDevice(deviceId);
    if (platform === "ios") result = await iosSimulatorNames(deviceId);
    else if (platform === "android") result = await androidNames(deviceId);
  } catch {
    // Unknown device, missing entitlement or a slow tool: no hint.
  }
  if (result.names.length) cache.set(deviceId, result);
  return result;
}

async function iosSimulatorNames(udid: string): Promise<MetroDeviceNames> {
  const args = [...simctlPrefix(await deviceSetForUdid(udid)), "list", "devices", "-j"];
  const { stdout } = await execFileAsync("xcrun", args, {
    timeout: LOOKUP_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as {
    devices?: Record<string, Array<{ udid: string; name: string }>>;
  };
  for (const list of Object.values(parsed.devices ?? {})) {
    const hit = list.find((d) => d.udid.toUpperCase() === udid.toUpperCase());
    if (hit) return { names: [hit.name], exact: true };
  }
  // Not a simulator (physical iPhone): its name is not in simctl.
  return { names: [], exact: false };
}

async function androidNames(serial: string): Promise<MetroDeviceNames> {
  const opts = { timeoutMs: LOOKUP_TIMEOUT_MS };
  const [model, release, sdk] = await Promise.all([
    adbShell(serial, "getprop ro.product.model", opts),
    adbShell(serial, "getprop ro.build.version.release", opts),
    adbShell(serial, "getprop ro.build.version.sdk", opts),
  ]);
  const m = model.trim();
  if (!m) return { names: [], exact: false };
  return { names: [`${m} - ${release.trim()} - API ${sdk.trim()}`, m], exact: false };
}
