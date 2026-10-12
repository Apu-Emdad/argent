import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import pc from "picocolors";
import semver from "semver";
import { getConsentState } from "@argent/telemetry";
import {
  getResolvedToolsUrl,
  isToolsServerHealthy,
  isToolsServerProcessAlive,
  readAllToolsServerStates,
  readToolsServerState,
  formatToolsServerUrl,
  type ToolsServerPaths,
} from "@argent/tools-client";
import { MCP_BINARY_NAME, NPM_REGISTRY, PACKAGE_NAME } from "./constants.js";
import {
  ALL_ADAPTERS,
  detectAdapters,
  findConfiguredAdapterScopes,
  getManagedContentTargets,
  hasCustomizingEnv,
  type McpServerEntry,
} from "./mcp-configs.js";
import { readCliRecord } from "./cli-record.js";
import { readInstallRecord } from "./install-record.js";
import {
  getGlobalSkillLockPath,
  getGloballyInstalledPackageRoot,
  getGloballyInstalledVersion,
  getInstalledVersion,
  getProjectSkillLockPath,
  isNewerVersion,
  listArgentSkillsInLock,
  listBundledSkills,
  probeLocalInstall,
  resolveInstallMode,
  resolvePackageRoot,
  resolveProjectRoot,
  ARGENT_SKILL_PREFIX,
  RULES_DIR,
} from "./utils.js";

const execFileAsync = promisify(execFile);

// `argent doctor`: a read-only health report. Every check reuses the probe the
// real code path runs (install topology, MCP entries, tool-server state, the
// tool-server's own dependency resolvers), so doctor and the failure it
// explains can't disagree. It never repairs anything: each problem names the
// command that does (`argent init`, `argent update`, an installer).

type CheckStatus = "ok" | "warn" | "error" | "info";

interface DoctorCheck {
  status: CheckStatus;
  label: string;
  detail?: string;
  /** The command or action that resolves a warn/error. */
  fix?: string;
}

export interface DoctorSection {
  title: string;
  checks: DoctorCheck[];
}

export interface DoctorReport {
  version: string;
  node: string;
  platform: string;
  projectRoot: string;
  sections: DoctorSection[];
  errors: number;
  warnings: number;
}

// Mirrors `tool-server --check-deps` (tool-server/src/utils/host-deps-report.ts).
interface HostDepsReport {
  platform: NodeJS.Platform;
  deps: Array<{ dep: string; path: string | null; hint: string }>;
  bundled: Array<{ name: string; path: string | null; error?: string }>;
  signing: { teamIdEnv: string | null; detectedTeams: number } | null;
}

const UPDATE_CHECK_TIMEOUT_MS = 2_500;
const DEPS_PROBE_TIMEOUT_MS = 30_000;

function check(
  status: CheckStatus,
  label: string,
  extra: Omit<DoctorCheck, "status" | "label"> = {}
): DoctorCheck {
  return { status, label, ...extra };
}

function home(p: string): string {
  const h = homedir();
  return p.startsWith(h) ? `~${p.slice(h.length)}` : p;
}

// MARK: Install

function readEnginesNode(packageRoot: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
      engines?: { node?: string };
    };
    return pkg.engines?.node ?? null;
  } catch {
    return null;
  }
}

