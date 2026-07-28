/**
 * Stage 0A — additive schema foundation for IfcSpace identity by IFC GlobalId.
 * See documentation/adr/ADR-0051-ifcspace-persistent-identity-globalid.md.
 *
 * This module is the migration MECHANISM (forward + rollback). It is deliberately
 * a narrowly scoped TypeScript executor rather than a plain .sql file run through
 * scripts/runSqlFile.ts, because Stage 0A needs behaviour the generic runner
 * cannot express:
 *   - hard data GUARDS that must abort BEFORE any backfill;
 *   - EXACT metadata verification of pre-existing artifacts (not just name checks)
 *     so a same-name but differently-shaped column/index/check is never silently
 *     reused, replaced or dropped;
 *   - restart-safe, conditional DDL (MySQL 8 has no `ADD COLUMN IF NOT EXISTS`);
 *   - an ATOMIC, all-or-nothing backfill that refuses to overwrite a divergent
 *     value and never leaves a partial DML result;
 *   - byte-exact / case-sensitive (BINARY) comparisons throughout.
 * The generic runner is left completely unchanged.
 *
 * DDL vs DML atomicity: MySQL implicitly commits every ALTER TABLE, so the whole
 * migration is NOT one transaction — the column/check may exist after a failed
 * run. It is instead made RESTART-SAFE: each DDL step is existence+shape guarded
 * and idempotent. The BACKFILL, by contrast, IS atomic: a full conflict preflight
 * runs before any UPDATE and the UPDATE itself runs inside a transaction, so it is
 * always all-or-nothing.
 *
 * IMPORTANT: every function operates on the CONNECTION's current default schema
 * (information_schema lookups use DATABASE()). The disposable-schema self-test
 * reuses this exact code against a throwaway schema, never against digital_twin.
 */
import type { Connection } from "mysql2/promise";

export const SPACES_TABLE = "spaces";
export const GLOBAL_ID_COLUMN = "ifc_global_id";
export const UNIQUE_INDEX = "uq_spaces_linked_model_ifc_global_id";
export const CHECK_CONSTRAINT = "chk_spaces_ifc_global_id_format";
export const LEGACY_SCOPE_INDEX = "uq_spaces_scope_code";

/** IFC compressed-GUID alphabet: 0-9, A-Z, a-z, underscore, dollar (case-sensitive). */
const GUID_ALPHABET_REGEXP = "^[0-9A-Za-z_$]{22}$";

export type ArtifactState = "ABSENT" | "EXACT" | "CONFLICTING";
export interface Inspection {
  state: ArtifactState;
  /** Human-readable actual-vs-expected description (empty when ABSENT/EXACT). */
  detail: string;
}

export class MigrationGuardError extends Error {
  constructor(message: string) { super(message); this.name = "MigrationGuardError"; }
}
export class ArtifactConflictError extends Error {
  constructor(message: string) { super(message); this.name = "ArtifactConflictError"; }
}

async function rows(conn: Connection, sql: string, params: unknown[] = []): Promise<any[]> {
  const [r]: any = await conn.query(sql, params);
  return r as any[];
}
async function scalar(conn: Connection, sql: string, params: unknown[] = []): Promise<number> {
  const [r]: any = await conn.query(sql, params);
  return Number(r[0]?.c ?? 0);
}

// --------------------------------------------------------------------------
// Metadata inspection — classify each artifact ABSENT / EXACT / CONFLICTING.
// --------------------------------------------------------------------------

/**
 * Quote-aware normalisation of a stored CHECK clause. Normalisation NEVER touches
 * the inside of a SQL single-quoted string literal — so the case-sensitive regex
 * alphabet (`A-Z` vs `a-z`) is preserved byte-for-byte and a lowercase-only or
 * uppercase-only alphabet is correctly seen as different. A single global
 * lowercase would wrongly collapse `^[0-9A-Za-z_$]{22}$` and `^[0-9a-z_$]{22}$`.
 *
 * OUTSIDE literals: lowercase keywords/function names, drop backticks, collapse
 * whitespace, drop stray backslashes, and strip a MySQL charset introducer
 * (`_ascii` / `_utf8mb4` / `_cp850` …) that immediately precedes a literal.
 * INSIDE literals: copy content verbatim, decoding `\\` (escaped backslash) and
 * `''` (doubled quote) as content, and treating `\'` or a bare `'` as the closing
 * delimiter (MySQL serialises the delimiting quote as `\'`).
 */
