import { describe, it, expect } from "vitest";
import { summarizeRequests } from "../src/tools/native-devtools/native-network-logs";

describe("native-network-logs request summary", () => {
  it("folds CDP events into one row per request", () => {
    const ev = (method: string, params: Record<string, unknown>) => ({
      method,
      params,
      timestamp: 0,
    });
    const rows = summarizeRequests([
      ev("Network.requestWillBeSent", {
        requestId: "1",
        timestamp: 10,
        request: { method: "POST", url: "http://x/rpc/feed" },
      }),
      ev("Network.responseReceived", {
        requestId: "1",
        response: { status: 200, mimeType: "application/json" },
      }),
      ...Array.from({ length: 50 }, () =>
        ev("Network.dataReceived", { requestId: "1", dataLength: 1000 })
      ),
      ev("Network.loadingFinished", { requestId: "1", timestamp: 10.25, encodedDataLength: 50000 }),
      ev("Network.requestWillBeSent", {
        requestId: "2",
        timestamp: 11,
        request: { method: "GET", url: "http://x/down" },
      }),
      ev("Network.loadingFailed", { requestId: "2", errorText: "offline" }),
    ]);
    expect(rows).toEqual([
      {
        requestId: "1",
        method: "POST",
        url: "http://x/rpc/feed",
        status: 200,
        mimeType: "application/json",
        bytes: 50000,
        durationMs: 250,
      },
      { requestId: "2", method: "GET", url: "http://x/down", error: "offline" },
    ]);
  });
});