function installSection(
  projectRoot: string,
  running: string,
  paths?: ToolsServerPaths
): DoctorSection {
  const checks: DoctorCheck[] = [];
  const packageRoot = paths
    ? path.dirname(path.dirname(paths.bundlePath))
    : resolvePackageRoot(import.meta.dirname);
  const kind = paths?.installKind ?? "global";
  checks.push(
    check("info", `Running v${running} (${kind} install)`, { detail: home(packageRoot) })
  );

  const engines = readEnginesNode(packageRoot);
  if (engines && semver.validRange(engines)) {
    checks.push(
      semver.satisfies(process.versions.node, engines)
        ? check("ok", `Node v${process.versions.node} satisfies ${engines}`)
        : check("error", `Node v${process.versions.node} does not satisfy ${engines}`, {
            fix: "Install a newer Node.js (nvm install --lts)",
          })
    );
  }

  const globalRoot = getGloballyInstalledPackageRoot();
  const globalVersion = getGloballyInstalledVersion();
  checks.push(
    globalRoot
      ? check("ok", `Global install v${globalVersion ?? "?"} on PATH`, { detail: home(globalRoot) })
      : check("info", "No global install on PATH")
  );

  const mode = resolveInstallMode(projectRoot);
  if (mode === "local") {
    const local = probeLocalInstall(projectRoot);
    const source = readInstallRecord(projectRoot) ? ".argent/install.json" : "package.json";
    if (!local.installed) {
      checks.push(
        check("error", `Project uses a local install (${source}) but it is not installed`, {
          fix: "Install project dependencies (npm install)",
        })
      );
    } else if (local.version && isNewerVersion(running, local.version)) {
      checks.push(
        check("warn", `Project's local install v${local.version} is older than v${running}`, {
          fix: "argent update",
        })
      );
    } else {
      checks.push(check("ok", `Project local install v${local.version ?? "?"} (${source})`));
    }
  }

  const record = readCliRecord();
  if (!record) {
    checks.push(
      check("warn", "~/.argent/cli.json is missing (device providers can't find the CLI)", {
        fix: "argent update (or start the MCP server once)",
      })
    );
  } else if (!fs.existsSync(record.cli) || !fs.existsSync(record.node)) {
    const gone = !fs.existsSync(record.cli) ? record.cli : record.node;
    checks.push(
      check("warn", "~/.argent/cli.json points at a path that no longer exists", {
        detail: home(gone),
        fix: "argent update (or start the MCP server once)",
      })
    );
  } else {
    checks.push(check("ok", `~/.argent/cli.json → v${record.version}`));
  }

  return { title: "Install", checks };
}

// MARK: Editors

export interface EntryContext {
  scope: "project" | "global";
  projectRoot: string;
  globalOnPath: boolean;
  localInstalled: boolean;
}

function formatEntry(entry: McpServerEntry): string {
  return [entry.command, ...entry.args].join(" ");
}

/**
 * Will this MCP entry start? Mirrors the "provably dead" rule `init` uses to
 * prune stale entries (init-stale-config.ts): a command that resolves in this
 * shell is fine; one that doesn't is dead unless custom env may fix it in the
 * client (an nvm PATH, classically).
 */
export function classifyMcpEntry(entry: McpServerEntry, ctx: EntryContext): DoctorCheck {
  const cmd = formatEntry(entry);
  if (entry.command === "") {
    return check("warn", "argent entry exists but could not be parsed", { fix: "argent init" });
  }
  if (entry.command === MCP_BINARY_NAME) {
    if (ctx.globalOnPath) return check("ok", cmd);
    if (hasCustomizingEnv(entry)) {
      return check("warn", `${cmd} — \`argent\` is not on this shell's PATH`, {
        detail: "its custom env may still make it resolve inside the editor",
      });
    }
    return check("error", `${cmd} — \`argent\` is not on PATH, so this entry can't start`, {
      fix: "argent init (or npm i -g @swmansion/argent)",
    });
  }
  if (entry.command === "node" && entry.args[0]) {
    const script = entry.args[0];
    const base = ctx.scope === "project" ? ctx.projectRoot : process.cwd();
    const resolved = path.isAbsolute(script) ? script : path.join(base, script);
    return fs.existsSync(resolved)
      ? check("ok", cmd)
      : check("error", `${cmd} — ${script} does not exist`, {
          fix: "Install project dependencies (npm install), then argent update",
        });
  }
  if (entry.command === "npx" || entry.command === "yarn") {
    return ctx.localInstalled
      ? check("ok", cmd)
      : check("error", `${cmd} — no local @swmansion/argent to run`, {
          fix: "Install project dependencies (npm install)",
        });
  }
  return check("info", `${cmd} (custom command, not verified)`);
}

