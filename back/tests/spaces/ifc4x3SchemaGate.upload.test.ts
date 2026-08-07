/**
 * REAL initial/legacy upload boundary test (ADR-0052 §A): drives handleModelUpload with a
 * mocked MySQL and a mocked Flask bridge that returns a chosen declared schema, and proves
 * the IFC4x3-only gate in modelUploadService:
 *   - IFC4  → rejected (unsupported_ifc_schema, 422) BEFORE inventory persistence;
 *   - IFC2X3 → rejected the same way;
 *   - unknown/blank schema → rejected;
 *   - valid IFC4X3 → passes the gate and reaches activation.
 * On rejection: zero entities/spaces/bindings/assets, no activation, version marked failed.
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { installFakeMySQL, fakeConnection, respond } from "../helpers/fakeDb.ts";
import { schemaRoutes, SCOPE_CLEAN, occurrencesFromInventory } from "../helpers/spaceSchemaFixtures.ts";

installFakeMySQL();
process.env.IFCOPENSHELL_FLASK_API_ROUTE ??= "http://flask.test/api";
process.env.PORT ??= "3001";

const { handleModelUpload } = await import("../../services/modelUploadService.ts");
const providers = await import("../../policies/policyProvider.ts");
const identityProvider = await import("../../identity/spaceIdentityProvider.ts");
const { resetCanonicalSchemaCache } = await import("../../utils/spaceDatabase.ts");
const { STORAGE_ROOT } = await import("../../utils/storage.ts");

const MODEL_ID = 999501;
const VERSION_ID = 999601;

const INVENTORY = {
    "2TYxeEXST7MP9bl8QCa9Ti": { spaceGuid: "2TYxeEXST7MP9bl8QCa9Ti", spaceName: "T-101", spaceLongName: "Lab 101", elements: [] },
};

const realFetch = globalThis.fetch;
let declaredSchema: string | null = "IFC4X3_ADD2";
function installFakeFetch() {
    (globalThis as any).fetch = async () => ({ ok: true, json: async () => ({
        data: INVENTORY, spaceOccurrences: occurrencesFromInventory(INVENTORY), schema: declaredSchema,
    }) });
}
after(() => {
    (globalThis as any).fetch = realFetch;
    fs.rmSync(path.join(STORAGE_ROOT, `models/${MODEL_ID}`), { recursive: true, force: true });
});

function makeTempIfc(): string {
    const p = path.join(os.tmpdir(), `oswadt-gate-${Date.now()}-${Math.random().toString(36).slice(2)}.ifc`);
    fs.writeFileSync(p, "ISO-10303-21; fixture");
    return p;
}

function routes(): [RegExp, any][] {
    let entityId = 800;
    return [
        [/SELECT\s+id,[\s\S]*FROM models[\s\S]*WHERE id = :id/i, [[{ id: MODEL_ID, name: "M", linked_parent_id: 10 }]]],
        [/SELECT id FROM models WHERE id = :modelId FOR UPDATE/i, [[{ id: MODEL_ID }]]],
        [/COALESCE\(MAX\(version_number\), 0\) \+ 1/i, [[{ next: 2 }]]],
        [/INSERT INTO model_versions/i, [{ insertId: VERSION_ID }]],
        [/UPDATE model_versions SET storage_key/i, [{}]],
        [/spatial_authority_model_id/i, [[{ spatial_authority_model_id: null, model_count: 1, single_model_id: MODEL_ID }]]],
        [/SELECT COUNT\(\*\) as count[\s\S]*FROM entities/i, [[{ count: 0 }]]],
        [/INSERT INTO entities/i, () => [{ insertId: entityId++ }]],
        ...schemaRoutes(),
        ...SCOPE_CLEAN,
        [/SELECT \* FROM spaces/i, [[]]],
        [/INSERT INTO spaces/i, (() => { let id = 300; return () => [{ insertId: id++ }]; })()],
        [/INSERT INTO space_bindings/i, [{ insertId: 400, affectedRows: 1 }]],
        [/UPDATE spaces SET status/i, [{}]],
        [/SELECT \* FROM assets WHERE space_id/i, [[]]],
        [/FROM assets[\s\S]*asset_code = :tag/i, [[]]],
        [/FROM assets[\s\S]*serial_number = :serial/i, [[]]],
        [/INSERT INTO assets/i, (() => { let id = 600; return () => [{ insertId: id++ }]; })()],
        [/INSERT INTO asset_bindings/i, [{ insertId: 700 }]],
        [/UPDATE assets/i, [{}]],
        [/SELECT id, status FROM model_versions WHERE id = :versionId AND model_id = :modelId FOR UPDATE/i,
            [[{ id: VERSION_ID, status: "processing" }]]],
        [/SELECT current_version_id FROM models WHERE id = :modelId FOR UPDATE/i, [[{ current_version_id: 42 }]]],
        [/UPDATE model_versions SET status = 'active'/i, [{}]],
        [/UPDATE model_versions SET status = 'archived'/i, [{}]],
        [/UPDATE models SET current_version_id/i, [{}]],
        [/UPDATE model_versions[\s\S]*SET status = 'failed'/i, [{}]],
        [/DELETE FROM (assets|entities|space_bindings|spaces)/i, [{}]],
    ];
}

beforeEach(() => {
    fakeConnection.reset();
    providers.resetPolicyProviders();
    identityProvider.resetSpaceIdentityResolver();
    resetCanonicalSchemaCache();
    declaredSchema = "IFC4X3_ADD2";
    installFakeFetch();
    fs.rmSync(path.join(STORAGE_ROOT, `models/${MODEL_ID}`), { recursive: true, force: true });
});

function assertNoPersistenceNoActivation() {
    assert.equal(fakeConnection.callsMatching(/INSERT INTO entities/i).length, 0, "no entities");
    assert.equal(fakeConnection.callsMatching(/INSERT INTO spaces/i).length, 0, "no spaces");
    assert.equal(fakeConnection.callsMatching(/INSERT INTO space_bindings/i).length, 0, "no bindings");
    assert.equal(fakeConnection.callsMatching(/INSERT INTO assets/i).length, 0, "no assets");
    assert.equal(fakeConnection.callsMatching(/UPDATE models SET current_version_id/i).length, 0, "no activation");
}

for (const bad of [
    { label: "IFC4", schema: "IFC4" },
    { label: "IFC2X3", schema: "IFC2X3" },
    { label: "unknown", schema: "SOMETHING" },
    { label: "blank", schema: null },
]) {
    test(`initial upload: ${bad.label} → 422 unsupported_ifc_schema, no persistence, no activation, version failed`, async () => {
        declaredSchema = bad.schema;
        respond(routes());
        const err: any = await handleModelUpload({ tempFilePath: makeTempIfc(), originalFilename: "v.ifc", modelId: MODEL_ID })
            .then(() => null, (e: any) => e);
        assert.ok(err, "must reject");
        assert.equal(err.code, "unsupported_ifc_schema");
        assert.equal(err.statusCode, 422);
        assertNoPersistenceNoActivation();
        const failed = fakeConnection.callsMatching(/UPDATE model_versions[\s\S]*SET status = 'failed'/i);
        assert.equal(failed.length, 1, "reserved version marked failed");
        assert.match(String(failed[0]!.params?.reason ?? JSON.stringify(failed[0]!.params)), /ifc_schema_gate/);
    });
}

test("initial upload: valid IFC4X3_ADD2 passes the gate and reaches activation", async () => {
    declaredSchema = "IFC4X3_ADD2";
    respond(routes());
    await handleModelUpload({ tempFilePath: makeTempIfc(), originalFilename: "v.ifc", modelId: MODEL_ID });
    assert.ok(fakeConnection.callsMatching(/INSERT INTO entities/i).length > 0, "passed the gate into inventory persistence");
    assert.equal(fakeConnection.callsMatching(/UPDATE models SET current_version_id/i).length, 1, "activated");
    assert.equal(fakeConnection.callsMatching(/SET status = 'failed'/i).length, 0, "no failure");
});
