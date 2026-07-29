/**
 * Stage 0B (ADR-0051 §3): the model-intake preview applies the SAME exact Stage 0A
 * precondition + per-scope integrity as the write path, and returns stable
 * operational codes (never raw SQL/driver text) when the column is absent, an index
 * is absent/wrong-shaped, an existing space has a NULL canonical GlobalId, or a
 * binding disagrees with the canonical value.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeMySQL, fakeConnection, respond } from "../helpers/fakeDb.ts";
import { schemaRoutes, SCOPE_CLEAN, CANON_INDEX_EXACT } from "../helpers/spaceSchemaFixtures.ts";

installFakeMySQL();
const { ModelIntakeDatabase } = await import("../../utils/modelIntakeDatabase.ts");
const db = new ModelIntakeDatabase();

beforeEach(() => fakeConnection.reset());

test("ok when the schema is exact and the scope is clean", async () => {
    respond([...schemaRoutes(), ...SCOPE_CLEAN]);
    assert.deepEqual(await db.checkCanonicalPreconditionForScope(10), { code: "ok", message: null });
});

test("canonical_schema_missing when the canonical column is absent", async () => {
    respond([...schemaRoutes({ column: null }), ...SCOPE_CLEAN]);
    const r = await db.checkCanonicalPreconditionForScope(10);
    assert.equal(r.code, "canonical_schema_missing");
    assert.doesNotMatch(r.message ?? "", /SELECT|information_schema|\bat \b/i);
});

test("canonical_schema_missing when the canonical index is non-unique (wrong shape)", async () => {
    respond([...schemaRoutes({ canonicalIndex: CANON_INDEX_EXACT.map((r) => ({ ...r, non_unique: 1 })) }), ...SCOPE_CLEAN]);
    assert.equal((await db.checkCanonicalPreconditionForScope(10)).code, "canonical_schema_missing");
});

test("canonical_schema_missing when the legacy index is absent", async () => {
    respond([...schemaRoutes({ legacyIndex: [] }), ...SCOPE_CLEAN]);
    assert.equal((await db.checkCanonicalPreconditionForScope(10)).code, "canonical_schema_missing");
});

test("canonical_schema_missing when no database is selected", async () => {
    respond([...schemaRoutes({ db: null }), ...SCOPE_CLEAN]);
    assert.equal((await db.checkCanonicalPreconditionForScope(10)).code, "canonical_schema_missing");
});

test("canonical_inconsistency when an existing space has a NULL canonical GlobalId", async () => {
    respond([...schemaRoutes(),
        [/ifc_global_id IS NULL/i, [[{ id: 5 }]]],
        [/BINARY sb\.ifc_guid <> BINARY s\.ifc_global_id/i, [[]]]]);
    assert.equal((await db.checkCanonicalPreconditionForScope(10)).code, "canonical_inconsistency");
});

test("canonical_inconsistency when a binding disagrees with the canonical value", async () => {
    respond([...schemaRoutes(),
        [/ifc_global_id IS NULL/i, [[]]],
        [/BINARY sb\.ifc_guid <> BINARY s\.ifc_global_id/i, [[{ binding_id: 7 }]]]]);
    assert.equal((await db.checkCanonicalPreconditionForScope(10)).code, "canonical_inconsistency");
});

test("§2-v3: a connection/driver failure returns a stable code, never a raw error (checkConnection inside try)", async () => {
    // Simulate the very first query (inside the controlled try) throwing a raw driver
    // error, as a connection setup failure would.
    respond([[/SELECT DATABASE\(\) AS db/i, () => { throw new Error("ECONNREFUSED 127.0.0.1:3306"); }]]);
    const r = await db.checkCanonicalPreconditionForScope(10);
    assert.equal(r.code, "canonical_schema_missing");
    assert.doesNotMatch(r.message ?? "", /ECONNREFUSED|SELECT|\bat \b|\.ts:/i);
});
