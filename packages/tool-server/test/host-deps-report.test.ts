import { describe, expect, it, vi } from "vitest";

// Each resolver is stubbed so the report reflects only what this file feeds it,
// not the host the suite runs on.
vi.mock("../src/utils/command-on-path", () => ({
  commandOnPath: async (name: string) => (name === "xcrun" ? "/usr/bin/xcrun" : null),
}));
vi.mock("../src/utils/android-binary", () => ({
  resolveAndroidBinary: async (name: string) => (name === "adb" ? "/sdk/adb" : null),
}));
vi.mock("../src/utils/vega-cli", () => ({ resolveVegaBinary: async () => null }));
vi.mock("../src/utils/ios-device/team-detect", () => ({
  detectSigningTeams: async () => [{ teamId: "T1" }],
}));

import { collectHostDepsReport } from "../src/utils/host-deps-report";

describe("collectHostDepsReport", () => {
  it("reports every dependency doctor reads, with its install hint", async () => {
    const report = await collectHostDepsReport();
    expect(report.platform).toBe(process.platform);
    expect(report.deps.map((d) => [d.dep, d.path])).toEqual([
      ["xcrun", "/usr/bin/xcrun"],
      ["adb", "/sdk/adb"],
      ["emulator", null],
      ["vega", null],
    ]);
    for (const d of report.deps) expect(d.hint.length).toBeGreaterThan(0);
    expect(report.bundled.some((b) => b.name === "simulator-server")).toBe(true);
  });

  it("reads signing and Xcode only on macOS", async () => {
    vi.stubEnv("ARGENT_IOS_TEAM_ID", "ABCDE12345");
    try {
      const report = await collectHostDepsReport();
      if (process.platform === "darwin") {
        expect(report.signing).toEqual({ teamIdEnv: "ABCDE12345", detectedTeams: 0 });
        expect(report.xcode).not.toBeNull();
      } else {
        expect(report.signing).toBeNull();
        expect(report.xcode).toBeNull();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
