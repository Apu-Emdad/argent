import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  childFailureReason,
  classifyMcpEntry,
  platformChecks,
  renderDoctorReport,
  stripPackageBinDirs,
  type DoctorReport,
  type EntryContext,
} from "../src/doctor.js";

/**
 * `argent doctor` is only useful if its verdicts match what actually happens
 * when an editor spawns the MCP entry or a tool needs a host binary. These pin
 * the verdicts; collection itself reuses probes tested elsewhere.
 */

let projectRoot: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argent-doctor-"));
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

function ctx(overrides: Partial<EntryContext> = {}): EntryContext {
  return {
    scope: "project",
    projectRoot,
    globalOnPath: true,
    localInstalled: false,
    ...overrides,
  };
}

describe("classifyMcpEntry", () => {
  it("accepts bare `argent mcp` when argent is on PATH", () => {
    expect(classifyMcpEntry({ command: "argent", args: ["mcp"] }, ctx()).status).toBe("ok");
  });

  it("fails bare `argent mcp` when argent is not on PATH", () => {
    const result = classifyMcpEntry(
      { command: "argent", args: ["mcp"] },
      ctx({ globalOnPath: false })
    );
    expect(result.status).toBe("error");
    expect(result.fix).toContain("argent init");
  });

  it("only warns when custom env may make `argent` resolve inside the editor", () => {
    const result = classifyMcpEntry(
      { command: "argent", args: ["mcp"], env: { PATH: "/custom/bin" } },
      ctx({ globalOnPath: false })
    );
    expect(result.status).toBe("warn");
  });

  it("does not count the legacy ARGENT_MCP_LOG env as a customization", () => {
    const result = classifyMcpEntry(
      { command: "argent", args: ["mcp"], env: { ARGENT_MCP_LOG: "/tmp/x.log" } },
      ctx({ globalOnPath: false })
    );
    expect(result.status).toBe("error");
  });

  it("checks a local-mode `node <path>` entry against the project root", () => {
    const rel = "node_modules/@swmansion/argent/dist/cli.js";
    const entry = { command: "node", args: [rel, "mcp"] };
    expect(classifyMcpEntry(entry, ctx()).status).toBe("error");

    fs.mkdirSync(path.dirname(path.join(projectRoot, rel)), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, rel), "");
    expect(classifyMcpEntry(entry, ctx()).status).toBe("ok");
  });

  it("requires a local install for npx and yarn entries", () => {
    const entry = { command: "npx", args: ["--no-install", "argent", "mcp"] };
    expect(classifyMcpEntry(entry, ctx()).status).toBe("error");
    expect(classifyMcpEntry(entry, ctx({ localInstalled: true })).status).toBe("ok");
  });

  it("flags an unparseable entry", () => {
    expect(classifyMcpEntry({ command: "", args: [] }, ctx()).status).toBe("warn");
  });

  it("does not judge a custom command", () => {
    expect(classifyMcpEntry({ command: "/opt/argent-dev", args: [] }, ctx()).status).toBe("info");
  });
});

type HostDeps = Parameters<typeof platformChecks>[0];

function hostDeps(overrides: Partial<HostDeps> = {}): HostDeps {
  return {
    platform: "darwin",
    deps: [
      { dep: "xcrun", path: "/usr/bin/xcrun", hint: "install xcode" },
      { dep: "adb", path: "/sdk/platform-tools/adb", hint: "install adb" },
      { dep: "emulator", path: "/sdk/emulator/emulator", hint: "install emulator" },
      { dep: "vega", path: null, hint: "install vega" },
    ],
    bundled: [{ name: "simulator-server", path: "/pkg/bin/darwin/simulator-server" }],
    signing: { teamIdEnv: null, detectedTeams: 1 },
    ...overrides,
  };
}

describe("platformChecks", () => {
  it("reports a missing optional toolchain as info with its install hint", () => {
    const vega = platformChecks(hostDeps()).find((c) => c.label.startsWith("Vega"));
    expect(vega).toMatchObject({ status: "info", fix: "install vega" });
  });

  it("errors only when no mobile toolchain is usable", () => {
    const none = hostDeps({
      deps: [
        { dep: "xcrun", path: null, hint: "install xcode" },
        { dep: "adb", path: null, hint: "install adb" },
        { dep: "emulator", path: null, hint: "install emulator" },
        { dep: "vega", path: null, hint: "install vega" },
      ],
    });
    expect(platformChecks(none).filter((c) => c.status === "error")).toHaveLength(1);
    expect(platformChecks(hostDeps()).some((c) => c.status === "error")).toBe(false);
  });

  it("errors when a bundled artifact is missing (a broken install)", () => {
    const broken = hostDeps({
      bundled: [{ name: "simulator-server", path: null, error: "not found" }],
    });
    const checks = platformChecks(broken);
    expect(checks[0]).toMatchObject({
      status: "error",
      label: "Bundled simulator-server is missing",
    });
    expect(checks.some((c) => c.label === "iOS simulator")).toBe(false);
  });

  it("skips iOS off macOS", () => {
    const linux = platformChecks(hostDeps({ platform: "linux", signing: null }));
    expect(linux.find((c) => c.label.startsWith("iOS"))?.status).toBe("info");
    expect(linux.some((c) => c.label.startsWith("Physical iPhone"))).toBe(false);
  });
});

describe("renderDoctorReport", () => {
  it("prints fixes for problems but not for passing checks", () => {
    const report: DoctorReport = {
      version: "1.0.0",
      node: "24.0.0",
      platform: "darwin arm64",
      projectRoot,
      errors: 1,
      warnings: 0,
      sections: [
        {
          title: "Editors (MCP config)",
          checks: [
            { status: "ok", label: "Claude Code: argent mcp", fix: "never shown" },
            { status: "error", label: "Cursor: argent mcp", fix: "argent init" },
          ],
        },
      ],
    };
    const out = renderDoctorReport(report);
    expect(out).toContain("argent init");
    expect(out).not.toContain("never shown");
    expect(out).toContain("1 error, 0 warnings");
  });
});

describe("stripPackageBinDirs", () => {
  it("drops the node_modules/.bin dirs npx and npm scripts prepend", () => {
    const d = path.delimiter;
    const input = [
      "/app/node_modules/.bin",
      "/node_modules/.bin",
      "/opt/homebrew/bin",
      "/usr/bin",
    ].join(d);
    expect(stripPackageBinDirs(input)).toBe(["/opt/homebrew/bin", "/usr/bin"].join(d));
  });
});

describe("childFailureReason", () => {
  it("picks the error line out of a Node crash dump", () => {
    const stderr = [
      "node:internal/modules/cjs/loader:1228",
      "  throw err;",
      "  ^",
      "",
      "Error: Cannot find module '@argent/registry'",
      "Require stack:",
      "- /pkg/dist/tool-server.cjs",
      "",
      "Node.js v24.21.0",
    ].join("\n");
    expect(childFailureReason(stderr, "Command failed")).toBe(
      "Error: Cannot find module '@argent/registry'"
    );
  });

  it("uses a plain stderr message as is", () => {
    expect(childFailureReason("keychain locked\n", "Command failed")).toBe("keychain locked");
  });

  it("falls back to the exec error when stderr is empty", () => {
    expect(childFailureReason("", "Command failed: node x --check-deps")).toBe(
      "Command failed: node x --check-deps"
    );
  });
});
