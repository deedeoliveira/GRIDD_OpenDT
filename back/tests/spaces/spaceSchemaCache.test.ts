/**
 * Stage 0B (ADR-0051 §3/§4): the canonical Stage 0A schema is verified EXACTLY
 * (column shape, enforced case-sensitive CHECK, canonical AND legacy unique
 * indexes) and the successful result is cached KEYED BY the actual selected
 * database. A cached success for schema A must never authorize a schema B whose
 * artifacts are ABSENT or merely same-name-but-CONFLICTING (non-unique, reversed
 * columns, wrong column shape, non-enforced/wrong CHECK, missing legacy index).
 * Failures are not cached; a null selected database is rejected; the structural
 * cache never hides a per-operation canonical inconsistency.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeMySQL, fakeConnection, respond } from "../helpers/fakeDb.ts";
import { COLUMN_EXACT, CANON_INDEX_EXACT, LEGACY_INDEX_EXACT, CHECK_EXACT } from "../helpers/spaceSchemaFixtures.ts";

installFakeMySQL();
const { default: spaceDb, SpaceCanonicalSchemaError, resetCanonicalSchemaCache } =
    await import("../../utils/spaceDatabase.ts");

beforeEach(() => { fakeConnection.reset(); resetCanonicalSchemaCache(); });

type SchemaState = { db: string | null; column: any; canonical: any[]; legacy: any[]; check: any };
function exact(db: string): SchemaState {
    return { db, column: { ...COLUMN_EXACT }, canonical: CANON_INDEX_EXACT, legacy: LEGACY_INDEX_EXACT, check: { ...CHECK_EXACT } };
}
function driveSchema(state: { cur: SchemaState }) {
    respond([
        [/SELECT DATABASE\(\) AS db/i, () => [[{ db: state.cur.db }]]],
        [/information_schema\.COLUMNS/i, () => (state.cur.column === null ? [[]] : [[state.cur.column]])],
        [/information_schema\.STATISTICS/i, (_s: string, p: any) =>
            [String(p?.[1]) === "uq_spaces_scope_code" ? state.cur.legacy : state.cur.canonical]],
        [/CHECK_CONSTRAINTS/i, () => (state.cur.check === null ? [[]] : [[state.cur.check]])],
    ]);
}
const columnCalls = () => fakeConnection.callsMatching(/information_schema\.COLUMNS/i).length;

test("EXACT verify caches by database; a cached success is reused without re-inspection", async () => {
    const state = { cur: exact("schema_A") };
    driveSchema(state);
    await spaceDb.assertCanonicalSpaceSchema();
    assert.equal(columnCalls(), 1, "A verified once");
    // Even if A's artifacts would now report broken, the cached success is reused.
    state.cur = { ...exact("schema_A"), check: { enforced: "NO", clause: CHECK_EXACT.clause } };
    await spaceDb.assertCanonicalSpaceSchema();
    assert.equal(columnCalls(), 1, "A reused from cache — no re-inspection");
});

test("null selected database is rejected", async () => {
    const state = { cur: { ...exact("x"), db: null } };
    driveSchema(state);
    await assert.rejects(spaceDb.assertCanonicalSpaceSchema(),
        (e: any) => { assert.ok(e instanceof SpaceCanonicalSchemaError); assert.equal(e.code, "canonical_schema_missing"); return true; });
});

// Each conflicting schema B must be rejected even though schema A was cached.
const CONFLICTING_B: Array<{ label: string; mutate: (s: SchemaState) => SchemaState }> = [
    { label: "same-name canonical index but NON-UNIQUE", mutate: (s) => ({ ...s, canonical: CANON_INDEX_EXACT.map((r) => ({ ...r, non_unique: 1 })) }) },
    { label: "canonical index with REVERSED columns", mutate: (s) => ({ ...s, canonical: [{ ...CANON_INDEX_EXACT[0], seq: 1, col: "ifc_global_id" }, { ...CANON_INDEX_EXACT[1], seq: 2, col: "linked_model_id" }] }) },
    { label: "column wrong length", mutate: (s) => ({ ...s, column: { ...COLUMN_EXACT, len: 20 } }) },
    { label: "column wrong collation", mutate: (s) => ({ ...s, column: { ...COLUMN_EXACT, coll: "utf8mb4_bin", cs: "utf8mb4" } }) },
    { label: "CHECK not enforced", mutate: (s) => ({ ...s, check: { enforced: "NO", clause: CHECK_EXACT.clause } }) },
    { label: "CHECK wrong (lowercase-only alphabet)", mutate: (s) => ({ ...s, check: { enforced: "YES", clause: "((`ifc_global_id` is null) or regexp_like(`ifc_global_id`,_utf8mb4'^[0-9a-z_$]{22}$'))" } }) },
    { label: "legacy index MISSING", mutate: (s) => ({ ...s, legacy: [] }) },
    { label: "legacy index NON-UNIQUE", mutate: (s) => ({ ...s, legacy: LEGACY_INDEX_EXACT.map((r) => ({ ...r, non_unique: 1 })) }) },
    { label: "canonical column ABSENT", mutate: (s) => ({ ...s, column: null }) },
];

for (const variant of CONFLICTING_B) {
    test(`cache isolation: A cached does not authorize B (${variant.label})`, async () => {
        const state = { cur: exact("schema_A") };
        driveSchema(state);
        await spaceDb.assertCanonicalSpaceSchema(); // A EXACT → cached
        state.cur = variant.mutate(exact("schema_B"));
        await assert.rejects(spaceDb.assertCanonicalSpaceSchema(),
            (e: any) => { assert.ok(e instanceof SpaceCanonicalSchemaError, variant.label); assert.equal(e.code, "canonical_schema_missing"); return true; });
        // Recovery: once B becomes EXACT it verifies (failure was not cached).
        state.cur = exact("schema_B");
        await spaceDb.assertCanonicalSpaceSchema();
        // Back to A: still cached from the first success.
        const before = columnCalls();
        state.cur = exact("schema_A");
        await spaceDb.assertCanonicalSpaceSchema();
        assert.equal(columnCalls(), before, "A remained cached");
    });
}

test("structural cache does not hide a per-scope canonical inconsistency", async () => {
    const state = { cur: exact("schema_A") };
    driveSchema(state);
    await spaceDb.assertCanonicalSpaceSchema(); // warm the cache
    // findScopeCanonicalInconsistencies is a separate per-operation query.
    respond([
        [/ifc_global_id IS NULL/i, [[{ id: 9 }]]],
        [/BINARY sb\.ifc_guid <> BINARY s\.ifc_global_id/i, [[]]],
    ]);
    const inconsistencies = await spaceDb.findScopeCanonicalInconsistencies(10);
    assert.deepEqual(inconsistencies.nullCanonical, [9]);
});