function editorsSection(projectRoot: string): DoctorSection {
  const checks: DoctorCheck[] = [];
  const configured = findConfiguredAdapterScopes(ALL_ADAPTERS, projectRoot);
  const ctx = {
    projectRoot,
    globalOnPath: getGloballyInstalledPackageRoot() !== null,
    localInstalled: probeLocalInstall(projectRoot).installed,
  };

  for (const { adapter, scope, configPath } of configured) {
    let entry: McpServerEntry | null;
    try {
      entry = adapter.getArgentEntry(configPath);
    } catch {
      entry = { command: "", args: [] };
    }
    if (!entry) continue;
    const result = classifyMcpEntry(entry, { ...ctx, scope });
    checks.push({
      ...result,
      label: `${adapter.name}: ${result.label}`,
      detail: [home(configPath) + ` (${scope})`, result.detail].filter(Boolean).join(" · "),
    });
  }

  // Hidden scopes that can outrank the entries above (Claude Code's local
  // scope, VS Code's user-profile mcp.json).
  const seen = new Set<string>();
  for (const { adapter, scope } of configured) {
    if (!adapter.findShadowingConfigs || seen.has(adapter.name)) continue;
    seen.add(adapter.name);
    try {
      for (const finding of adapter.findShadowingConfigs(
        projectRoot,
        scope === "project" ? "local" : "global"
      )) {
        checks.push(
          check("warn", `${adapter.name}: ${finding.reason}`, { detail: finding.location })
        );
      }
    } catch {
      // A malformed editor config must not abort the report.
    }
  }

  if (configured.length === 0) {
    checks.push(
      check("error", "argent is not configured in any editor for this project", {
        fix: "argent init",
      })
    );
  }

  const configuredNames = new Set(configured.map((c) => c.adapter.name));
  const unconfigured = detectAdapters()
    .map((a) => a.name)
    .filter((name) => !configuredNames.has(name));
  if (unconfigured.length > 0) {
    checks.push(
      check("info", `Detected without argent: ${unconfigured.join(", ")}`, {
        detail: "run argent init to add them",
      })
    );
  }

  return { title: "Editors (MCP config)", checks };
}

// MARK: Skills & rules

function listArgentDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(
        (e) => (e.isDirectory() || e.isSymbolicLink()) && e.name.startsWith(ARGENT_SKILL_PREFIX)
      )
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function skillsSection(projectRoot: string): DoctorSection {
  const checks: DoctorCheck[] = [];
  const configured = findConfiguredAdapterScopes(ALL_ADAPTERS, projectRoot);

  const installed = new Set<string>([
    ...listArgentSkillsInLock(getProjectSkillLockPath(projectRoot)),
    ...listArgentSkillsInLock(getGlobalSkillLockPath()),
  ]);
  const ruleTargets: string[] = [];
  for (const scope of ["local", "global"] as const) {
    const adapters = configured
      .filter((c) => (c.scope === "project") === (scope === "local"))
      .map((c) => c.adapter);
    const targets = getManagedContentTargets(adapters, projectRoot, scope);
    for (const t of targets.skillTargets)
      listArgentDirs(t.targetPath).forEach((s) => installed.add(s));
    ruleTargets.push(...targets.ruleTargets.map((t) => t.targetPath));
  }

  const bundled = listBundledSkills();
  const missing = bundled.filter((s) => !installed.has(s));
  if (bundled.length > 0 && missing.length === bundled.length) {
    checks.push(check("error", "No argent skills installed", { fix: "argent init" }));
  } else if (missing.length > 0) {
    checks.push(
      check(
        "warn",
        `${bundled.length - missing.length}/${bundled.length} argent skills installed`,
        {
          detail: `missing: ${missing.join(", ")}`,
          fix: "argent update",
        }
      )
    );
  } else if (bundled.length > 0) {
    checks.push(check("ok", `${bundled.length}/${bundled.length} argent skills installed`));
  }

  let ruleFiles: string[] = [];
  try {
    ruleFiles = fs.readdirSync(RULES_DIR).filter((f) => f.endsWith(".md"));
  } catch {
    // No bundled rules: nothing to compare against.
  }
  for (const target of new Set(ruleTargets)) {
    const absent = ruleFiles.filter((f) => !fs.existsSync(path.join(target, f)));
    checks.push(
      absent.length === 0
        ? check("ok", `Rules present in ${home(target)}`)
        : check("warn", `Rules missing in ${home(target)}`, {
            detail: absent.join(", "),
            fix: "argent update",
          })
    );
  }

  return { title: "Skills & rules", checks };
}

