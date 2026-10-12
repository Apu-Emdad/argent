import { z } from "zod";
import type { Registry, ToolDefinition } from "@argent/registry";
import type { LogStats, MessageCluster } from "../../utils/debugger/log-file-writer";
import { DEBUGGER_TOOL_CAPABILITY } from "./debugger-service-ref";
import { metroPortField } from "../../utils/debugger/metro-port";
import { canonicalDeviceId } from "../../utils/debugger/device-alias";
import { describeReapedSession, takeReapedSession } from "../../utils/reaped-sessions";
import {
  buildNotConnected,
  classifyNotConnected,
  resolveDebuggerService,
  trackDebuggerOutcome,
  type DebuggerNotConnectedResult,
} from "./not-connected";

interface LogRegistryResponse extends LogStats {
  status: "connected";
  clusters: MessageCluster[];
  /** The newest `tail` entries (optionally filtered by level), oldest first. */
  entries?: Array<{ id: number; timestamp: string; level: string; message: string }>;
  deviceName: string;
  appName: string;
  logicalDeviceId: string | undefined;
  /**
   * Set only when a teardown reaped the previous debugger session while it held
   * captured console output. Without it an empty registry reads as "the app
   * logged nothing".
   */
  note?: string;
}

const zodSchema = z.object({
  port: metroPortField,
  device_id: z
    .string()
    .describe(
      "Device id from list-devices — the SAME id you passed to debugger-connect (iOS simulator UDID, Android serial, Vega serial, or Chromium device id). The logicalDeviceId debugger-connect returns also resolves here, but prefer the stable list-devices id."
    ),
  tail: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe(
      "Also return the newest N entries (oldest first, messages cut at 500 chars), so you can read the logs without opening the file."
    ),
  levels: z
    .array(z.string())
    .optional()
    .describe('Only with tail: keep entries of these levels, e.g. ["warning","error"].'),
});

export function createDebuggerLogRegistryTool(
  registry: Registry
): ToolDefinition<z.infer<typeof zodSchema>, LogRegistryResponse | DebuggerNotConnectedResult> {
  return {
    id: "debugger-log-registry",
    interaction: {
      startedMsg: () => "Reading app logs",
      completedMsg: ({ result }) =>
        result.status === "connected"
          ? "Read app logs"
          : "JavaScript debugger is not connected — no logs captured",
      failedMsg: ({ failureSignal }) => `Failed to read app logs: ${failureSignal.error_code}`,
    },
    description: `Get a summary of all console logs captured from the app's JS runtime.
Returns the log file path, entry counts by level, and message clusters (grouped by similarity). Works against Hermes (iOS / Android / Vega) and V8 (Chromium).
Use when investigating warnings, errors, or unexpected output — call this first for an overview. Pass tail (and optionally levels) to get the newest entries in the result itself, since the log file may sit outside the directories you can read. Returns empty stats if no log data has been captured yet — but check { note }, which is present only when the stats are empty BECAUSE a stop-all-simulator-servers tore the previous debugger session down and deleted its log file. Absent that note, empty really does mean the app has logged nothing.
When the debugger cannot be reached, this tool does not fail: it returns { status: "not_connected", reason, detail, guidance } with NO log file — follow the guidance (do not retry in a loop, and do not try to read a log file from this state). A "connected" result's stats may come from a session whose socket has since died — use debugger-status, not this tool, to judge debugger health.`,
    zodSchema,
    capability: DEBUGGER_TOOL_CAPABILITY,
    // Resolved manually in execute so a not-connected precondition becomes a
    // structured result instead of a service-resolution tool failure.
    services: () => ({}),
    async execute(_services, params, ctx) {
      try {
        const api = await resolveDebuggerService(registry, params);
        // No socket-state gate (unlike debugger-status): captured logs are
        // readable over a dead socket, and disposing the stale service would
        // close the LogFileWriter — destroying the post-crash logs the caller
        // came for.
        const stats = api.logWriter.getStats();
        const clusters = api.logWriter.getClusters(20);

        trackDebuggerOutcome("debugger-log-registry", "connected", params, ctx);
        let entries: LogRegistryResponse["entries"];
        if (params.tail) {
          const wanted = params.levels?.map((l) => l.toLowerCase());
          entries = api.logWriter
            .readAll()
            .filter((e) => !wanted || wanted.includes(e.level.toLowerCase()))
            .slice(-params.tail)
            .map((e) => ({
              id: e.id,
              timestamp: e.timestamp,
              level: e.level,
              message: e.message.length > 500 ? `${e.message.slice(0, 500)}…` : e.message,
            }));
        }
        const response: LogRegistryResponse = {
          status: "connected" as const,
          ...stats,
          clusters,
          ...(entries ? { entries } : {}),
          deviceName: api.deviceName,
          appName: api.appName,
          logicalDeviceId: api.logicalDeviceId,
        };

        // Resolving above silently reconnects after a teardown, so only an
        // EMPTY registry is ambiguous; one with entries is this session's own
        // capture, and consuming a breadcrumb there would attach a stale
        // explanation to a healthy result.
        if (stats.totalEntries === 0) {
          // Every id this device answers to, unconditionally — not `a ?? b`. The
          // disposer writes one breadcrumb under both the connect id and the
          // `logicalDeviceId` Metro echoed; leaving either behind would explain a
          // later, unrelated empty read. `forgetDeviceAlias` ran in that same
          // dispose, so only the freshly resolved api still knows the logical id.
          const aliases = [
            canonicalDeviceId(params.device_id),
            params.device_id,
            api.logicalDeviceId,
          ].filter((id): id is string => id !== undefined);
          let reaped: ReturnType<typeof takeReapedSession>;
          for (const id of new Set(aliases)) {
            // Take from every id, keep the first hit: `reaped ??= take(...)`
            // would stop taking once one matched.
            const entry = takeReapedSession("js-runtime-debugger", id);
            reaped ??= entry;
          }
          if (reaped) response.note = describeReapedSession(reaped, "JS-runtime debugger session");
        }
        return response;
      } catch (err) {
        const reason = classifyNotConnected(err);
        if (!reason) throw err;
        trackDebuggerOutcome("debugger-log-registry", reason, params, ctx);
        return buildNotConnected(reason, err, params);
      }
    },
  };
}
