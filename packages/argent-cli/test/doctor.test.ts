import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  childFailureReason,
  classifyMcpEntry,
  findGlobalArgent,
  platformChecks,
  remoteCheck,
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
    cwd: projectRoot,
    globalOnPath: true,
    localInstalled: false,
    argentCmd: "argent",
    installCmd: "pnpm install",
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
    for (const entry of [
      { command: "npx", args: ["--no-install", "argent", "mcp"] },
      { command: "yarn", args: ["argent", "mcp"] },
    ]) {
      const missing = classifyMcpEntry(entry, ctx());
      expect(missing).toMatchObject({ status: "error", fix: "pnpm install" });
      expect(classifyMcpEntry(entry, ctx({ localInstalled: true })).status).toBe("ok");
    }
  });

  it("accepts an on-demand npx entry without a local install", () => {
    const entry = { command: "npx", args: ["-y", "@swmansion/argent@latest", "mcp"] };
    expect(classifyMcpEntry(entry, ctx()).status).toBe("ok");
  });

  it("fails entries that don't end in `mcp`", () => {
    for (const entry of [
      { command: "argent", args: [] },
      { command: "argent", args: ["server", "start"] },
      { command: "node", args: ["node_modules/@swmansion/argent/dist/cli.js"] },
      { command: "npx", args: ["--no-install", "argent"] },
    ]) {
      expect(classifyMcpEntry(entry, ctx({ localInstalled: true })).status).toBe("error");
    }
  });

  it("warns about an entry switched off in the editor", () => {
    const entry = { command: "argent", args: ["mcp"], disabled: true };
    expect(classifyMcpEntry(entry, ctx()).status).toBe("warn");
  });

  it("skips node flags to find the script", () => {
    const rel = "node_modules/@swmansion/argent/dist/cli.js";
    fs.mkdirSync(path.dirname(path.join(projectRoot, rel)), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, rel), "");
    const entry = { command: "node", args: ["--no-warnings", rel, "mcp"] };
    expect(classifyMcpEntry(entry, ctx()).status).toBe("ok");
  });

  it("does not judge a path that uses an editor variable", () => {
    const entry = {
      command: "node",
      args: ["${workspaceFolder}/node_modules/@swmansion/argent/dist/cli.js", "mcp"],
    };
    expect(classifyMcpEntry(entry, ctx()).status).toBe("info");
  });

  it("checks that an absolute command exists", () => {
    const missing = { command: path.join(projectRoot, "bin", "argent"), args: ["mcp"] };
    expect(classifyMcpEntry(missing, ctx({ globalOnPath: false })).status).toBe("error");

    fs.mkdirSync(path.join(projectRoot, "bin"));
    fs.writeFileSync(missing.command, "");
    expect(classifyMcpEntry(missing, ctx({ globalOnPath: false })).status).toBe("ok");
  });

  it("points a dead project-dependency path at the project's install command", () => {
    const entry = { command: "node", args: ["node_modules/@swmansion/argent/dist/cli.js", "mcp"] };
    expect(classifyMcpEntry(entry, ctx()).fix).toBe("pnpm install");
  });

  it("flags an unparseable entry", () => {
    expect(classifyMcpEntry({ command: "", args: [] }, ctx()).status).toBe("warn");
  });

  it("does not judge a custom command", () => {
    expect(classifyMcpEntry({ command: "argent-dev", args: [] }, ctx()).status).toBe("info");
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
    xcode: { developerDir: "/Applications/Xcode.app/Contents/Developer", simctl: true },
    ...overrides,
  };
}