// MARK: Tool-server

async function isRemoteHealthy(url: string, token?: string): Promise<boolean> {
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/tools`, {
      signal: AbortSignal.timeout(2_000),
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function toolServerSection(
  running: string,
  paths?: ToolsServerPaths
): Promise<DoctorSection> {
  const checks: DoctorCheck[] = [];

  const resolved = await getResolvedToolsUrl();
  if (resolved.url) {
    const source = resolved.source === "env" ? "ARGENT_TOOLS_URL" : "~/.argent/link.json";
    checks.push(
      (await isRemoteHealthy(resolved.url, resolved.token))
        ? check("ok", `Linked to ${resolved.url} (${source}), reachable`)
        : check("error", `Linked to ${resolved.url} (${source}), unreachable`, {
            fix: "Start the remote server, or run argent unlink",
          })
    );
    return { title: "Tool-server", checks };
  }

  const state = await readToolsServerState(paths?.bundlePath);
  if (!state) {
    checks.push(check("info", "Not running (starts on the first tool call)"));
  } else {
    const host = state.host ?? "127.0.0.1";
    const url = formatToolsServerUrl(host, state.port);
    const alive = isToolsServerProcessAlive(state.pid);
    const healthy = alive && (await isToolsServerHealthy(state.port, host, 2_000, state.token));
    if (healthy) {
      const stale = state.version && state.version !== running;
      checks.push(
        stale
          ? check("warn", `Running ${url} (pid ${state.pid}) from v${state.version}`, {
              fix: "argent server stop (the next tool call starts the current version)",
            })
          : check("ok", `Running ${url} (pid ${state.pid})`)
      );
    } else {
      checks.push(
        check("info", `Stale state file (pid ${state.pid} ${alive ? "unhealthy" : "gone"})`, {
          detail: "the next tool call respawns it",
        })
      );
    }
  }

  const foreign = (await readAllToolsServerStates()).filter(
    ({ state: s }) => s.bundlePath !== paths?.bundlePath && isToolsServerProcessAlive(s.pid)
  );
  if (foreign.length > 0) {
    checks.push(
      check("info", `${foreign.length} tool-server(s) from other argent installs running`, {
        detail: foreign.map(({ state: s }) => `pid ${s.pid}`).join(", "),
      })
    );
  }

  return { title: "Tool-server", checks };
}

// MARK: Platforms

async function probeHostDeps(paths: ToolsServerPaths): Promise<HostDepsReport | string> {
  try {
    const { stdout } = await execFileAsync(process.execPath, [paths.bundlePath, "--check-deps"], {
      timeout: DEPS_PROBE_TIMEOUT_MS,
      env: {
        ...process.env,
        ARGENT_SIMULATOR_SERVER_DIR: paths.simulatorServerDir,
        ARGENT_NATIVE_DEVTOOLS_DIR: paths.nativeDevtoolsDir,
      },
    });
    return JSON.parse(stdout) as HostDepsReport;
  } catch (err) {
    return err instanceof Error ? err.message.split("\n")[0]! : String(err);
  }
}

export function platformChecks(report: HostDepsReport): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const dep = (name: string) => report.deps.find((d) => d.dep === name);
  const brokenBundle = report.bundled.filter((b) => b.error);
  for (const b of brokenBundle) {
    checks.push(
      check("error", `Bundled ${b.name} is missing`, {
        detail: b.error,
        fix: "Reinstall argent (argent update)",
      })
    );
  }
  const bundleOk = (names: string[]) => !brokenBundle.some((b) => names.includes(b.name));
  let usable = 0;

  if (report.platform !== "darwin") {
    checks.push(check("info", "iOS simulator: requires a macOS host"));
  } else {
    const xcrun = dep("xcrun");
    if (xcrun?.path && bundleOk(["simulator-server", "ax-service"])) {
      usable++;
      checks.push(check("ok", "iOS simulator", { detail: `xcrun at ${xcrun.path}` }));
    } else if (!xcrun?.path) {
      checks.push(
        check("info", "iOS simulator: Xcode command-line tools not found", { fix: xcrun?.hint })
      );
    }

    const signing = report.signing;
    if (signing?.teamIdEnv) {
      checks.push(
        check("ok", `Physical iPhone: signing team ${signing.teamIdEnv} (ARGENT_IOS_TEAM_ID)`)
      );
    } else if (signing && signing.detectedTeams > 0) {
      checks.push(
        check("ok", `Physical iPhone: ${signing.detectedTeams} signing team(s) in keychain`)
      );
    } else {
      checks.push(
        check("info", "Physical iPhone: no Apple Development certificate in the keychain", {
          fix: "Sign in under Xcode > Settings > Accounts, or set ARGENT_IOS_TEAM_ID",
        })
      );
    }
  }

  const adb = dep("adb");
  const emulator = dep("emulator");
  if (adb?.path) {
    usable++;
    checks.push(check("ok", "Android", { detail: `adb at ${adb.path}` }));
    if (!emulator?.path) {
      checks.push(
        check("info", "Android emulator binary not found (can't boot AVDs)", {
          fix: emulator?.hint,
        })
      );
    }
  } else {
    checks.push(check("info", "Android: adb not found", { fix: adb?.hint }));
  }

  const vega = dep("vega");
  if (vega?.path) {
    usable++;
    checks.push(check("ok", "Vega (Fire TV)", { detail: `vega at ${vega.path}` }));
  } else {
    checks.push(check("info", "Vega (Fire TV): vega CLI not found", { fix: vega?.hint }));
  }

  const extraPorts = process.env.ARGENT_CHROMIUM_PORTS?.trim();
  checks.push(
    check("info", `Chromium: probes CDP port 9222${extraPorts ? `, ${extraPorts}` : ""}`, {
      detail: "launch with --remote-debugging-port, or set ARGENT_CHROMIUM_PORTS",
    })
  );

  if (usable === 0) {
    checks.unshift(
      check("error", "No mobile platform toolchain found: argent can't list or boot devices", {
        fix: "Install Xcode (iOS) or Android platform-tools (see the lines below)",
      })
    );
  }
  return checks;
}

async function platformsSection(paths?: ToolsServerPaths): Promise<DoctorSection> {
  if (!paths) {
    return { title: "Platforms", checks: [check("info", "Skipped (no bundled tool-server)")] };
  }
  const report = await probeHostDeps(paths);
  if (typeof report === "string") {
    return {
      title: "Platforms",
      checks: [
        check("error", "Could not run the bundled tool-server's dependency check", {
          detail: report,
          fix: "Reinstall argent (argent update)",
        }),
      ],
    };
  }
  return { title: "Platforms", checks: platformChecks(report) };
}

// MARK: Other

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(`${NPM_REGISTRY}/${PACKAGE_NAME}/latest`, {
      signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  }
}

async function otherSection(
  projectRoot: string,
  running: string,
  offline: boolean
): Promise<DoctorSection> {
  const checks: DoctorCheck[] = [];
  const consent = getConsentState(process.env, projectRoot);
  const source = consent.source.detail ?? consent.source.source;
  checks.push(
    check("info", `Telemetry ${consent.enabled ? "enabled" : "disabled"} (${source})`, {
      detail: consent.enabled ? "argent telemetry disable to opt out" : undefined,
    })
  );

  if (offline) {
    checks.push(check("info", "Update check skipped (--offline)"));
  } else {
    const latest = await fetchLatestVersion();
    if (!latest) {
      checks.push(check("info", "Update check skipped (npm registry unreachable)"));
    } else if (isNewerVersion(latest, running)) {
      checks.push(
        check("warn", `Update available: v${running} → v${latest}`, { fix: "argent update" })
      );
    } else {
      checks.push(check("ok", `Up to date (latest v${latest})`));
    }
  }
  return { title: "Other", checks };
}

// MARK: Report

/**
 * PATH as an editor sees it. `npx argent doctor` and npm scripts prepend the
 * project's `node_modules/.bin`, which would make the project-local copy pass
 * for a global install (and a bare `argent mcp` entry look startable). Editors
 * spawn MCP servers without those dirs, so the probes must not see them either.
 */
export function stripPackageBinDirs(pathValue: string): string {
  return pathValue
    .split(path.delimiter)
    .filter((dir) => !/[\\/]node_modules[\\/]\.bin[\\/]?$/.test(dir))
    .join(path.delimiter);
}

async function collectDoctorReport(options: {
  paths?: ToolsServerPaths;
  offline: boolean;
  cwd?: string;
}): Promise<DoctorReport> {
  const projectRoot = resolveProjectRoot(options.cwd ?? process.cwd());
  // The global-install probe shells out to `which` with process.env.
  if (process.env.PATH) process.env.PATH = stripPackageBinDirs(process.env.PATH);
  const running = options.paths?.version ?? getInstalledVersion() ?? "unknown";

  // Sections that touch the network or spawn a process run concurrently.
  const [toolServer, platforms, other] = await Promise.all([
    toolServerSection(running, options.paths),
    platformsSection(options.paths),
    otherSection(projectRoot, running, options.offline),
  ]);
  const sections = [
    installSection(projectRoot, running, options.paths),
    editorsSection(projectRoot),
    skillsSection(projectRoot),
    toolServer,
    platforms,
    other,
  ];
  const all = sections.flatMap((s) => s.checks);
  return {
    version: running,
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`,
    projectRoot,
    sections,
    errors: all.filter((c) => c.status === "error").length,
    warnings: all.filter((c) => c.status === "warn").length,
  };
}

