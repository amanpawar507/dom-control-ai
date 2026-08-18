/**
 * The session token this target issues, and every representation it takes.
 *
 * Spec §2 notes the URL path-parameter form (`about.htm;jsessionid=…`), which
 * ParaBank emits in hrefs *before* the session cookie round-trips. That form was
 * the only one covered originally — and it is the one form an authenticated
 * replay never produces. Once logged in, the token exists as a cookie header and
 * inside a Playwright storage state, which is precisely what
 * `ParabankSessionProvider.acquire()` returns.
 *
 * The storage-state case is the one that cannot be caught by pattern alone: the
 * token sits there as an object *value* under a cookie-name key, and nothing in
 * the string `2719279E…` marks it as a secret. Position does. So there are two
 * layers here — patterns for the token in text, and `redactDeep` for the token
 * in structure — and the redactor needs both because it sits at the log sink,
 * where every representation has to be known. (A boundary redactor would not:
 * see the Phase 2 observer.)
 */
const SESSION_COOKIE_NAMES = ["JSESSIONID"] as const;
const NAME_ALT = SESSION_COOKIE_NAMES.join("|");

/** `…/about.htm;jsessionid=VALUE` — the pre-cookie URL form. */
const URL_FORM = /;jsessionid=[A-Za-z0-9]+/gi;

/**
 * `Set-Cookie: JSESSIONID=VALUE`, `Cookie: JSESSIONID=VALUE`, and the loose
 * `"JSESSIONID": "VALUE"` a hand-built log line produces. The optional quotes
 * are what make the last of those reachable.
 */
const ASSIGNMENT_FORM = new RegExp(`\\b(${NAME_ALT})\\b("?\\s*[:=]\\s*"?)([A-Za-z0-9]+)`, "gi");

/**
 * A serialized cookie record: `{"name":"JSESSIONID","value":"VALUE",…}`. Matched
 * as a whole flat object so key order does not matter — a storage state that has
 * been through `JSON.stringify` before being logged is still a string, and the
 * structural pass below never sees it.
 */
const JSON_RECORD = new RegExp(`\\{[^{}]*"name"\\s*:\\s*"(?:${NAME_ALT})"[^{}]*\\}`, "gi");
const JSON_RECORD_VALUE = /"value"\s*:\s*"[^"]*"/i;

const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;

function isSessionCookieName(name: unknown): boolean {
  return (
    typeof name === "string" &&
    SESSION_COOKIE_NAMES.some((n) => n.toLowerCase() === name.trim().toLowerCase())
  );
}

export function redactUrl(url: string): string {
  return url.replace(URL_FORM, ";jsessionid=<redacted>");
}

/**
 * Removes the token rather than marking it — a sink-facing `<redacted>`
 * marker is not an address, and `observe()` (`src/observe/snapshot.ts`) needs
 * one: the model may legitimately be told to navigate back to the page it is
 * looking at. ParaBank (and Java servlet containers generally) treat
 * `;jsessionid=…` as a fallback for a client that cannot hold a cookie; once
 * the cookie round-trips, the parameter is surplus and dropping it changes
 * nothing about which page loads (confirmed against the running instance:
 * `overview.htm` and `overview.htm;jsessionid=…` return the same 200 with the
 * session cookie set either way).
 *
 * This is perception's redaction, not the sink's, which is why it lives next
 * to `redactUrl` rather than inside `observe/snapshot.ts`: both functions
 * need to agree on exactly what a session token in a URL looks like, and
 * `URL_FORM` is the one place that shape is written down.
 */
export function stripSessionToken(url: string): string {
  return url.replace(URL_FORM, "");
}

/**
 * Every textual form, in one pass. The cookie *name* is deliberately preserved
 * in each replacement: evidence that a session cookie was set is not itself
 * sensitive, and a redacted line that no longer reads as a cookie has lost the
 * information an operator needs.
 */
export function redactText(text: string): string {
  return text
    .replace(URL_FORM, ";jsessionid=<redacted>")
    .replace(JSON_RECORD, (record) => record.replace(JSON_RECORD_VALUE, '"value":"<redacted>"'))
    .replace(ASSIGNMENT_FORM, (_whole, name: string, sep: string) => `${name}${sep}<redacted>`)
    .replace(SSN, "<redacted:ssn>");
}

/**
 * Deep scrub for anything on its way into an evidence file.
 *
 * Strings go through the patterns above. Objects are walked — and a cookie
 * record has its `value` replaced on the strength of its sibling `name`, which
 * is the only thing that identifies the token when it arrives as structure
 * rather than as text. Storage state and localStorage entries share that
 * `{name, value}` shape, so both are covered by the same rule.
 *
 * The record keeps its shape: only the value is replaced, so the evidence still
 * shows that a session existed and which cookie carried it.
 */
export function redactDeep(value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    return key === "url" ? redactText(redactUrl(value)) : redactText(value);
  }
  if (Array.isArray(value)) return value.map((v) => redactDeep(v));
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    const sessionRecord = entries.some(([k, v]) => k === "name" && isSessionCookieName(v));
    return Object.fromEntries(
      entries.map(([k, v]) => [
        k,
        sessionRecord && k === "value" ? "<redacted>" : redactDeep(v, k),
      ]),
    );
  }
  return value;
}

export function redactValue(
  controlName: string | null,
  value: string,
  sensitive: readonly string[],
): string {
  if (controlName !== null && sensitive.includes(controlName)) {
    return `<redacted:${controlName}>`;
  }
  return redactText(value);
}
