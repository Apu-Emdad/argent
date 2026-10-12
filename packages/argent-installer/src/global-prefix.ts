import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import pc from "picocolors";
import { PACKAGE_NAME } from "./constants.js";
import type { PackageManager } from "./package-manager.js";

// npm derives its global prefix from the node binary's location, so under Nix
// it lands inside the read-only store and `npm install -g` dies with EACCES.

const GLOBAL_DIR_QUERY: Record<PackageManager, readonly string[]> = {
  npm: ["root", "-g"],
  pnpm: ["root", "-g"],
  yarn: ["global", "dir"],
  bun: ["pm", "bin", "-g"],
};

const QUERY_TIMEOUT_MS = 5_000;

function queryGlobalInstallDir(pm: PackageManager): string | null {
  let stdout: string;
  try {
    stdout = execFileSync(pm, [...GLOBAL_DIR_QUERY[pm]], {
      encoding: "utf8",
      timeout: QUERY_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
  const line = String(stdout)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  if (line === undefined || !path.isAbsolute(line)) return null;
  // npm prints UUID-shaped segments as `***`; probing the ancestor of a path
  // that does not exist would judge the wrong directory.
  return line.includes("***") ? null : line;
}

/** True when `target` is inside the Nix store (`NIX_STORE_DIR`, default /nix/store). */
export function isNixStorePath(target: string): boolean {
  const storeDir = path.resolve(process.env.NIX_STORE_DIR || "/nix/store");
  const resolved = path.resolve(target);
  return resolved === storeDir || resolved.startsWith(storeDir + path.sep);
}

function nearestExistingDir(dir: string): string | null {
  let current = path.resolve(dir);
  for (;;) {
    try {
      if (fs.statSync(current).isDirectory()) return current;
    } catch {
      // Missing or unstattable — keep walking up.
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

interface GlobalInstallTarget {
  /** Existing directory the global install has to write into. */
  dir: string;
  blocked: boolean;
  nixStore: boolean;
}

// Only errnos that prove the directory cannot be written block an install.
const BLOCKING_ERRNOS = new Set(["EACCES", "EPERM", "EROFS"]);

/**
 * Where a global install by `pm` would write, and whether this user can.
 * `installedPackageRoot` is the fallback when the manager's query fails.
 * Anything inconclusive returns null: wrongly refusing an install that would
 * work is worse than the failure being prevented.
 */
export function probeGlobalInstallTarget(
  pm: PackageManager,
  installedPackageRoot: string | null = null
): GlobalInstallTarget | null {
  // Windows access(W_OK) reflects only the read-only attribute, not ACLs.
  if (process.platform === "win32") return null;

  // npm renames inside the package's parent, so a root-owned `@swmansion`
  // left by an earlier `sudo npm i -g` blocks it under a writable root.
  const queried = queryGlobalInstallDir(pm);
  const packagePath = queried ? path.join(queried, PACKAGE_NAME) : installedPackageRoot;
  if (packagePath === null) return null;
  const dir = nearestExistingDir(path.dirname(packagePath));
  if (dir === null) return null;

  const describe = (blocked: boolean): GlobalInstallTarget => ({
    dir,
    blocked,
    nixStore: isNixStorePath(dir),
  });
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code !== undefined && BLOCKING_ERRNOS.has(code) ? describe(true) : null;
  }
  return describe(false);
}

/**
 * The cause of a blocked global install or update, and the ways out.
 * `localInit` is the per-project command as the user can run it from here.
 */
export function unwritableGlobalTargetMessage(
  target: GlobalInstallTarget,
  pm: PackageManager,
  verb: "install" | "update",
  localInit = "argent init --local"
): string {
  const cause = target.nixStore
    ? "its global package directory is inside the read-only Nix store"
    : "its global package directory is not writable by this user";
  const note = target.nixStore
    ? `Nix store paths are meant to be immutable — do not install into them with ${pc.cyan("sudo")}.`
    : "Nothing was installed or changed.";

  const remedies: string[] = [
    pm === "npm"
      ? `  Point npm at a writable prefix, then retry:\n` +
        `    ${pc.cyan('npm config set prefix "$HOME/.npm-global"')}\n` +
        `    ${pc.cyan('export PATH="$HOME/.npm-global/bin:$PATH"')}  ${pc.dim("(add to your shell profile)")}`
      : `  Point ${pc.cyan(pm)} at a global directory you can write to, then retry.`,
    `  Or use ${PACKAGE_NAME} per project instead — no global directory needed:\n` +
      `    ${pc.cyan(localInit)}`,
  ];

  return (
    `${pc.cyan(pm)} cannot ${verb} ${PACKAGE_NAME} globally: ${cause}.\n` +
    `  ${pc.dim(target.dir)}\n` +
    `${note}\n\n` +
    remedies.join("\n\n")
  );
}
