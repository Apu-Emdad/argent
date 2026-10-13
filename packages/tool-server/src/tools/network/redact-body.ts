const REDACTED = "[REDACTED]";

/** One-time codes (`code`, `otp`) are deliberately not masked. */
const SENSITIVE_FIELD = /password|passwd|passphrase|pwd$|secret|token|apikey|credential|privatekey/;
const SENSITIVE_FIELD_EXACT = new Set(["pass", "key"]);

function isSensitiveField(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SENSITIVE_FIELD.test(normalized) || SENSITIVE_FIELD_EXACT.has(normalized);
}

function stringEnd(s: string, start: number): number {
  let i = start + 1;
  while (i < s.length) {
    if (s[i] === "\\") i += 2;
    else if (s[i] === '"') return i + 1;
    else i++;
  }
  return s.length;
}

function valueEnd(s: string, start: number): number {
  const c = s[start];
  if (c === '"') return stringEnd(s, start);
  if (c === "{" || c === "[") {
    let depth = 0;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"') i = stringEnd(s, i) - 1;
      else if (ch === "{" || ch === "[") depth++;
      else if ((ch === "}" || ch === "]") && --depth === 0) return i + 1;
    }
    return s.length;
  }
  let i = start;
  while (i < s.length && !/[\s,\]}]/.test(s[i]!)) i++;
  return i;
}

function skipSpace(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i]!)) i++;
  return i;
}

/** Masks values in place, so the rest of the body keeps the exact text the app sent. */
function redactJson(body: string): string {
  let out = "";
  let copied = 0;
  let i = 0;
  while (i < body.length) {
    if (body[i] !== '"') {
      i++;
      continue;
    }
    const keyEnd = stringEnd(body, i);
    const colon = skipSpace(body, keyEnd);
    if (body[colon] !== ":" || !isSensitiveField(JSON.parse(body.slice(i, keyEnd)) as string)) {
      i = keyEnd;
      continue;
    }
    const start = skipSpace(body, colon + 1);
    const end = valueEnd(body, start);
    const value = body.slice(start, end);
    if (value !== '""' && value !== "null") {
      out += `${body.slice(copied, start)}"${REDACTED}"`;
      copied = end;
    }
    i = end;
  }
  return out + body.slice(copied);
}

function decodeFormKey(key: string): string {
  try {
    return decodeURIComponent(key.replace(/\+/g, " "));
  } catch {
    return key;
  }
}

function redactPairs(s: string): string {
  return s
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq < 1 || eq === pair.length - 1) return pair;
      const key = pair.slice(0, eq);
      return isSensitiveField(decodeFormKey(key)) ? `${key}=${REDACTED}` : pair;
    })
    .join("&");
}

const MULTIPART_PART =
  /(Content-Disposition:[^\r\n]*\bname="([^"]*)"[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n)([\s\S]*?)(?=\r?\n--)/gi;

function redactMultipart(body: string): string {
  return body.replace(MULTIPART_PART, (part, head: string, name: string, value: string) =>
    value && !/filename=/i.test(head) && isSensitiveField(name) ? head + REDACTED : part
  );
}

/**
 * Replaces the values of credential fields (password, token, api key, ...) in a
 * JSON, multipart or URL-encoded request body with `[REDACTED]`.
 */
export function redactBody(body: string | undefined): string | undefined {
  if (!body) return body;
  let isJson = true;
  try {
    JSON.parse(body);
  } catch {
    isJson = false;
  }
  if (isJson) return redactJson(body);
  if (/Content-Disposition:\s*form-data/i.test(body)) return redactMultipart(body);
  return redactPairs(body);
}

export function redactUrl(url: string): string {
  const query = url.indexOf("?");
  if (query < 0) return url;
  const hash = url.indexOf("#", query);
  const end = hash < 0 ? url.length : hash;
  return url.slice(0, query + 1) + redactPairs(url.slice(query + 1, end)) + url.slice(end);
}