export function normalizeCheckClause(clause: string): string {
  let out = "";
  let struct = "";
  const flushStruct = () => {
    let s = struct.toLowerCase().replace(/`/g, "").replace(/\s+/g, "").replace(/\\/g, "");
    // strip a trailing charset introducer that directly precedes the literal
    s = s.replace(/(^|[^0-9a-z_])_[a-z][a-z0-9]*$/, "$1");
    out += s;
    struct = "";
  };
  let i = 0;
  const n = clause.length;
  while (i < n) {
    const c = clause[i];
    const opensLiteral = c === "'" || (c === "\\" && clause[i + 1] === "'");
    if (opensLiteral) {
      flushStruct();
      i += c === "\\" ? 2 : 1; // consume the opening delimiter (\' or ')
      let lit = "";
      while (i < n) {
        const d = clause[i];
        if (d === "\\" && clause[i + 1] === "\\") { lit += "\\"; i += 2; continue; } // content backslash
        if (d === "\\" && clause[i + 1] === "'") { i += 2; break; }                  // \' closes
        if (d === "'" && clause[i + 1] === "'") { lit += "'"; i += 2; continue; }     // '' doubled -> content quote
        if (d === "'") { i += 1; break; }                                             // bare ' closes
        lit += d; i += 1;                                                             // verbatim; case preserved
      }
      out += "'" + lit + "'";
      continue;
    }
    struct += c;
    i += 1;
  }
  flushStruct();
  return out;
}
// The canonical form the normaliser must produce for the intended constraint.
// GLOBAL_ID_COLUMN is already lower-case; the regex keeps its case-sensitive alphabet.
const EXPECTED_CHECK_CANONICAL =
  `((${GLOBAL_ID_COLUMN}isnull)orregexp_like(${GLOBAL_ID_COLUMN},'${GUID_ALPHABET_REGEXP}'))`;

export async function inspectColumn(conn: Connection): Promise<Inspection> {
  const r = await rows(conn,
    `SELECT DATA_TYPE, CHARACTER_MAXIMUM_LENGTH AS len, CHARACTER_SET_NAME AS cs,
            COLLATION_NAME AS coll, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS def,
            EXTRA AS extra, GENERATION_EXPRESSION AS genexpr
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [SPACES_TABLE, GLOBAL_ID_COLUMN]);
  if (!r.length) return { state: "ABSENT", detail: "" };
  const c = r[0];
  const generated = String(c.extra ?? "").toUpperCase().includes("GENERATED") || Boolean(c.genexpr);
  const expected = "char(22) CHARACTER SET ascii COLLATE ascii_bin NULL, no default, not generated";
  const ok =
    c.DATA_TYPE === "char" && Number(c.len) === 22 && c.cs === "ascii" &&
    c.coll === "ascii_bin" && c.nullable === "YES" && (c.def === null || c.def === undefined) &&
    !generated;
  if (ok) return { state: "EXACT", detail: "" };
  const actual = `type=${c.DATA_TYPE}(${c.len}) charset=${c.cs} collation=${c.coll} nullable=${c.nullable} default=${c.def === null ? "NULL" : `'${c.def}'`} extra='${c.extra}' generation='${c.genexpr}'`;
  return { state: "CONFLICTING", detail: `actual: ${actual}; expected: ${expected}` };
}

/**
 * Exact inspector for a two-column UNIQUE index: NON_UNIQUE=0, exactly the two
 * expected columns in order, no prefix length, no expression column, visible.
 */
async function inspectTwoColumnUniqueIndex(conn: Connection, indexName: string, col1: string, col2: string): Promise<Inspection> {
  const r = await rows(conn,
    `SELECT SEQ_IN_INDEX AS seq, COLUMN_NAME AS col, NON_UNIQUE AS non_unique,
            SUB_PART AS sub_part, EXPRESSION AS expr, IS_VISIBLE AS visible
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?
      ORDER BY SEQ_IN_INDEX`,
    [SPACES_TABLE, indexName]);
  if (!r.length) return { state: "ABSENT", detail: "" };
  const expected = `UNIQUE(${col1}, ${col2}), no prefix, no expression, visible`;
  const cols = r.map((x) => `${x.seq}:${x.col ?? `(expr ${x.expr})`}${x.sub_part ? `(prefix ${x.sub_part})` : ""}`).join(", ");
  const ok =
    r.length === 2 &&
    r.every((x) => Number(x.non_unique) === 0) &&
    Number(r[0].seq) === 1 && r[0].col === col1 && r[0].sub_part === null && r[0].expr === null &&
    Number(r[1].seq) === 2 && r[1].col === col2 && r[1].sub_part === null && r[1].expr === null &&
    r.every((x) => x.visible === undefined || x.visible === "YES");
  if (ok) return { state: "EXACT", detail: "" };
  const actual = `non_unique=${r[0].non_unique} columns=[${cols}] visible=${r[0].visible ?? "n/a"}`;
  return { state: "CONFLICTING", detail: `${indexName} actual: ${actual}; expected: ${expected}` };
}

export async function inspectIndex(conn: Connection): Promise<Inspection> {
  return inspectTwoColumnUniqueIndex(conn, UNIQUE_INDEX, "linked_model_id", GLOBAL_ID_COLUMN);
}

/**
 * Exact inspector for the legacy Reference-based uniqueness index
 * `uq_spaces_scope_code UNIQUE(linked_model_id, inventory_code_normalized)`.
 * Stage 0A requires it because the runtime is still Reference-based; Stage 0A must
 * never create, repair, drop or rename it.
 */
export async function inspectLegacyScopeIndex(conn: Connection): Promise<Inspection> {
  return inspectTwoColumnUniqueIndex(conn, LEGACY_SCOPE_INDEX, "linked_model_id", "inventory_code_normalized");
}

export async function inspectCheck(conn: Connection): Promise<Inspection> {
  const r = await rows(conn,
    `SELECT tc.ENFORCED AS enforced, cc.CHECK_CLAUSE AS clause
       FROM information_schema.TABLE_CONSTRAINTS tc
       JOIN information_schema.CHECK_CONSTRAINTS cc
         ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
      WHERE tc.TABLE_SCHEMA = DATABASE() AND tc.TABLE_NAME = ?
        AND tc.CONSTRAINT_NAME = ? AND tc.CONSTRAINT_TYPE = 'CHECK'`,
    [SPACES_TABLE, CHECK_CONSTRAINT]);
  if (!r.length) return { state: "ABSENT", detail: "" };
  return classifyCheck(String(r[0].clause), String(r[0].enforced));
}

/**
 * Pure classifier for a CHECK constraint from its raw clause + ENFORCED metadata.
 * Exported so the exact case-sensitive comparison and the enforcement rule can be
 * unit-tested (including a non-enforced fixture) without a live constraint.
 * EXACT only when the clause matches the case-sensitive expected regex AND the
 * constraint is actively enforced.
 */
export function classifyCheck(rawClause: string, enforcedRaw: string | null): Inspection {
  const normalized = normalizeCheckClause(rawClause);
  const clauseMatches = normalized === EXPECTED_CHECK_CANONICAL;
  const enforced = String(enforcedRaw ?? "").toUpperCase() === "YES";
  if (clauseMatches && enforced) return { state: "EXACT", detail: "" };
  return {
    state: "CONFLICTING",
    detail: `clause(normalized)='${normalized}' expected='${EXPECTED_CHECK_CANONICAL}' enforced='${enforcedRaw}'`,
  };
}
export const EXPECTED_CHECK_CANONICAL_FORM = EXPECTED_CHECK_CANONICAL;

// Backwards-compatible boolean helpers (used by the self-test harness).
export async function columnExists(conn: Connection): Promise<boolean> { return (await inspectColumn(conn)).state !== "ABSENT"; }
export async function indexExists(conn: Connection): Promise<boolean> { return (await inspectIndex(conn)).state !== "ABSENT"; }
export async function checkConstraintExists(conn: Connection): Promise<boolean> { return (await inspectCheck(conn)).state !== "ABSENT"; }

// --------------------------------------------------------------------------
// Data guards (ADR-0051 §4). All comparisons byte-exact (BINARY).
// --------------------------------------------------------------------------

export async function runDataGuards(conn: Connection): Promise<void> {
  // G1 — every spaces row has at least one binding.
  const g1 = await rows(conn,
    `SELECT s.id FROM ${SPACES_TABLE} s LEFT JOIN space_bindings sb ON sb.space_id = s.id WHERE sb.id IS NULL`);
  if (g1.length) throw new MigrationGuardError(`G1: spaces without any binding: ${g1.map((r) => r.id).join(", ")}`);

  // G2 — non-null, non-blank ifc_guid.
  const g2 = await rows(conn, `SELECT id FROM space_bindings WHERE ifc_guid IS NULL OR TRIM(ifc_guid) = ''`);
  if (g2.length) throw new MigrationGuardError(`G2: bindings with null/blank ifc_guid: ${g2.map((r) => r.id).join(", ")}`);

  // G3 — exactly 22 characters.
  const g3 = await rows(conn, `SELECT id, ifc_guid FROM space_bindings WHERE CHAR_LENGTH(ifc_guid) <> 22`);
  if (g3.length) throw new MigrationGuardError(`G3: bindings with ifc_guid length <> 22: ${g3.map((r) => `${r.id}(${r.ifc_guid})`).join(", ")}`);

  // G4 — compressed IFC GUID alphabet only (case-sensitive).
  const g4 = await rows(conn, `SELECT id, ifc_guid FROM space_bindings WHERE ifc_guid NOT REGEXP '${GUID_ALPHABET_REGEXP}'`);
  if (g4.length) throw new MigrationGuardError(`G4: bindings with invalid GUID characters: ${g4.map((r) => `${r.id}(${r.ifc_guid})`).join(", ")}`);

  // G5 — one BINARY-distinct ifc_guid per spaces.id.
  const g5 = await rows(conn,
    `SELECT space_id, COUNT(DISTINCT BINARY ifc_guid) AS n FROM space_bindings GROUP BY space_id HAVING n > 1`);
  if (g5.length) throw new MigrationGuardError(`G5: GlobalId drift — spaces with >1 distinct GUID: ${g5.map((r) => `${r.space_id}(n=${r.n})`).join(", ")}`);

  // G6 — no linked_model + BINARY ifc_guid maps to more than one spaces.id.
  const g6 = await rows(conn,
    `SELECT s.linked_model_id AS lm, BINARY sb.ifc_guid AS g, COUNT(DISTINCT sb.space_id) AS n
       FROM space_bindings sb JOIN ${SPACES_TABLE} s ON s.id = sb.space_id
      GROUP BY s.linked_model_id, BINARY sb.ifc_guid HAVING n > 1`);
  if (g6.length) throw new MigrationGuardError(`G6: duplicate target identity — linked_model+GUID mapping to >1 space: ${g6.map((r) => `lm${r.lm}/${r.g}(n=${r.n})`).join(", ")}`);

  // G7 — every binding resolves version -> model -> linked_parent to its space's
  // linked_model_id. LEFT JOINs so a missing version/model or NULL linked_parent
  // is DETECTED rather than silently dropped by an INNER JOIN.
  const g7 = await rows(conn,
    `SELECT sb.id, s.linked_model_id AS space_lm, mv.id AS mv_id, m.id AS m_id, m.linked_parent_id AS binding_lm
       FROM space_bindings sb
       JOIN ${SPACES_TABLE} s ON s.id = sb.space_id
       LEFT JOIN model_versions mv ON mv.id = sb.model_version_id
       LEFT JOIN models m ON m.id = mv.model_id
      WHERE mv.id IS NULL OR m.id IS NULL OR m.linked_parent_id IS NULL OR m.linked_parent_id <> s.linked_model_id`);
  if (g7.length) throw new MigrationGuardError(`G7: binding chain integrity failure: ${g7.map((r) => `binding ${r.id} (space_lm=${r.space_lm}, version=${r.mv_id ?? "MISSING"}, model=${r.m_id ?? "MISSING"}, binding_lm=${r.binding_lm ?? "NULL"})`).join(", ")}`);

  // G8 — no orphan bindings.
  const g8 = await rows(conn,
    `SELECT sb.id FROM space_bindings sb LEFT JOIN ${SPACES_TABLE} s ON s.id = sb.space_id WHERE s.id IS NULL`);
  if (g8.length) throw new MigrationGuardError(`G8: orphan bindings: ${g8.map((r) => r.id).join(", ")}`);
}

// --------------------------------------------------------------------------
// Atomic backfill (ADR-0051 §6).
// --------------------------------------------------------------------------

interface Derived { spaceId: number; guid: string; n: number; }

async function loadDerived(conn: Connection): Promise<Derived[]> {
  const r = await rows(conn,
    `SELECT space_id AS spaceId, COUNT(DISTINCT BINARY ifc_guid) AS n, MIN(ifc_guid) AS guid
       FROM space_bindings GROUP BY space_id`);
  return r.map((x) => ({ spaceId: Number(x.spaceId), guid: String(x.guid), n: Number(x.n) }));
}

/**
 * Atomic backfill. A COMPLETE preflight (drift / missing derivation / conflicting
 * non-null value) runs before the FIRST write; the write is a single set-based
 * UPDATE JOIN inside an explicit transaction, with a post-update NULL re-check.
 * Any failure ROLLBACKs, so the backfill is all-or-nothing — never partial —
 * even though the surrounding DDL is not transactional. Returns rows updated.
 */
export async function backfill(conn: Connection): Promise<number> {
  const derived = await loadDerived(conn);
  const derivedById = new Map<number, Derived>(derived.map((d) => [d.spaceId, d]));
  const current = await rows(conn, `SELECT id, ${GLOBAL_ID_COLUMN} AS current_value FROM ${SPACES_TABLE}`);

  // ---- Full preflight: collect every problem BEFORE any DML. ----
  const problems: string[] = [];
  for (const d of derived) {
    if (d.n > 1) problems.push(`space ${d.spaceId} has ${d.n} distinct GUIDs (drift)`);
  }
  for (const row of current as any[]) {
    const id = Number(row.id);
    const d = derivedById.get(id);
    if (!d) { problems.push(`space ${id} has no derivable GlobalId (no binding)`); continue; }
    const existing = row.current_value as string | null;
    if (existing !== null && existing !== undefined && existing !== d.guid) {
      // Byte-exact JS comparison (ASCII) — conflicting prepopulated value.
      problems.push(`space ${id} already has ifc_global_id='${existing}' which differs from verified '${d.guid}'`);
    }
  }
  if (problems.length) throw new MigrationGuardError(`backfill preflight failed (no rows updated): ${problems.join("; ")}`);

  // ---- Atomic write. ----
  let updated = 0;
  await conn.beginTransaction();
  try {
    const [res]: any = await conn.query(
      `UPDATE ${SPACES_TABLE} s
         JOIN (SELECT space_id, MIN(ifc_guid) AS guid FROM space_bindings GROUP BY space_id) d
           ON d.space_id = s.id
          SET s.${GLOBAL_ID_COLUMN} = d.guid
        WHERE s.${GLOBAL_ID_COLUMN} IS NULL`);
    updated = Number(res.affectedRows ?? 0);
    const remainingNull = await scalar(conn,
      `SELECT COUNT(*) AS c FROM ${SPACES_TABLE} WHERE ${GLOBAL_ID_COLUMN} IS NULL`);
    if (remainingNull > 0) throw new MigrationGuardError(`${remainingNull} spaces row(s) still NULL after backfill`);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  }
  return updated;
}

/** Reject any duplicate populated (linked_model_id, BINARY ifc_global_id). */
async function assertNoDuplicateIdentity(conn: Connection): Promise<void> {
  const dup = await rows(conn,
    `SELECT linked_model_id AS lm, BINARY ${GLOBAL_ID_COLUMN} AS g, COUNT(*) AS n
       FROM ${SPACES_TABLE} WHERE ${GLOBAL_ID_COLUMN} IS NOT NULL
      GROUP BY linked_model_id, BINARY ${GLOBAL_ID_COLUMN} HAVING n > 1`);
  if (dup.length) throw new MigrationGuardError(`duplicate identity — cannot create unique index: ${dup.map((r) => `lm${r.lm}/${r.g}(n=${r.n})`).join(", ")}`);
}

// --------------------------------------------------------------------------
// Forward migration.
// --------------------------------------------------------------------------

export interface ForwardResult {
  columnAdded: boolean; checkAdded: boolean; rowsBackfilled: number; indexAdded: boolean;
}

/**
 * Final structural verification (ADR-0051 §7): exact column/check/index, all rows
 * populated, canonical values byte-match their verified binding GUIDs, no duplicate
 * identity, legacy scope index intact, and the data guards still hold.
 */
export async function verifyFinalState(conn: Connection): Promise<void> {
  const col = await inspectColumn(conn);
  if (col.state !== "EXACT") throw new MigrationGuardError(`final check: column not exact (${col.state}) ${col.detail}`);
  const chk = await inspectCheck(conn);
  if (chk.state !== "EXACT") throw new MigrationGuardError(`final check: CHECK not exact (${chk.state}) ${chk.detail}`);
  const idx = await inspectIndex(conn);
  if (idx.state !== "EXACT") throw new MigrationGuardError(`final check: unique index not exact (${idx.state}) ${idx.detail}`);

  const nulls = await scalar(conn, `SELECT COUNT(*) AS c FROM ${SPACES_TABLE} WHERE ${GLOBAL_ID_COLUMN} IS NULL`);
  if (nulls > 0) throw new MigrationGuardError(`final check: ${nulls} spaces row(s) still NULL`);

  const mism = await rows(conn,
    `SELECT s.id FROM ${SPACES_TABLE} s
       JOIN (SELECT space_id, MIN(ifc_guid) AS guid FROM space_bindings GROUP BY space_id) d ON d.space_id = s.id
      WHERE BINARY s.${GLOBAL_ID_COLUMN} <> BINARY d.guid`);
  if (mism.length) throw new MigrationGuardError(`final check: canonical value mismatch on spaces: ${mism.map((r) => r.id).join(", ")}`);

  await assertNoDuplicateIdentity(conn);
  const legacyFinal = await inspectLegacyScopeIndex(conn);
  if (legacyFinal.state !== "EXACT") throw new MigrationGuardError(`final check: legacy ${LEGACY_SCOPE_INDEX} must remain EXACT (${legacyFinal.state}) ${legacyFinal.detail}`);
  await runDataGuards(conn);
}

/**
 * Restart-safe forward migration. Conflicting same-name artifacts abort BEFORE any
 * data change. Order: inspect -> guards -> add column(+check) -> atomic backfill ->
 * pre-index uniqueness -> add index -> final structural verification.
 */
export async function applyForward(conn: Connection): Promise<ForwardResult> {
  // Same-name-but-different artifacts must never be reused/overwritten. Fail first,
  // before touching any data.
  const colState = await inspectColumn(conn);
  if (colState.state === "CONFLICTING") throw new ArtifactConflictError(`forward: existing ${GLOBAL_ID_COLUMN} column conflicts — ${colState.detail}`);
  const chkState = await inspectCheck(conn);
  if (chkState.state === "CONFLICTING") throw new ArtifactConflictError(`forward: existing ${CHECK_CONSTRAINT} conflicts — ${chkState.detail}`);
  const idxState = await inspectIndex(conn);
  if (idxState.state === "CONFLICTING") throw new ArtifactConflictError(`forward: existing ${UNIQUE_INDEX} conflicts — ${idxState.detail}`);

  // The runtime is still Reference-based, so the legacy uniqueness index must be
  // present and exactly shaped BEFORE any Stage 0A DDL. Missing or conflicting →
  // fail before adding the GlobalId column. Stage 0A must never touch this index.
  const legacyState = await inspectLegacyScopeIndex(conn);
  if (legacyState.state !== "EXACT") throw new ArtifactConflictError(`forward: required legacy index ${LEGACY_SCOPE_INDEX} is not EXACT (${legacyState.state}) — ${legacyState.detail || "absent"}`);

  await runDataGuards(conn);

  let columnAdded = false;
  if (colState.state === "ABSENT") {
    await conn.query(
      `ALTER TABLE ${SPACES_TABLE} ADD COLUMN ${GLOBAL_ID_COLUMN} CHAR(22) CHARACTER SET ascii COLLATE ascii_bin NULL`);
    columnAdded = true;
  }
  let checkAdded = false;
  if (chkState.state === "ABSENT") {
    await conn.query(
      `ALTER TABLE ${SPACES_TABLE} ADD CONSTRAINT ${CHECK_CONSTRAINT}
         CHECK (${GLOBAL_ID_COLUMN} IS NULL OR ${GLOBAL_ID_COLUMN} REGEXP '${GUID_ALPHABET_REGEXP}')`);
    checkAdded = true;
  }

  const rowsBackfilled = await backfill(conn);

  await assertNoDuplicateIdentity(conn);
  let indexAdded = false;
  if (idxState.state === "ABSENT") {
    await conn.query(`CREATE UNIQUE INDEX ${UNIQUE_INDEX} ON ${SPACES_TABLE} (linked_model_id, ${GLOBAL_ID_COLUMN})`);
    indexAdded = true;
  }

  await verifyFinalState(conn);
  return { columnAdded, checkAdded, rowsBackfilled, indexAdded };
}

// --------------------------------------------------------------------------
// Rollback — inspects shapes before dropping; refuses same-name conflicts.
// --------------------------------------------------------------------------

export interface RollbackResult {
  indexDropped: boolean; checkDropped: boolean; columnDropped: boolean;
}

/**
 * Paired rollback (ADR-0051 §8). Drops ONLY artifacts that match the exact expected
 * definition, in dependency order (index -> check -> column). A same-name artifact
 * with an unexpected shape is REFUSED (throws) and left untouched. Idempotent;
 * never CASCADE; never touches spaces.id, space_uuid, inventory_code, name,
 * bindings or any FK. Intended only BEFORE later stages depend on ifc_global_id.
 */
export async function applyRollback(conn: Connection): Promise<RollbackResult> {
  const idx = await inspectIndex(conn);
  if (idx.state === "CONFLICTING") throw new ArtifactConflictError(`rollback: refusing to drop same-name index with unexpected shape — ${idx.detail}`);
  const chk = await inspectCheck(conn);
  if (chk.state === "CONFLICTING") throw new ArtifactConflictError(`rollback: refusing to drop same-name CHECK with unexpected definition — ${chk.detail}`);
  const col = await inspectColumn(conn);
  if (col.state === "CONFLICTING") throw new ArtifactConflictError(`rollback: refusing to drop same-name column with unexpected shape — ${col.detail}`);

  let indexDropped = false;
  if (idx.state === "EXACT") { await conn.query(`DROP INDEX ${UNIQUE_INDEX} ON ${SPACES_TABLE}`); indexDropped = true; }
  let checkDropped = false;
  if (chk.state === "EXACT") { await conn.query(`ALTER TABLE ${SPACES_TABLE} DROP CHECK ${CHECK_CONSTRAINT}`); checkDropped = true; }
  // Column dropped only after the expected index/check are gone (they are, above).
  let columnDropped = false;
  if (col.state === "EXACT") { await conn.query(`ALTER TABLE ${SPACES_TABLE} DROP COLUMN ${GLOBAL_ID_COLUMN}`); columnDropped = true; }
  return { indexDropped, checkDropped, columnDropped };
}