const MARKS: Record<CheckStatus, string> = {
  ok: pc.green("✓"),
  warn: pc.yellow("!"),
  error: pc.red("✗"),
  info: pc.dim("·"),
};

export function renderDoctorReport(report: DoctorReport): string {
  const lines: string[] = [
    `${pc.bold("argent doctor")}  v${report.version} · node v${report.node} · ${report.platform}`,
    pc.dim(`project: ${home(report.projectRoot)}`),
  ];
  for (const section of report.sections) {
    if (section.checks.length === 0) continue;
    lines.push("", pc.bold(section.title));
    for (const c of section.checks) {
      lines.push(`  ${MARKS[c.status]} ${c.label}`);
      if (c.detail) lines.push(`      ${pc.dim(c.detail)}`);
      if (c.fix && c.status !== "ok") lines.push(`      ${pc.cyan("→")} ${c.fix}`);
    }
  }
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const summary = `${plural(report.errors, "error")}, ${plural(report.warnings, "warning")}`;
  lines.push(
    "",
    report.errors > 0
      ? pc.red(summary)
      : report.warnings > 0
        ? pc.yellow(summary)
        : pc.green(summary)
  );
  return lines.join("\n");
}

const HELP = `Usage: argent doctor [options]

Check that argent is installed and wired up correctly: install topology, editor
MCP entries, skills and rules, the tool-server, and per-platform device
toolchains (Xcode, Android SDK, Vega). Read-only: it prints the command that
fixes each problem but changes nothing.

Options:
  --json       Print the report as JSON
  --offline    Skip the npm registry update check
  -h, --help   Show this help

Exits 1 when any check fails (✗); warnings (!) don't affect the exit code.`;

export async function doctor(
  argv: string[],
  options: { paths?: ToolsServerPaths } = {}
): Promise<void> {
  const known = new Set(["--json", "--offline", "--help", "-h"]);
  const unknown = argv.filter((a) => !known.has(a));
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return;
  }
  if (unknown.length > 0) {
    console.error(`Unknown option: ${unknown[0]}\n\n${HELP}`);
    process.exitCode = 1;
    return;
  }

  const report = await collectDoctorReport({
    paths: options.paths,
    offline: argv.includes("--offline"),
  });
  console.log(
    argv.includes("--json") ? JSON.stringify(report, null, 2) : renderDoctorReport(report)
  );
  if (report.errors > 0) process.exitCode = 1;
}