describe("platformChecks", () => {
  it("reports a missing optional toolchain as info with its install hint", () => {
    const vega = platformChecks(hostDeps(), "reinstall").find((c) => c.label.startsWith("Vega"));
    expect(vega).toMatchObject({ status: "info", fix: "install vega" });
  });

  it("warns, without failing, when only Chromium is usable", () => {
    const none = hostDeps({
      deps: [
        { dep: "xcrun", path: null, hint: "install xcode" },
        { dep: "adb", path: null, hint: "install adb" },
        { dep: "emulator", path: null, hint: "install emulator" },
        { dep: "vega", path: null, hint: "install vega" },
      ],
    });
    const checks = platformChecks(none, "reinstall");
    expect(checks[0]).toMatchObject({ status: "warn" });
    expect(checks.some((c) => c.status === "error")).toBe(false);
    expect(platformChecks(hostDeps(), "reinstall").some((c) => c.status === "warn")).toBe(false);
  });

  it("does not count the /usr/bin/xcrun shim without simctl as iOS support", () => {
    const shimOnly = hostDeps({
      deps: [
        { dep: "xcrun", path: "/usr/bin/xcrun", hint: "install xcode" },
        { dep: "adb", path: null, hint: "install adb" },
        { dep: "emulator", path: null, hint: "install emulator" },
        { dep: "vega", path: null, hint: "install vega" },
      ],
      xcode: { developerDir: "/Library/Developer/CommandLineTools", simctl: false },
    });
    const checks = platformChecks(shimOnly, "reinstall");
    expect(checks.some((c) => c.status === "ok" && c.label === "iOS simulator")).toBe(false);
    expect(checks[0]?.label).toMatch(/No mobile platform toolchain/);
  });

  it("needs adb for Vega", () => {
    const vegaOnly = (adb: string | null) =>
      hostDeps({
        platform: "linux",
        signing: null,
        xcode: null,
        deps: [
          { dep: "xcrun", path: null, hint: "install xcode" },
          { dep: "adb", path: adb, hint: "install adb" },
          { dep: "emulator", path: null, hint: "install emulator" },
          { dep: "vega", path: "/home/me/vega/bin/vega", hint: "install vega" },
        ],
      });
    const withoutAdb = platformChecks(vegaOnly(null), "reinstall");
    expect(withoutAdb.find((c) => c.label.startsWith("Vega"))).toMatchObject({
      status: "warn",
      fix: "install adb",
    });
    expect(withoutAdb[0]?.label).toMatch(/No mobile platform toolchain/);
    const withAdb = platformChecks(vegaOnly("/sdk/adb"), "reinstall");
    expect(withAdb.find((c) => c.label.startsWith("Vega"))?.status).toBe("ok");
    expect(withAdb.some((c) => c.status === "warn")).toBe(false);
  });

  it("errors when a bundled artifact is missing (a broken install)", () => {
    const broken = hostDeps({
      bundled: [{ name: "simulator-server", path: null, error: "not found" }],
    });
    const checks = platformChecks(broken, "reinstall");
    expect(checks[0]).toMatchObject({
      status: "error",
      label: "Bundled simulator-server is missing",
      fix: "reinstall",
    });
    expect(checks.some((c) => c.label === "iOS simulator")).toBe(false);
  });

  it("skips iOS off macOS", () => {
    const linux = platformChecks(
      hostDeps({ platform: "linux", signing: null, xcode: null }),
      "reinstall"
    );
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
  const d = path.delimiter;

  it("drops the node_modules/.bin dirs npx and npm scripts prepend", () => {
    const input = [
      "/app/pkg/node_modules/.bin",
      "/app/node_modules/.bin/",
      "/node_modules/.bin",
      "/opt/homebrew/bin",
      "/usr/bin",
    ].join(d);
    expect(stripPackageBinDirs(input, "/app/pkg")).toBe(["/opt/homebrew/bin", "/usr/bin"].join(d));
  });

  it("keeps a global bin that happens to be a node_modules/.bin (Yarn classic)", () => {
    const yarnGlobal = "/home/me/.config/yarn/global/node_modules/.bin";
    const input = [yarnGlobal, "/app/node_modules/.bin-tools"].join(d);
    expect(stripPackageBinDirs(input, "/app")).toBe(input);
  });
});

describe("findGlobalArgent", () => {
  const writeBin = (dir: string, body: string): string => {
    fs.mkdirSync(dir, { recursive: true });
    const bin = path.join(dir, "argent");
    fs.writeFileSync(bin, body, { mode: 0o755 });
    return bin;
  };

  it("accepts a script shim (pnpm, Yarn) without resolving its version", () => {
    const bin = writeBin(path.join(projectRoot, "pnpm"), '#!/bin/sh\nexec node x "$@"\n');
    expect(findGlobalArgent(path.dirname(bin))).toEqual({ bin, root: null, version: null });
  });

  it("reads the version through an npm bin symlink", () => {
    const pkg = path.join(projectRoot, "lib", "node_modules", "@swmansion", "argent");
    fs.mkdirSync(path.join(pkg, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "@swmansion/argent", version: "1.2.3" })
    );
    fs.writeFileSync(path.join(pkg, "dist", "cli.js"), "", { mode: 0o755 });
    const binDir = path.join(projectRoot, "bin");
    fs.mkdirSync(binDir);
    fs.symlinkSync(path.join(pkg, "dist", "cli.js"), path.join(binDir, "argent"));
    expect(findGlobalArgent(binDir)).toMatchObject({ version: "1.2.3" });
  });

  it("skips npx caches and missing dirs", () => {
    const npx = writeBin(path.join(projectRoot, "_npx", "abc", "node_modules", ".bin"), "");
    const dirs = [path.join(projectRoot, "nope"), path.dirname(npx)].join(path.delimiter);
    expect(findGlobalArgent(dirs)).toBeNull();
  });
});

describe("remoteCheck", () => {
  it("tells a rejected token apart from a dead server", () => {
    expect(remoteCheck(200, "http://h:1", "link").status).toBe("ok");
    expect(remoteCheck(401, "http://h:1", "link").label).toMatch(/rejects the token/);
    expect(remoteCheck(null, "http://h:1", "link").label).toMatch(/unreachable/);
  });

  it("doesn't suggest argent unlink when the URL comes from ARGENT_TOOLS_URL", () => {
    expect(remoteCheck(null, "http://h:1", "env").fix).toMatch(/unset ARGENT_TOOLS_URL/);
    expect(remoteCheck(null, "http://h:1", "link").fix).toMatch(/argent unlink/);
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
