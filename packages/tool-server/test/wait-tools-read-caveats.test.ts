import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DescribeTreeData } from "../src/tools/describe/contract";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";

// The adapter is stubbed so one fixture can carry both flags.
const read = vi.hoisted(() => ({
  data: null as DescribeTreeData | null,
  errorAfterFirst: null as string | null,
  calls: 0,
}));
vi.mock("../src/tools/describe/platforms/ios", () => ({
  describeIos: async () => {
    read.calls += 1;
    if (read.errorAfterFirst !== null && read.calls > 1) throw new Error(read.errorAfterFirst);
    return read.data;
  },
  iosRequires: [],
}));

import { createAwaitUiElementTool } from "../src/tools/await-ui-element";
import { createAwaitScreenIdleTool } from "../src/tools/await-screen-idle";

const IOS_UDID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";

const registry = {
  resolveService: vi.fn(async (urn: string) => {
    throw new Error(`unexpected service: ${urn}`);
  }),
} as never;

beforeEach(() => {
  __resetDepCacheForTests();
  __primeDepCacheForTests(["xcrun", "adb"]);
  read.calls = 0;
  read.errorAfterFirst = null;
  read.data = {
    tree: { role: "AXApplication", frame: { x: 0, y: 0, width: 1, height: 1 }, children: [] },
    source: "ax-service",
    should_restart: true,
    hint: "the simulator was not booted through argent",
  };
});

describe("a wait that times out on a read with a diagnosis of its own", () => {
  it("tells await-ui-element's caller to restart the app, and why the tree was empty", async () => {
    const tool = createAwaitUiElementTool(registry);

    const result = await tool.execute(
      {},
      {
        udid: IOS_UDID,
        condition: "visible",
        selector: { text: "Submit" },
        timeoutMs: 40,
        pollIntervalMs: 10,
      }
    );

    expect(result.success).toBe(false);
    expect(result.note).toMatch(/restart-app/);
    expect(result.note).toMatch(/not booted through argent/);
  });

  it("tells await-screen-idle's caller the same, rather than only that it did not settle", async () => {
    const tool = createAwaitScreenIdleTool(registry);

    const result = await tool.execute(
      {},
      { udid: IOS_UDID, timeoutMs: 40, pollIntervalMs: 10, minStableMs: 10 }
    );

    expect(result.settled).toBe(false);
    expect(result.note).toMatch(/restart-app/);
    expect(result.note).toMatch(/not booted through argent/);
  });

  it("reports the read that failed instead, when the device stopped answering", async () => {
    read.errorAfterFirst = "device AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA not booted";
    const tool = createAwaitScreenIdleTool(registry);

    const result = await tool.execute(
      {},
      { udid: IOS_UDID, timeoutMs: 40, pollIntervalMs: 10, minStableMs: 10 }
    );

    expect(read.calls).toBeGreaterThan(1);
    expect(result.note).toMatch(/last tree fetch failed: .*not booted/);
    expect(result.note).not.toMatch(/restart-app/);
  });
});

describe("a wait that settles", () => {
  const rendered = { role: "AXButton", frame: { x: 0, y: 0, width: 1, height: 1 }, children: [] };

  it("carries a hint that questions the tree it settled on into the note", async () => {
    read.data = {
      tree: {
        role: "AXApplication",
        frame: { x: 0, y: 0, width: 1, height: 1 },
        children: [rendered],
      },
      source: "harmony-uitest",
      hint: "The display is off. This tree is what was last composited",
    };
    const tool = createAwaitScreenIdleTool(registry);

    const result = await tool.execute(
      {},
      { udid: IOS_UDID, timeoutMs: 200, pollIntervalMs: 10, minStableMs: 0 }
    );

    expect(result.settled).toBe(true);
    expect(result.note).toMatch(/last composited/);
  });

  it("leaves a standing fact about the target off the note, having settled on a real screen", async () => {
    // iOS' hint orders a reboot, which would undo a wait that settled.
    read.data = {
      tree: {
        role: "AXApplication",
        frame: { x: 0, y: 0, width: 1, height: 1 },
        children: [rendered],
      },
      source: "ax-service",
      should_restart: true,
      hint: "the simulator was not booted through argent",
    };
    const tool = createAwaitScreenIdleTool(registry);

    const result = await tool.execute(
      {},
      { udid: IOS_UDID, timeoutMs: 200, pollIntervalMs: 10, minStableMs: 0 }
    );

    expect(result.settled).toBe(true);
    expect(result.note).toBeUndefined();
  });

  // The two reasons call for opposite responses, so the description names both.
  it("tells the caller both reasons a passing wait still carries a note", async () => {
    const description = createAwaitUiElementTool(registry).description;

    expect(description).toMatch(/not the whole live\s+screen/);
    expect(description).toMatch(/HarmonyOS/);
    expect(description).toMatch(/Chromium/);
    expect(description).toMatch(/never matched\s+anything/);
    expect(description).toMatch(/fix the\s+selector/);
  });
});
