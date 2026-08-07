/**
 * Internal service-to-service authentication for the model-file download boundary.
 *
 * Proves the credential contract used by GET /api/model/versions/:id/download to let
 * the Python IFC-extraction service authenticate without a browser session:
 *  - a valid token authorizes; missing/empty/incorrect/unconfigured never do;
 *  - the comparison is constant-time and never throws on unequal lengths;
 *  - the token is never logged or embedded in an error message.
 * Pure module: no database, no HTTP — the environment is injected explicitly.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  configuredInternalServiceToken,
  hasValidInternalServiceToken,
  timingSafeEqualStrings,
  INTERNAL_SERVICE_TOKEN_HEADER,
  INTERNAL_SERVICE_TOKEN_ENV,
} from "../../applicationIdentity/internalServiceAuth.ts";

const TOKEN = "test-only-internal-token-9f2c8ab41d";
const reqWith = (headerValue?: string | string[]) =>
  ({ headers: headerValue === undefined ? {} : { [INTERNAL_SERVICE_TOKEN_HEADER]: headerValue } }) as any;

/* -------------------------------- configuration ------------------------------ */

test("configuredInternalServiceToken: missing variable → null (deterministic, no throw)", () => {
  assert.equal(configuredInternalServiceToken({} as any), null);
});

test("configuredInternalServiceToken: empty / whitespace-only value → null (never authorizes)", () => {
  assert.equal(configuredInternalServiceToken({ [INTERNAL_SERVICE_TOKEN_ENV]: "" } as any), null);
  assert.equal(configuredInternalServiceToken({ [INTERNAL_SERVICE_TOKEN_ENV]: "   " } as any), null);
});

test("configuredInternalServiceToken: a real value is returned trimmed", () => {
  assert.equal(configuredInternalServiceToken({ [INTERNAL_SERVICE_TOKEN_ENV]: `  ${TOKEN}  ` } as any), TOKEN);
});

/* ------------------------------ timing-safe compare -------------------------- */

test("timingSafeEqualStrings: equal strings match; different strings do not", () => {
  assert.equal(timingSafeEqualStrings(TOKEN, TOKEN), true);
  assert.equal(timingSafeEqualStrings(TOKEN, `${TOKEN}x`), false);
  assert.equal(timingSafeEqualStrings("abc", "abd"), false);
});

test("timingSafeEqualStrings: unequal lengths return false WITHOUT throwing", () => {
  assert.doesNotThrow(() => timingSafeEqualStrings("a", "abcdefghij"));
  assert.equal(timingSafeEqualStrings("a", "abcdefghij"), false);
  assert.equal(timingSafeEqualStrings("", TOKEN), false);
  assert.equal(timingSafeEqualStrings("", ""), true);
});

/* ---------------------------- request authorization -------------------------- */

test("hasValidInternalServiceToken: correct token in the dedicated header → authorized", () => {
  const env = { [INTERNAL_SERVICE_TOKEN_ENV]: TOKEN } as any;
  assert.equal(hasValidInternalServiceToken(reqWith(TOKEN), env), true);
  // an array-valued header (proxies) still resolves its first value
  assert.equal(hasValidInternalServiceToken(reqWith([TOKEN]), env), true);
});

test("hasValidInternalServiceToken: incorrect / missing / empty header → rejected", () => {
  const env = { [INTERNAL_SERVICE_TOKEN_ENV]: TOKEN } as any;
  assert.equal(hasValidInternalServiceToken(reqWith("wrong-token"), env), false);
  assert.equal(hasValidInternalServiceToken(reqWith(undefined), env), false);
  assert.equal(hasValidInternalServiceToken(reqWith("   "), env), false);
});

test("hasValidInternalServiceToken: unconfigured token never authorizes, even with a header present", () => {
  assert.equal(hasValidInternalServiceToken(reqWith(TOKEN), {} as any), false);
  assert.equal(hasValidInternalServiceToken(reqWith(TOKEN), { [INTERNAL_SERVICE_TOKEN_ENV]: "" } as any), false);
});

/* ------------------------------- no token leakage ---------------------------- */

test("the token is never written to logs or embedded in the config error", () => {
  const logs: string[] = [];
  const patch = (fn: "log" | "error" | "warn" | "info") => {
    const original = console[fn];
    (console as any)[fn] = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
    return () => { (console as any)[fn] = original; };
  };
  const restores = (["log", "error", "warn", "info"] as const).map(patch);
  try {
    const env = { [INTERNAL_SERVICE_TOKEN_ENV]: TOKEN } as any;
    hasValidInternalServiceToken(reqWith(TOKEN), env);
    hasValidInternalServiceToken(reqWith("wrong-token"), env);
    timingSafeEqualStrings(TOKEN, TOKEN);
    configuredInternalServiceToken(env);
  } finally {
    restores.forEach((r) => r());
  }
  assert.equal(logs.join("\n").includes(TOKEN), false, "no captured log line contains the token");
});
