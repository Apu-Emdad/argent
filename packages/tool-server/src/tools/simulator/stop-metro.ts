import { z } from "zod";
import { execFileSync } from "node:child_process";
import type { ToolDefinition } from "@argent/registry";

/**
 * Deduped PIDs *listening* on `port`, parsed out of `netstat -ano` (Windows).
 * Split out of `listeningPids` so the win32 row matching can be unit-tested
 * off Windows.
 *
 * A listener is identified by its wildcard foreign endpoint (`0.0.0.0:0` /
 * `[::]:0` / `*:*`), never by the State column, which Windows localizes
 * (German "ABHÖREN"). A connection in any other state has a real remote
 * endpoint there, so this also keeps the tool-server's own CDP client socket
 * to Metro out of the result. One listener can report the same PID on an IPv4
 * and an IPv6 row, hence the dedupe.
 */
export function parseNetstatListeningPids(netstatOutput: string, port: number): number[] {
  const pids = new Set<number>();
  for (const line of netstatOutput.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    // cols: [proto, localAddr, foreignAddr, state, pid]
    if (cols.length < 5 || cols[0].toUpperCase() !== "TCP") continue;
    // The colon guards against `:18081` matching port 8081.
    if (!cols[1].endsWith(`:${port}`)) continue;
    // Wildcard foreign endpoint, not the localized State text.
    const foreign = cols[2];
    if (foreign !== "*:*" && !foreign.endsWith(":0")) continue;
    // From the end, not a fixed index: a localized State can span several
    // whitespace-split tokens (French "À L'ÉCOUTE") and shift the column.
    const pid = parseInt(cols[cols.length - 1], 10);
    if (!Number.isNaN(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

/**
 * PIDs *listening* on a TCP port, cross-platform. Only the listener (Metro) is
 * returned, never a process holding an ESTABLISHED connection to the port —
 * that would match the tool-server's own CDP client socket to Metro.
 *
 * `lsof` exits non-zero when the port is free, and does not exist on Windows,
 * which parses `netstat -ano` instead. Neither runs through a shell, so `port`
 * can never be read as a shell token.
 */
function listeningPids(port: number): number[] {
  if (process.platform === "win32") {
    const output = execFileSync("netstat", ["-ano"], {
      encoding: "utf-8",
      timeout: 5_000,
      // `netstat -ano` dumps every socket on the host; Node's default 1 MiB
      // can overflow and fail the probe.
      maxBuffer: 16 * 1024 * 1024,
    });
    return parseNetstatListeningPids(output, port);
  }
  const output = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf-8",
    timeout: 5_000,
  }).trim();
  if (!output) return [];
  const lines = output.split("\n").map((s) => s.trim());
  // BusyBox lsof (Alpine) ignores its arguments and lists every open file.
  if (!lines.every((s) => /^\d+$/.test(s))) {
    throw new Error(`lsof did not print a PID list: ${lines[0]}`);
  }
  return lines.map((s) => parseInt(s, 10));
}

const zodSchema = z.object({
  port: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(8081)
    .describe("TCP port Metro is listening on (default 8081)"),
});

export const stopMetroTool: ToolDefinition<
  { port: number },
  { stopped: boolean; port: number; pids: number[] }
> = {
  id: "stop-metro",
  interaction: {
    startedMsg: ({ params }) => `Stopping Metro on port ${params.port}`,
    completedMsg: ({ params }) => `Stopped Metro on port ${params.port}`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to stop Metro on port ${params.port}: ${failureSignal.error_code}`,
  },
  description: `Stop the Metro bundler process listening on a given port (default 8081). Use when ending a React Native session or when Metro must be restarted. Returns { stopped, port, pids }; stopped=false if no process is found on the port. Fails if the port lookup cannot run, times out, or prints something other than PIDs. This is DESTRUCTIVE: always ask the user for confirmation before calling this tool.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    const port = (params as { port: number }).port;
    try {
      const pids = listeningPids(port);

      if (pids.length === 0) {
        return { stopped: false, port, pids: [] };
      }

      for (const pid of pids) {
        try {
          // Windows ignores the signal and terminates outright; on POSIX
          // SIGTERM lets Metro shut down cleanly.
          process.kill(pid, "SIGTERM");
        } catch {
          // Process may have already exited
        }
      }

      return { stopped: true, port, pids };
    } catch (error) {
      // Only lsof's non-zero exit means "nothing is listening"; anything else never read the port.
      if (typeof (error as { status?: unknown }).status === "number") {
        return { stopped: false, port, pids: [] };
      }
      throw new Error(
        `Could not determine what is listening on port ${port}: ${(error as Error).message}`,
        { cause: error }
      );
    }
  },
};
