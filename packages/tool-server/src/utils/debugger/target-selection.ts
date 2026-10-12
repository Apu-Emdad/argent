import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { CDPTarget } from "./discovery";
import type { MetroDeviceNames } from "./metro-device-name";

interface SelectedTarget {
  target: CDPTarget;
  webSocketUrl: string;
  isNewDebugger: boolean;
  deviceName: string;
}

/**
 * Identify the device a target belongs to.
 *
 * Legacy targets (RN 0.72 / Vega) carry no `reactNative` block, so fall back to
 * the `device` index the proxy puts in the debugger URL — unique per attached
 * device. deviceName is last resort: it names a device *class* ("kepler-device"
 * for every VVD), so two identical devices would collapse into one.
 */
function deviceKey(target: CDPTarget): string | undefined {
  const logicalId = target.reactNative?.logicalDeviceId;
  if (logicalId) return logicalId;
  try {
    const device = new URL(target.webSocketDebuggerUrl).searchParams.get("device");
    if (device) return `device=${device}`;
  } catch {
    // Malformed URL — fall through to the name.
  }
  return target.deviceName;
}

export function selectTarget(
  targets: CDPTarget[],
  port: number,
  options?: Record<string, unknown>
): SelectedTarget {
  // discoverMetro already dropped the legacy proxy's `vm: "don't use"` decoy,
  // so every target here is a real runtime.
  const pool = targets;
  let candidates = pool;

  if (typeof options?.deviceId === "string" && options.deviceId) {
    const deviceId = options.deviceId;
    const filtered = candidates.filter((t) => t.reactNative?.logicalDeviceId === deviceId);
    const byName = filtered.length
      ? []
      : matchByDeviceName(
          pool,
          deviceId,
          port,
          options.deviceNames as MetroDeviceNames | undefined
        );
    if (filtered.length) {
      candidates = filtered;
    } else if (byName.length) {
      candidates = byName;
    } else {
      // Falling back to the priority target would route every unmatched
      // device_id to whichever device Metro lists first, so only fall back when
      // there is a single device; otherwise refuse to guess and report the ids.
      //
      // Count via deviceKey, not logicalDeviceId alone: a legacy device has
      // none, so a Vega device_id would count zero devices, look like "nothing
      // to disambiguate" and fall through into another device's runtime.
      const distinctDevices = new Map<string, { name?: string; logicalId?: string }>();
      for (const t of pool) {
        const key = deviceKey(t);
        if (key && !distinctDevices.has(key)) {
          distinctDevices.set(key, {
            name: t.deviceName,
            logicalId: t.reactNative?.logicalDeviceId,
          });
        }
      }
      if (distinctDevices.size > 1) {
        // Only a logicalDeviceId is a usable device_id; a legacy device's
        // internal key would read like one without being one.
        const listed = [...distinctDevices.values()]
          .map((d) =>
            d.logicalId
              ? `${d.name ?? "unknown"} (${d.logicalId})`
              : `${d.name ?? "unknown"} (legacy inspector — no logicalDeviceId)`
          )
          .join(", ");
        throw new FailureError(
          `No debugger target matches device_id "${deviceId}". ` +
            `${distinctDevices.size} devices are connected to Metro on port ${port}: ` +
            `${listed}. Re-target with the logicalDeviceId in parentheses — that is what ` +
            `debugger-connect returns and what subsequent debugger-* calls must pass. ` +
            `A legacy-inspector device (RN 0.72 / Vega) reports none and cannot be singled ` +
            `out of a shared Metro: give it its own Metro port.`,
          {
            error_code: FAILURE_CODES.DEBUGGER_TARGET_DEVICE_MISMATCH,
            failure_stage: "debugger_select_target",
            failure_area: "tool_server",
            error_kind: "not_found",
          }
        );
      }
    }
  }
  if (options?.deviceName) {
    const filtered = candidates.filter((t) => t.deviceName === options.deviceName);
    if (filtered.length) candidates = filtered;
  }

  const fusebox = candidates.find(
    (t) => t.reactNative?.capabilities?.prefersFuseboxFrontend === true
  );
  if (fusebox) return makeResult(fusebox, port, true);

  const cppConn = candidates.find((t) => t.description?.endsWith("[C++ connection]"));
  if (cppConn) return makeResult(cppConn, port, true);

  const bridge = candidates.find((t) => t.title?.startsWith("React Native Bridge"));
  if (bridge) return makeResult(bridge, port, false);

  return makeResult(candidates[0]!, port, false);
}

