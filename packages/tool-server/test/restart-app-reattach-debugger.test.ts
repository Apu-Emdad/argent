import { describe, it, expect, vi } from "vitest";
import { ServiceState, type Registry } from "@argent/registry";

const order: string[] = [];
vi.mock("../src/utils/cross-platform-tool", () => ({
  dispatchByPlatform: () => async () => {
    order.push("relaunch");
    return { restarted: true, bundleId: "com.example.app" };
  },
}));
import { createRestartAppTool } from "../src/tools/restart-app";

const UDID = "11111111-2222-3333-4444-555555555555";
const DEBUGGER = `JsRuntimeDebugger:8081:${UDID}`;

function fakeRegistry(services: Array<[string, ServiceState]>, failResolves = 0) {
  let resolveCalls = 0;
  const registry = {
    getSnapshot: () => ({ services: new Map(services.map(([urn, state]) => [urn, { state }])) }),
    disposeService: vi.fn(async (urn: string) => void order.push(`dispose ${urn}`)),
    resolveService: vi.fn(async (urn: string) => {
      order.push(`resolve ${urn}`);
      if (++resolveCalls <= failResolves) throw new Error("no CDP target yet");
      return {};
    }),
  };
  return registry;
}

const run = (registry: ReturnType<typeof fakeRegistry>) =>
  createRestartAppTool(registry as unknown as Registry).execute(
    {},
    { udid: UDID, bundleId: "com.example.app" },
    {} as never
  );

describe("restart-app re-attaches the JS debugger for the relaunched app", () => {
  it("ends the running session before the relaunch and reconnects right after it", async () => {
    order.length = 0;
    const registry = fakeRegistry([[DEBUGGER, ServiceState.RUNNING]]);
    await run(registry);
    await vi.waitFor(() => expect(registry.resolveService).toHaveBeenCalled());
    expect(order).toEqual([`dispose ${DEBUGGER}`, "relaunch", `resolve ${DEBUGGER}`]);
  });

  it("keeps retrying until the relaunched runtime shows up on Metro", async () => {
    order.length = 0;
    const registry = fakeRegistry([[DEBUGGER, ServiceState.RUNNING]], 2);
    await run(registry);
    await vi.waitFor(() => expect(registry.resolveService).toHaveBeenCalledTimes(3), {
      timeout: 3000,
    });
  });

  it("leaves other devices and sessions that are not running alone", async () => {
    order.length = 0;
    const registry = fakeRegistry([
      ["JsRuntimeDebugger:8081:other-device", ServiceState.RUNNING],
      [DEBUGGER, ServiceState.ERROR],
    ]);
    await run(registry);
    expect(order).toEqual(["relaunch"]);
    expect(registry.resolveService).not.toHaveBeenCalled();
  });
});
