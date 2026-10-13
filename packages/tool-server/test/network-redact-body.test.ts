import { describe, it, expect } from "vitest";
import { redactBody, redactUrl } from "../src/tools/network/redact-body";

describe("redactBody (JSON)", () => {
  it("masks password-like fields but keeps keys and other values", () => {
    const out = JSON.parse(
      redactBody(
        JSON.stringify({
          email: "dev@example.com",
          password: "hunter2",
          nested: { refresh_token: "r", token: "t" },
          list: [{ apiKey: "k" }],
        })
      )!
    );
    expect(out).toEqual({
      email: "dev@example.com",
      password: "[REDACTED]",
      nested: { refresh_token: "[REDACTED]", token: "[REDACTED]" },
      list: [{ apiKey: "[REDACTED]" }],
    });
  });

  it("masks related field names, not only exact ones", () => {
    const out = JSON.parse(
      redactBody(
        JSON.stringify({
          "password_confirmation": "a",
          "confirmPassword": "b",
          "oldPassword": "c",
          "sessionToken": "d",
          "Api-Key": "e",
          "x-api-key": "f",
          "clientSecret": "g",
          "pwd": "h",
          "username": "keep",
          "monkey": "keep",
          "passenger": "keep",
          "grant_type": "password",
        })
      )!
    ) as Record<string, string>;
    for (const k of [
      "password_confirmation",
      "confirmPassword",
      "oldPassword",
      "sessionToken",
      "Api-Key",
      "x-api-key",
      "clientSecret",
      "pwd",
    ]) {
      expect(out[k]).toBe("[REDACTED]");
    }
    expect(out.username).toBe("keep");
    expect(out.monkey).toBe("keep");
    expect(out.passenger).toBe("keep");
    expect(out.grant_type).toBe("password");
  });

  it("keeps one-time codes visible", () => {
    expect(redactBody('{"code":"111111","otp":"222222"}')).toBe('{"code":"111111","otp":"222222"}');
  });

  it("returns a body without secrets byte for byte", () => {
    const body = '{"orderId": 1234567890123456789, "amount": 1.10, "b":1, "2":2, "n": 1e2}';
    expect(redactBody(body)).toBe(body);
  });

  it("changes only the secret value when one is present", () => {
    expect(redactBody('{"orderId": 1234567890123456789, "password" : "x\\"y", "a":1}')).toBe(
      '{"orderId": 1234567890123456789, "password" : "[REDACTED]", "a":1}'
    );
  });

  it("masks a secret whose value is an array or an object", () => {
    expect(redactBody('{"api_key":["k1","k2"],"password":{"value":"o"},"x":1}')).toBe(
      '{"api_key":"[REDACTED]","password":"[REDACTED]","x":1}'
    );
  });

  it("masks number values and keeps empty and null values visible", () => {
    expect(redactBody('{"password":123}')).toBe('{"password":"[REDACTED]"}');
    expect(redactBody('{"username":"a","password":""}')).toBe('{"username":"a","password":""}');
    expect(redactBody('{"password":null}')).toBe('{"password":null}');
  });

  it("does not treat string values as keys", () => {
    expect(redactBody('["password", "token"]')).toBe('["password", "token"]');
    expect(redactBody('{"field":"password","value":"v"}')).toBe('{"field":"password","value":"v"}');
  });
});

describe("redactBody (form)", () => {
  it("masks form-encoded fields", () => {
    expect(redactBody("grant_type=password&username=a&password=secret")).toBe(
      "grant_type=password&username=a&password=[REDACTED]"
    );
  });

  it("masks bracketed and short field names", () => {
    expect(
      redactBody("log=admin&pwd=wp&user%5Bpassword%5D=rails&user[password_confirmation]=c")
    ).toBe(
      "log=admin&pwd=[REDACTED]&user%5Bpassword%5D=[REDACTED]&user[password_confirmation]=[REDACTED]"
    );
  });

  it("masks bodies with a trailing & or a key with spaces", () => {
    expect(redactBody("username=a&password=x&")).toBe("username=a&password=[REDACTED]&");
    expect(redactBody("a b&password=x")).toBe("a b&password=[REDACTED]");
  });

  it("does not throw on a malformed escape", () => {
    expect(redactBody("q%=1&password=x")).toBe("q%=1&password=[REDACTED]");
    expect(redactBody("%E0%A4%A=1&x=2")).toBe("%E0%A4%A=1&x=2");
  });

  it("keeps an empty value visible", () => {
    expect(redactBody("username=a&password=")).toBe("username=a&password=");
  });

  it("leaves plain text alone", () => {
    expect(redactBody("hello world")).toBe("hello world");
  });
});

describe("redactBody (multipart)", () => {
  const part = (name: string, value: string, extra = "") =>
    `------B\r\nContent-Disposition: form-data; name="${name}"${extra}\r\n\r\n${value}\r\n`;

  it("masks credential parts and keeps the others", () => {
    const body = part("username", "dev") + part("password", "hunter2") + "------B--\r\n";
    expect(redactBody(body)).toBe(
      part("username", "dev") + part("password", "[REDACTED]") + "------B--\r\n"
    );
  });

  it("keeps file parts whose field name matches", () => {
    const body = part("token", "file-bytes", '; filename="t.txt"') + "------B--\r\n";
    expect(redactBody(body)).toBe(body);
  });
});

describe("redactUrl", () => {
  it("masks credential query parameters", () => {
    expect(redactUrl("https://x.test/v1/data?key=AIzaSECRET&access_token=tok&page=2#frag")).toBe(
      "https://x.test/v1/data?key=[REDACTED]&access_token=[REDACTED]&page=2#frag"
    );
  });

  it("keeps a URL without a query unchanged", () => {
    expect(redactUrl("https://x.test/a/token")).toBe("https://x.test/a/token");
  });
});
