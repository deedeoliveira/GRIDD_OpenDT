/**
 * Fake-DB fixtures for the exact Stage 0A canonical-schema inspection (ADR-0051
 * §4). assertCanonicalSpaceSchema / the preview precondition run four exact
 * inspectors (column, canonical index, CHECK, legacy index) through
 * `utils/spaceCanonicalSchema.ts`. These fixtures return information_schema rows
 * shaped exactly as those inspectors expect, so fake tests exercise the real
 * classifier rather than a weakened count check.
 */

/** EXACT column row: char(22) ascii/ascii_bin, nullable, no default, not generated. */
export const COLUMN_EXACT = {
    DATA_TYPE: "char", len: 22, cs: "ascii", coll: "ascii_bin",
    nullable: "YES", def: null, extra: "", genexpr: null,
};

/** EXACT canonical unique index rows: UNIQUE(linked_model_id, ifc_global_id). */
export const CANON_INDEX_EXACT = [
    { seq: 1, col: "linked_model_id", non_unique: 0, sub_part: null, expr: null, visible: "YES" },
    { seq: 2, col: "ifc_global_id", non_unique: 0, sub_part: null, expr: null, visible: "YES" },
];

/** EXACT legacy scope index rows: UNIQUE(linked_model_id, inventory_code_normalized). */
export const LEGACY_INDEX_EXACT = [
    { seq: 1, col: "linked_model_id", non_unique: 0, sub_part: null, expr: null, visible: "YES" },
    { seq: 2, col: "inventory_code_normalized", non_unique: 0, sub_part: null, expr: null, visible: "YES" },
];

/** EXACT CHECK row: enforced, case-sensitive ^[0-9A-Za-z_$]{22}$ clause (MySQL 8 storage form). */
export const CHECK_EXACT = {
    enforced: "YES",
    clause: "((`ifc_global_id` is null) or regexp_like(`ifc_global_id`,_utf8mb4'^[0-9A-Za-z_$]{22}$'))",
};

export interface SchemaFixtureOverrides {
    db?: string | null;
    column?: any;                 // single column row, or null for ABSENT
    canonicalIndex?: any[];       // index rows, or [] for ABSENT
    legacyIndex?: any[];
    check?: any;                  // check row, or null for ABSENT
}

/**
 * Build the fake routes for the four exact inspectors plus SELECT DATABASE().
 * Pass overrides to simulate ABSENT/CONFLICTING artifacts (e.g. a non-unique or
 * reversed canonical index, a wrong-length column, a non-enforced CHECK, a missing
 * legacy index) for cache-isolation and preview-precondition tests.
 */
export function schemaRoutes(overrides: SchemaFixtureOverrides = {}): [RegExp, any][] {
    const db = overrides.db === undefined ? "test-db" : overrides.db;
    const column = overrides.column === undefined ? COLUMN_EXACT : overrides.column;
    const canonical = overrides.canonicalIndex === undefined ? CANON_INDEX_EXACT : overrides.canonicalIndex;
    const legacy = overrides.legacyIndex === undefined ? LEGACY_INDEX_EXACT : overrides.legacyIndex;
    const check = overrides.check === undefined ? CHECK_EXACT : overrides.check;
    return [
        [/SELECT DATABASE\(\) AS db/i, [[{ db }]]],
        [/information_schema\.COLUMNS/i, column === null ? [[]] : [[column]]],
        [/information_schema\.STATISTICS/i, (_sql: string, p: any) =>
            [String(p?.[1]) === "uq_spaces_scope_code" ? legacy : canonical]],
        [/CHECK_CONSTRAINTS/i, check === null ? [[]] : [[check]]],
    ];
}

/** Scope-integrity routes: no NULL canonical GlobalId, no binding/canonical mismatch. */
export const SCOPE_CLEAN: [RegExp, any][] = [
    [/ifc_global_id IS NULL/i, [[]]],
    [/BINARY sb\.ifc_guid <> BINARY s\.ifc_global_id/i, [[]]],
];

/**
 * Derive the LOSSLESS spaceOccurrences list from a GlobalId-keyed inventory dict,
 * mirroring what the Flask bridge now emits (ADR-0051 Stage 0B §1). Flow-test fetch
 * mocks must return this alongside `data`, because the write path requires the
 * lossless contract and refuses to persist without it. A dict cannot represent two
 * IfcSpace occurrences with the same GlobalId; tests that need a real duplicate pass
 * an explicit occurrences array instead.
 */
export function occurrencesFromInventory(inventory: Record<string, any>): any[] {
    let entityId = 1;
    return Object.entries(inventory ?? {}).map(([guid, s]) => ({
        entityId: entityId++, guid,
        name: s?.spaceName ?? null, longName: s?.spaceLongName ?? null, psets: s?.psets ?? null,
    }));
}
