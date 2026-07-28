import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeCheckClause, classifyCheck, EXPECTED_CHECK_CANONICAL_FORM,
} from "../../scripts/migrations/spaceGlobalId.ts";

// The real MySQL 8.0.45 serialisation: delimiters as \' and a charset introducer.
const REAL = "((`ifc_global_id` is null) or regexp_like(`ifc_global_id`,_utf8mb4\\'^[0-9A-Za-z_$]{22}$\\'))";
const LOWER_ALPHA = "((`ifc_global_id` is null) or regexp_like(`ifc_global_id`,_utf8mb4\\'^[0-9a-z_$]{22}$\\'))";
const UPPER_ALPHA = "((`ifc_global_id` is null) or regexp_like(`ifc_global_id`,_utf8mb4\\'^[0-9A-Z_$]{22}$\\'))";

test("S6a the real serialised clause normalises to the expected canonical form", () => {
  assert.equal(normalizeCheckClause(REAL), EXPECTED_CHECK_CANONICAL_FORM);
});

test("S6b structure outside literals is normalised (case, whitespace, backticks, introducer)", () => {
  const noisy = "((  `ifc_global_id`  IS   NULL ) OR REGEXP_LIKE( `ifc_global_id` , _ascii\\'^[0-9A-Za-z_$]{22}$\\' ))";
  assert.equal(normalizeCheckClause(noisy), EXPECTED_CHECK_CANONICAL_FORM);
});

test("S6c the regex alphabet case is preserved (never globally lowercased)", () => {
  // A lowercase-only or uppercase-only alphabet must NOT collapse to the expected form.
  assert.notEqual(normalizeCheckClause(LOWER_ALPHA), EXPECTED_CHECK_CANONICAL_FORM);
  assert.notEqual(normalizeCheckClause(UPPER_ALPHA), EXPECTED_CHECK_CANONICAL_FORM);
  // The exact case-sensitive ranges survive inside the literal.
  assert.ok(normalizeCheckClause(REAL).includes("A-Za-z"));
  assert.ok(normalizeCheckClause(LOWER_ALPHA).includes("0-9a-z_$"));
  assert.ok(normalizeCheckClause(UPPER_ALPHA).includes("0-9A-Z_$"));
});

test("S6d doubled/escaped quotes inside a literal are handled without corrupting it", () => {
  // '' inside a literal is one content quote; the surrounding \' are delimiters.
  const doubled = "regexp_like(`c`,_utf8mb4\\'^a''b$\\')";
  assert.ok(normalizeCheckClause(doubled).includes("^a'b$"));
  // A content backslash (\\) is preserved as a single backslash.
  const withBackslash = "regexp_like(`c`,_utf8mb4\\'^a\\\\b$\\')";
  assert.ok(normalizeCheckClause(withBackslash).includes("^a\\b$"));
});

test("S6e classifyCheck: exact clause + enforced = EXACT", () => {
  assert.equal(classifyCheck(REAL, "YES").state, "EXACT");
});

test("S6f classifyCheck: exact clause + NOT enforced = CONFLICTING", () => {
  const c = classifyCheck(REAL, "NO");
  assert.equal(c.state, "CONFLICTING");
  assert.match(c.detail, /enforced='NO'/);
});

test("S6g classifyCheck: wrong (lowercase-only) clause + enforced = CONFLICTING", () => {
  assert.equal(classifyCheck(LOWER_ALPHA, "YES").state, "CONFLICTING");
});
