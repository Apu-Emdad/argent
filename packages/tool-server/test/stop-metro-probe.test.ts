import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const execFileSyncMock = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFileSync: (...args: unknown[]) => execFileSyncMock(...args) };
});

import { stopMetroTool } from "../src/tools/simulator/stop-metro";

const runStopMetro = (port: number) => stopMetroTool.execute({}, { port });

const probeThrows = (fields: Record<string, unknown>) =>
  execFileSyncMock.mockImplementation(() => {
    throw Object.assign(new Error(String(fields.message)), fields);
  });

describe("stop-metro port probe", () => {
  let kill: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    execFileSyncMock.mockReset();
    kill = vi.spyOn(process, "kill").mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports stopped:false when lsof exits non-zero", async () => {
    probeThrows({ message: "Command failed: lsof -ti tcp:8081 -sTCP:LISTEN", status: 1 });

    await expect(runStopMetro(8081)).resolves.toEqual({ stopped: false, port: 8081, pids: [] });
  });

  it("fails instead of claiming the port is free when lsof is absent", async () => {
    probeThrows({ message: "spawnSync lsof ENOENT", code: "ENOENT", status: null });

    await expect(runStopMetro(8081)).rejects.toThrow(
      "Could not determine what is listening on port 8081: spawnSync lsof ENOENT"
    );
  });

  it("fails instead of claiming the port is free when lsof times out", async () => {
    probeThrows({ message: "spawnSync lsof ETIMEDOUT", code: "ETIMEDOUT", status: null });

    await expect(runStopMetro(8081)).rejects.toThrow(
      "Could not determine what is listening on port 8081: spawnSync lsof ETIMEDOUT"
    );
  });

  it("kills nothing when lsof prints something other than PIDs", async () => {
    execFileSyncMock.mockReturnValue(
      "1\t/bin/busybox\t0\t/dev/null\n9\t/bin/busybox\t1\tpipe:[1]\n"
    );

    await expect(runStopMetro(8081)).rejects.toThrow(
      "Could not determine what is listening on port 8081: lsof did not print a PID list: 1\t/bin/busybox\t0\t/dev/null"
    );
    expect(kill).not.toHaveBeenCalled();
  });

  it("kills every PID lsof reports", async () => {
    execFileSyncMock.mockReturnValue("4242\n4243\n");

    await expect(runStopMetro(8081)).resolves.toEqual({
      stopped: true,
      port: 8081,
      pids: [4242, 4243],
    });
    expect(kill.mock.calls).toEqual([
      [4242, "SIGTERM"],
      [4243, "SIGTERM"],
    ]);
  });
});
