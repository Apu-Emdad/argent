import { describe, it, expect } from "vitest";
import { redactBody } from "../src/tools/network/network-request";

describe("redactBody", () => {
  it("masks password-like JSON fields but keeps keys and other values", () => {
    const out = JSON.parse(
      redactBody(
        JSON.stringify({
          email: "dev@example.com",
          password: "hunter2",
          nested: { refresh_token: "r", token: "t" },
        })
      )!
    );
    expect(out).toEqual({
      email: "dev@example.com",
      password: "[REDACTED]",
      nested: { refresh_token: "[REDACTED]", token: "[REDACTED]" },
    });
  });

  it("keeps one-time codes visible", () => {
    expect(redactBody('{"code":"111111"}')).toBe('{"code":"111111"}');
  });

  it("masks form-encoded fields", () => {
    expect(redactBody("grant_type=password&username=a&password=secret")).toBe(
      "grant_type=password&username=a&password=[REDACTED]"
    );
  });

  it("leaves non-JSON, non-form bodies alone", () => {
    expect(redactBody("hello world")).toBe("hello world");
  });
});
