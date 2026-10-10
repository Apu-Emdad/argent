import { describe, it, expect } from "vitest";
import { CDPClient } from "../../src/utils/debugger/cdp-client";

/**
 * evaluateAwaited without a socket: `send` is stubbed with a tiny fake runtime
 * that mimics Hermes — a Promise result comes back as an object handle (RN's
 * polyfill, no subtype), and settle callbacks park the outcome on a slot that
 * `evaluate` then polls.
 */
function fakeRuntime(
  outcome: { kind: "value"; v: unknown } | { kind: "promise"; v?: unknown; err?: string }
) {
  const client = new CDPClient("ws://localhost:1");
  const calls: string[] = [];
  let slotValue: unknown;
  (client as any).send = async (method: string, params: any) => {
    calls.push(method);
    if (method === "Runtime.evaluate" && params.returnByValue === false) {
      if (outcome.kind === "value" && (typeof outcome.v !== "object" || outcome.v === null)) {
        return { result: { type: typeof outcome.v, value: outcome.v } };
      }
      return { result: { type: "object", className: "Object", objectId: "obj-1" } };
    }
    if (method === "Runtime.callFunctionOn") {
      if (outcome.kind === "value") return { result: { value: { v: outcome.v } } };
      slotValue = outcome.err !== undefined ? { s: 2, e: outcome.err } : { s: 1, v: outcome.v };
      return { result: { value: { pending: true } } };
    }
    if (method === "Runtime.evaluate") return { result: { value: slotValue } };
    throw new Error(`unexpected ${method}`);
  };
  return { client, calls };
}

describe("CDPClient.evaluateAwaited", () => {
  it("returns a primitive directly, in one round-trip", async () => {
    const { client, calls } = fakeRuntime({ kind: "value", v: 2 });
    expect(await client.evaluateAwaited("1+1")).toBe(2);
    expect(calls).toEqual(["Runtime.evaluate"]);
  });

  it("serializes a plain object from its handle", async () => {
    const { client } = fakeRuntime({ kind: "value", v: { a: 1, b: [2, 3] } });
    expect(await client.evaluateAwaited("({a:1,b:[2,3]})")).toEqual({ a: 1, b: [2, 3] });
  });

  it("settles a polyfill Promise and returns what it resolved to", async () => {
    const { client, calls } = fakeRuntime({ kind: "promise", v: { x: 42 } });
    expect(await client.evaluateAwaited("new Promise(r => r({x:42}))")).toEqual({ x: 42 });
    // The expression itself ran once; the rest is callback install + poll.
    expect(calls.filter((c) => c === "Runtime.callFunctionOn")).toHaveLength(1);
  });

  it("surfaces a rejection as a runtime exception", async () => {
    const { client } = fakeRuntime({ kind: "promise", err: "Error: boom" });
    await expect(client.evaluateAwaited("Promise.reject(new Error('boom'))")).rejects.toThrow(
      /Promise rejected: Error: boom/
    );
  });
});
