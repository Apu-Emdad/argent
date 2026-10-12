import { ServiceState } from "@argent/registry";
import { z } from "zod";
import type { Registry, ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { nativeDevtoolsRef } from "../../blueprints/native-devtools";
import { resolveDevice } from "../../utils/device-info";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { BUNDLE_ID_MESSAGE, BUNDLE_ID_PATTERN } from "../../utils/bundle-id";
import type { RestartAppResult, RestartAppVegaServices, RestartAppIosServices } from "./types";
import { makeIosImpl } from "./platforms/ios";
import { iosDeviceImpl } from "./platforms/ios-device";
import { iosRemoteImpl } from "./platforms/ios-remote";
import { androidImpl } from "./platforms/android";
import { vegaImpl } from "./platforms/vega";

// Same alphabet as launch-app's ACTIVITY_PATTERN: leading `.` for shorthand
// activities like `.MainActivity`, no leading `-` (flag injection).
const ACTIVITY_PATTERN = /^[A-Za-z_.][A-Za-z0-9._/-]*$/;

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
  bundleId: z
    .string()
    .min(1)
    .regex(BUNDLE_ID_PATTERN, BUNDLE_ID_MESSAGE)
    .describe("App identifier. iOS: bundle id. Android: package name."),
  activity: z
    .string()
    .regex(ACTIVITY_PATTERN, "activity may only contain letters, digits, '.', '_', '-' and '/'")
    .optional()
    .describe(
      "Android-only: relaunch a non-launcher Activity (e.g. `.SettingsActivity` or `com.example/com.example.SettingsActivity`). If omitted, the app's default launcher activity is used. Ignored on iOS."
    ),
  launchArgs: z
    .array(z.string())
    .optional()
    .describe(
      'Apple simulators and physical iPhones: arguments passed to the app process at launch, e.g. `["-FeatureFlag", "YES"]` to override UserDefaults. Ignored on other targets.'
    ),
});

type Params = z.infer<typeof zodSchema>;

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
  vega: { vvd: true },
};

// Local iOS resolves native-devtools inside the handler rather than via
// `services()`. A tvOS sim classifies as platform "ios", and native-devtools
// covers it too (ensureEnv injects the TVOSSIMULATOR dylib slice).
export function createRestartAppTool(registry: Registry): ToolDefinition<Params, RestartAppResult> {
  const tool: ToolDefinition<Params, RestartAppResult> = {
    id: "restart-app",
    interaction: {
      startedMsg: ({ params }) => `Restarting ${params.bundleId}`,
      completedMsg: ({ params }) => `Restarted ${params.bundleId}`,
      failedMsg: ({ params, failureSignal }) =>
        `Failed to restart ${params.bundleId}: ${failureSignal.error_code}`,
    },
    description: `Terminate then relaunch an app by bundle id / package name.
Use when you need a clean in-memory state without a full reinstall. Also refreshes the native-devtools injection before the relaunch (the iOS slice on iOS, the tvOS slice on Apple TV); on tvOS, interaction is focus-driven — use the tv-* tools rather than coordinate taps.
Returns { restarted, bundleId }. Fails if the app is not installed.`,
    alwaysLoad: true,
    searchHint:
      "terminate relaunch restart reset app bundle id package simulator emulator vega tvos fire tv",
    zodSchema,
    capability,
    // Only ios-remote's handler reads `services.nativeDevtools`, so only it
    // needs an eager declaration.
    services: (params): Record<string, ServiceRef> => {
      const device = resolveDevice(params.udid);
      if (device.platform === "ios-remote") return { nativeDevtools: nativeDevtoolsRef(device) };
      return {};
    },
    execute: dispatchByPlatform<
      Record<string, unknown>,
      Record<string, unknown>,
      Params,
      RestartAppResult,
      // No chromium branch.
      Record<string, unknown>,
      RestartAppVegaServices,
      RestartAppIosServices
    >({
      toolId: "restart-app",
      capability,
      ios: makeIosImpl(registry),
      iosDevice: iosDeviceImpl,
      iosRemote: iosRemoteImpl,
      android: androidImpl,
      vega: vegaImpl,
    }),
  };
  const relaunch = tool.execute.bind(tool);
  tool.execute = async (services, params, ctx) => {
    const sessions = runningDebuggerSessions(registry, params.udid);
    // End them cleanly first rather than leaving a dead socket for the next
    // call to trip over; the relaunched app gets a fresh session and log.
    for (const urn of sessions) await registry.disposeService(urn).catch(() => {});
    const result = await relaunch(services, params, ctx);
    for (const urn of sessions) void reattachDebugger(registry, urn);
    return result;
  };
  return tool;
}

/** JS-runtime debugger sessions currently attached to `udid`'s app. */
function runningDebuggerSessions(registry: Registry, udid: string): string[] {
  const urns: string[] = [];
  // Best effort: a registry without a snapshot (tests, embedders) has nothing to re-attach.
  const services =
    typeof registry.getSnapshot === "function" ? registry.getSnapshot().services : [];
  for (const [urn, node] of services) {
    if (
      urn.startsWith("JsRuntimeDebugger:") &&
      urn.endsWith(`:${udid}`) &&
      node.state === ServiceState.RUNNING
    ) {
      urns.push(urn);
    }
  }
  return urns;
}

const REATTACH_BUDGET_MS = 30_000;
const REATTACH_INTERVAL_MS = 250;

/**
 * Reconnect a debugger session as soon as the relaunched app's runtime shows up
 * on Metro, so console logs from its startup are captured.
 * Logs printed while no session is attached are lost for good — the runtime
 * does not replay them — so waiting for the agent's next debugger call (the old
 * behaviour) dropped the whole cold start.
 */
async function reattachDebugger(registry: Registry, urn: string): Promise<void> {
  const deadline = Date.now() + REATTACH_BUDGET_MS;
  while (Date.now() < deadline) {
    try {
      await registry.resolveService(urn);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, REATTACH_INTERVAL_MS));
    }
  }
}