function describeDevices(pool: CDPTarget[]): { count: number; listed: string } {
  const distinct = new Map<string, { name?: string; logicalId?: string }>();
  for (const t of pool) {
    const key = deviceKey(t);
    if (key && !distinct.has(key)) {
      distinct.set(key, { name: t.deviceName, logicalId: t.reactNative?.logicalDeviceId });
    }
  }
  const listed = [...distinct.values()]
    .map((d) => `${d.name ?? "unknown"}${d.logicalId ? ` (${d.logicalId})` : ""}`)
    .join(", ");
  return { count: distinct.size, listed };
}

/**
 * Resolve a `list-devices` id (UDID / serial) to its target by the device name
 * the app reported to Metro. Metro never sees the UDID, so without this every
 * caller sharing a Metro with a second device had to look up the
 * logicalDeviceId by hand — and with a single device on Metro, any id silently
 * attached to whichever device that was.
 *
 * Returns the matching targets, or [] to fall back to the id-only rules.
 * Throws when the name proves the device is not (uniquely) on this Metro.
 */
function matchByDeviceName(
  pool: CDPTarget[],
  deviceId: string,
  port: number,
  hint: MetroDeviceNames | undefined
): CDPTarget[] {
  if (!hint?.names.length) return [];
  for (const name of hint.names) {
    const matched = pool.filter((t) => t.deviceName === name);
    const keys = new Set(matched.map(deviceKey));
    if (keys.size === 1) return matched;
    if (keys.size > 1) {
      throw new FailureError(
        `device_id "${deviceId}" is "${name}", but ${keys.size} devices with that same name are ` +
          `connected to Metro on port ${port}: ${describeDevices(matched).listed}. ` +
          `Pass the logicalDeviceId in parentheses of the one you mean, or give the devices distinct names.`,
        {
          error_code: FAILURE_CODES.DEBUGGER_TARGET_DEVICE_MISMATCH,
          failure_stage: "debugger_select_target",
          failure_area: "tool_server",
          error_kind: "not_found",
        }
      );
    }
  }
  const connected = describeDevices(pool);
  if (hint.exact && connected.count > 0) {
    throw new FailureError(
      `device_id "${deviceId}" is the simulator "${hint.names[0]}", but no app on that simulator ` +
        `is connected to Metro on port ${port}. Connected: ${connected.listed}. ` +
        `Launch or reload the app on "${hint.names[0]}" (or pass the device_id of a connected device).`,
      {
        error_code: FAILURE_CODES.DEBUGGER_TARGET_DEVICE_MISMATCH,
        failure_stage: "debugger_select_target",
        failure_area: "tool_server",
        error_kind: "not_found",
      }
    );
  }
  return [];
}

function makeResult(target: CDPTarget, port: number, isNewDebugger: boolean): SelectedTarget {
  return {
    target,
    webSocketUrl: normalizeWsUrl(target.webSocketDebuggerUrl, port),
    isNewDebugger,
    deviceName: target.deviceName ?? target.title ?? "unknown",
  };
}

/**
 * Force the host to localhost (Android emulator returns 10.0.2.2) and the port
 * to the known Metro port (the proxy may report a wrong one).
 */
function normalizeWsUrl(wsUrl: string, port: number): string {
  const url = new URL(wsUrl);
  url.hostname = "localhost";
  url.port = port.toString();
  return url.toString();
}
