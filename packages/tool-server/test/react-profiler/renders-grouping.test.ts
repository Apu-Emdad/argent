import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { COLLECT_RENDERS_SCRIPT } from "../../src/tools/profiler/react/react-profiler-renders";

type Row = { instanceCount: number; maxActualDuration: number; selfBaseDuration: number };

function runScript(rootFiber: unknown): Record<string, Row> {
  const hook = {
    _renderers: { 1: {} },
    __argent_roots__: [{ current: rootFiber }],
  };
  const json = runInNewContext(COLLECT_RENDERS_SCRIPT, {
    __REACT_DEVTOOLS_GLOBAL_HOOK__: hook,
    JSON,
    Object,
  }) as string;
  return JSON.parse(json) as Record<string, Row>;
}

const view = (
  actualDuration: number,
  selfBaseDuration: number,
  child: unknown = null,
  sibling: unknown = null
) => ({ type: "View", actualDuration, selfBaseDuration, child, sibling });

describe("COLLECT_RENDERS_SCRIPT — same-name fibers", () => {
  it("reports the largest nested instance's subtree and the summed self", () => {
    const row = runScript(view(20, 1, view(15, 1, view(10, 1))))["View"]!;

    expect(row.instanceCount).toBe(3);
    expect(row.maxActualDuration).toBe(20);
    expect(row.selfBaseDuration).toBe(3);
  });

  it("keeps the largest sibling when a smaller one is walked after it", () => {
    const row = runScript(view(9, 1, null, view(5, 1)))["View"]!;

    expect(row.instanceCount).toBe(2);
    expect(row.maxActualDuration).toBe(9);
  });
});
