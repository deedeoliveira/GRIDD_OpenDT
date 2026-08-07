/**
 * Integração da identidade espacial no fluxo de upload (Prompt 3 + revisão):
 * spatial_preflight ANTES da persistência, regra estrita no modelo
 * autoritativo, compensações e separação identidade/política.
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

const MODEL_ID = 999301;
const VERSION_ID = 999401;

/** Inventário totalmente válido (regra estrita satisfeita). */
const INVENTORY_ALL_VALID = {
    "3VKKG6_QDBqgUlHMH5Q4EB": {
        spaceGuid: "3VKKG6_QDBqgUlHMH5Q4EB", spaceName: "Sala A", spaceLongName: "Sala Grande A",
        psets: { Pset_SpaceCommon: { Reference: "R-A" } }, elements: [],
    },
    "2TYxeEXST7MP9bl8QCa9Ti": {
        spaceGuid: "2TYxeEXST7MP9bl8QCa9Ti", spaceName: "Sala B", spaceLongName: null,
        psets: { Pset_SpaceCommon: { Reference: "R-B" } }, elements: [],
    },
};

/** Inventário com um espaço sem IfcSpace.Name (viola a regra estrita no autoritativo). */
const INVENTORY_ONE_MISSING = {
    ...INVENTORY_ALL_VALID,
    "2TYxeEXST7MP9bl8QCa9Od": {
        spaceGuid: "2TYxeEXST7MP9bl8QCa9Od", spaceName: null, spaceLongName: null,
        psets: {}, elements: [],
    },
};

// ADR-0052: the inventory code is IfcSpace.Name; a duplicated Name (not a Reference) collides.
const INVENTORY_DUPLICATED = {
    "3VKKG6_QDBqgUlHMH5Q4EB": { spaceGuid: "3VKKG6_QDBqgUlHMH5Q4EB", spaceName: "R-DUP", psets: {}, elements: [] },
    "2TYxeEXST7MP9bl8QCa9Ti": { spaceGuid: "2TYxeEXST7MP9bl8QCa9Ti", spaceName: "R-DUP", psets: {}, elements: [] },
};

const realFetch = globalThis.fetch;
let inventoryPayload: any = INVENTORY_ALL_VALID;

after(() => {
    (globalThis as any).fetch = realFetch;
    fs.rmSync(path.join(STORAGE_ROOT, `models/${MODEL_ID}`), { recursive: true, force: true });
});

function makeTempIfc(): string {
    const p = path.join(os.tmpdir(), `oswadt-space-${Date.now()}-${Math.random().toString(36).slice(2)}.ifc`);
    fs.writeFileSync(p, "ISO-10303-21; fixture");
    return p;
}

function routes(authority: "single" | "other" = "single"): [RegExp, any][] {
    let entityId = 800;
    const authorityRow = authority === "single"
        ? { spatial_authority_model_id: null, model_count: 1, single_model_id: MODEL_ID }
        : { spatial_authority_model_id: 12345, model_count: 2, single_model_id: MODEL_ID };

    return [
        [/SELECT\s+id,[\s\S]*FROM models[\s\S]*WHERE id = :id/i, [[{ id: MODEL_ID, name: "M", linked_parent_id: 10 }]]],
        [/SELECT id FROM models WHERE id = :modelId FOR UPDATE/i, [[{ id: MODEL_ID }]]],
        [/COALESCE\(MAX\(version_number\), 0\) \+ 1/i, [[{ next: 2 }]]],
        [/INSERT INTO model_versions/i, [{ insertId: VERSION_ID }]],
        [/UPDATE model_versions SET storage_key/i, [{}]],
        [/spatial_authority_model_id/i, [[authorityRow]]],
        [/SELECT COUNT\(\*\) as count[\s\S]*FROM entities/i, [[{ count: 0 }]]],
        [/INSERT INTO entities/i, () => [{ insertId: entityId++ }]],
        // Stage 0B EXACT canonical-schema precondition + scope integrity (ADR-0051 §3/§4).
        ...schemaRoutes(),
        ...SCOPE_CLEAN,
        [/SELECT \* FROM spaces/i, [[]]],
        [/INSERT INTO spaces/i, (() => { let id = 300; return () => [{ insertId: id++ }]; })()],
        [/INSERT INTO space_bindings/i, [{ insertId: 400, affectedRows: 1 }]],
        [/UPDATE spaces SET status/i, [{}]],
        // (Prompt 4) ativos persistentes
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
    inventoryPayload = INVENTORY_ALL_VALID;
    // The ordinary Flask bridge now emits the lossless spaceOccurrences list; the
    // write path requires it. Derive it from the inventory dict for each mock.
    (globalThis as any).fetch = async () => ({ ok: true, json: async () => ({ data: inventoryPayload, spaceOccurrences: occurrencesFromInventory(inventoryPayload), schema: "IFC4X3_ADD2" }) });
    fs.rmSync(path.join(STORAGE_ROOT, `models/${MODEL_ID}`), { recursive: true, force: true });
});

/* ---- §6.B: a Reference change on a REUSED space is RESTORED when the upload
        later fails (deleting orphan spaces cannot undo an UPDATE to an existing row). ---- */
const GA_VALID = "3VKKG6_QDBqgUlHMH5Q4EB";
const INVENTORY_ONE_REUSED = {
    [GA_VALID]: { spaceGuid: GA_VALID, spaceName: "R-NEW", spaceLongName: null,
        psets: {}, elements: [] },
};

test("§6.B: failed binding creation on a reused space restores its prior inventory code (from IfcSpace.Name)", async () => {
    inventoryPayload = INVENTORY_ONE_REUSED;
    const base = routes();
    // Reused existing space (GlobalId match) currently holding R-OLD; new Reference
    // R-NEW is free; the UPDATE succeeds; then the BINDING insert fails → compensation
    // must restore R-OLD (conditional on our applied R-NEW still being current).
    respond([
        [/SELECT \* FROM spaces[\s\S]*BINARY ifc_global_id = BINARY/i,
            [[{ id: 55, space_uuid: "u55", inventory_code: "R-OLD", inventory_code_normalized: "R-OLD", name: "Old" }]]],
        [/SELECT \* FROM spaces[\s\S]*inventory_code_normalized/i, [[]]],
        [/INSERT INTO space_bindings/i, () => { throw new Error("boom binding"); }],
        ...base,
    ]);
    const temp = makeTempIfc();
    await assert.rejects(handleModelUpload({ tempFilePath: temp, originalFilename: "v.ifc", modelId: MODEL_ID }));

    // The administrative Reference was updated to R-NEW during persistence…
    const applied = fakeConnection.calls.filter((c) => /UPDATE spaces\s+SET inventory_code/i.test(c.sql) && !/:appliedInventoryCodeNormalized/i.test(c.sql));
    assert.equal(applied.length, 1, "current Reference was updated to R-NEW");
    assert.equal(applied[0]!.params.inventoryCodeNormalized, "R-NEW");
    // …and the compensation issued a CONDITIONAL restore back to R-OLD (byte-exact CAS).
    const restore = fakeConnection.calls.filter((c) => /UPDATE spaces\s+SET inventory_code[\s\S]*BINARY inventory_code_normalized = BINARY :appliedInventoryCodeNormalized/i.test(c.sql));
    assert.equal(restore.length, 1, "prior Reference restored by compensation");
    assert.equal(restore[0]!.params.spaceId, 55);
    assert.equal(restore[0]!.params.previousInventoryCodeNormalized, "R-OLD");
    assert.equal(restore[0]!.params.appliedInventoryCodeNormalized, "R-NEW");
    // spaces.id / space_uuid are never modified; no space row deleted for the reused space.
    assert.equal(fakeConnection.callsMatching(/INSERT INTO spaces/i).length, 0, "reused space is never recreated");
});

/* ---- §1/§2: the lossless occurrence contract is MANDATORY for writes, and the
       pure GlobalId preflight runs BEFORE saveInventorySnapshot (no entity written). ---- */

test("§1: ordinary bridge WITHOUT spaceOccurrences → blocked (lossless_space_occurrences_missing), nothing written", async () => {
    respond(routes());
    // Simulate an OLD Flask that does not emit the lossless list.
    (globalThis as any).fetch = async () => ({ ok: true, json: async () => ({ data: INVENTORY_ALL_VALID, schema: "IFC4X3_ADD2" }) });
    const temp = makeTempIfc();
    let caught: any = null;
    try { await handleModelUpload({ tempFilePath: temp, originalFilename: "x.ifc", modelId: MODEL_ID }); assert.fail("should reject"); }
    catch (e) { caught = e; }
    assert.equal(caught.code, "lossless_space_occurrences_missing");
    assert.equal(caught.statusCode, 422);
    // Nothing persisted: the block happens before saveInventorySnapshot.
    assert.equal(fakeConnection.callsMatching(/INSERT INTO entities/i).length, 0);
    assert.equal(fakeConnection.callsMatching(/INSERT INTO spaces/i).length, 0);
    assert.equal(fakeConnection.callsMatching(/INSERT INTO space_bindings/i).length, 0);
    assert.equal(fakeConnection.callsMatching(/INSERT INTO assets/i).length, 0);
});

test("§2: duplicate EXACT GlobalId (lossless) → blocked BEFORE entity persistence; no entities/spaces/bindings/assets/Reference UPDATE", async () => {
    respond(routes());
    const GA = "3VKKG6_QDBqgUlHMH5Q4EB";
    // The dict is GlobalId-keyed and collapses to one entry; the lossless list retains
    // BOTH occurrences of the same exact GlobalId.
    (globalThis as any).fetch = async () => ({ ok: true, json: async () => ({
        data: { [GA]: { spaceGuid: GA, spaceName: "A", psets: { Pset_SpaceCommon: { Reference: "R-1" } }, elements: [] } },
        spaceOccurrences: [
            { entityId: 1, guid: GA, name: "A1", longName: null, psets: { Pset_SpaceCommon: { Reference: "R-1" } } },
            { entityId: 2, guid: GA, name: "A2", longName: null, psets: { Pset_SpaceCommon: { Reference: "R-1" } } },
        ],
        schema: "IFC4X3_ADD2",
    }) });
    const temp = makeTempIfc();
    let caught: any = null;
    try { await handleModelUpload({ tempFilePath: temp, originalFilename: "x.ifc", modelId: MODEL_ID }); assert.fail("should reject"); }
    catch (e) { caught = e; }
    assert.equal(caught.code, "duplicate_candidate_globalid");
    assert.equal(fakeConnection.callsMatching(/INSERT INTO entities/i).length, 0, "no entity written for a duplicate GlobalId");
    assert.equal(fakeConnection.callsMatching(/INSERT INTO spaces/i).length, 0);
    assert.equal(fakeConnection.callsMatching(/INSERT INTO space_bindings/i).length, 0);
    assert.equal(fakeConnection.callsMatching(/INSERT INTO assets/i).length, 0);
    assert.equal(fakeConnection.callsMatching(/UPDATE spaces\s+SET inventory_code/i).length, 0, "no administrative Reference UPDATE");
});

/** Asserções comuns às falhas de preflight: NADA persistido, compensação completa. */
async function expectPreflightFailure(temp: string, messagePattern: RegExp, _reasonPattern: RegExp, statusCode = 422) {
    let caught: any = null;
    try {
        await handleModelUpload({ tempFilePath: temp, originalFilename: "x.ifc", modelId: MODEL_ID });
        assert.fail("devia rejeitar");
    } catch (error: any) {
        caught = error;
    }

    assert.match(caught.message, messagePattern);
    assert.equal(caught.statusCode, statusCode, "erro estruturado com 422 para o frontend");

    // validação ANTES da persistência: nem entities, nem assets, nem spaces, nem bindings
    assert.equal(fakeConnection.callsMatching(/INSERT INTO entities/i).length, 0);
    assert.equal(fakeConnection.callsMatching(/INSERT INTO assets/i).length, 0);
    assert.equal(fakeConnection.callsMatching(/INSERT INTO spaces/i).length, 0);
    assert.equal(fakeConnection.callsMatching(/INSERT INTO space_bindings/i).length, 0);

    // versão anterior permanece corrente; nova versão failed com etapa correta
    assert.equal(fakeConnection.callsMatching(/UPDATE models SET current_version_id/i).length, 0);
    // (Revisão P4) a etapa consolidada é model_requirements_preflight com
    // requirement IDs estáveis; as MENSAGENS espaciais são preservadas
    const failed = fakeConnection.callsMatching(/SET status = 'failed'/i)[0]!;
    assert.match(String(failed.params.reason), /^model_requirements_preflight: SPACE-00\d/);

    // ficheiro promovido compensado; temporário limpo
    assert.ok(!fs.existsSync(path.join(STORAGE_ROOT, `models/${MODEL_ID}/versions/${VERSION_ID}`)));
    assert.ok(!fs.existsSync(temp));
}

/* -------------------------------------
   REGRA ESTRITA (modelo autoritativo)
------------------------------------- */

test("autoritativo sem nenhum IfcSpace → rejeitado no preflight, nada persistido, corrente preservada", async () => {
    inventoryPayload = {};
    respond(routes());
    await expectPreflightFailure(makeTempIfc(), /contains no IfcSpace elements/, /no IfcSpace found/);
});

test("autoritativo com UM espaço sem IfcSpace.Name entre válidos → rejeitado (sem aceitação parcial), com contagem", async () => {
    inventoryPayload = INVENTORY_ONE_MISSING;
    respond(routes());
    await expectPreflightFailure(makeTempIfc(),
        /1 of 3 IfcSpace elements are missing a valid IfcSpace\.Name/,
        /1 of 3/);
});

test("autoritativo com códigos duplicados → rejeitado no preflight (antes da persistência)", async () => {
    inventoryPayload = INVENTORY_DUPLICATED;
    respond(routes());
    await expectPreflightFailure(makeTempIfc(),
        /Duplicate space inventory code\(s\).*R-DUP/,
        /duplicate inventory code/);
});

test("autoritativo com todos os espaços válidos → passa: spaces/bindings antes da ativação, reconciliação depois", async () => {
    respond(routes());
    const temp = makeTempIfc();

    await handleModelUpload({ tempFilePath: temp, originalFilename: "fixture.ifc", modelId: MODEL_ID });

    assert.equal(fakeConnection.callsMatching(/INSERT INTO entities/i).length, 2);
    assert.equal(fakeConnection.callsMatching(/INSERT INTO spaces/i).length, 2);
    assert.equal(fakeConnection.callsMatching(/INSERT INTO space_bindings/i).length, 2);
    assert.equal(fakeConnection.callsMatching(/INSERT INTO assets/i).length, 0, "ADR-0052 §F: um IfcSpace nunca vira ativo");
    assert.equal(fakeConnection.callsMatching(/INSERT INTO asset_bindings/i).length, 0, "sem asset-binding de espaço");

    const sqls = fakeConnection.calls.map((c) => c.sql);
    const lastBinding = sqls.map((s, i) => (/INSERT INTO space_bindings/i.test(s) ? i : -1)).filter((i) => i >= 0).pop()!;
    const activation = sqls.findIndex((s) => /UPDATE models SET current_version_id/i.test(s));
    const reconcile = sqls.findIndex((s) => /UPDATE spaces SET status/i.test(s));
    assert.ok(lastBinding < activation, "bindings antes da ativação");
    assert.ok(reconcile > activation, "reconciliação após a ativação");

    assert.ok(!fs.existsSync(temp), "temporário removido");
});

/* -------------------------------------
   MODELOS NÃO AUTORITATIVOS (disciplinares) PRESERVADOS
------------------------------------- */

test("não autoritativo sem IfcSpace → upload permitido (modelos disciplinares numa federação)", async () => {
    inventoryPayload = {};
    respond(routes("other"));
    const temp = makeTempIfc();

    await handleModelUpload({ tempFilePath: temp, originalFilename: "mep.ifc", modelId: MODEL_ID });

    assert.equal(fakeConnection.callsMatching(/UPDATE models SET current_version_id/i).length, 1, "ativado normalmente");
});

// (ADR-0052 §F) Um IfcSpace nunca gera ativo, tenha ou não código de inventário;
// só os espaços com Name (código) são persistidos como CONTEXTO espacial.
test("não autoritativo com espaço sem Name → upload segue; espaços com identidade persistem como contexto, zero ativos", async () => {
    inventoryPayload = INVENTORY_ONE_MISSING;
    respond(routes("other"));
    const temp = makeTempIfc();

    await handleModelUpload({ tempFilePath: temp, originalFilename: "arq.ifc", modelId: MODEL_ID });

    assert.equal(fakeConnection.callsMatching(/INSERT INTO entities/i).length, 3);
    assert.equal(fakeConnection.callsMatching(/INSERT INTO spaces/i).length, 2, "só os com código viram espaços");
    assert.equal(fakeConnection.callsMatching(/INSERT INTO assets/i).length, 0,
        "ADR-0052 §F: nenhum espaço vira ativo");
    assert.equal(fakeConnection.callsMatching(/INSERT INTO asset_bindings/i).length, 0);
});

test("modelo sem federação (linked_parent_id NULL): sem validação estrita nem identidade", async () => {
    const r = routes();
    r[0] = [/SELECT\s+id,[\s\S]*FROM models[\s\S]*WHERE id = :id/i, [[{ id: MODEL_ID, name: "M", linked_parent_id: null }]]];
    inventoryPayload = {};
    respond(r);
    const temp = makeTempIfc();

    await handleModelUpload({ tempFilePath: temp, originalFilename: "solo.ifc", modelId: MODEL_ID });

    assert.equal(fakeConnection.callsMatching(/INSERT INTO spaces/i).length, 0);
    assert.equal(fakeConnection.callsMatching(/UPDATE models SET current_version_id/i).length, 1);
});

/* -------------------------------------
   SEPARAÇÃO IDENTIDADE / POLÍTICA
------------------------------------- */

test("Reference não altera reservabilidade: evaluator deny-all não impede spaces/bindings", async () => {
    providers.setReservabilityEvaluator({
        evaluate: async () => ({ decision: "deny", reasons: ["mock"], evaluatorId: "mock", evaluatedAt: new Date().toISOString() }),
    });
    respond(routes());
    const temp = makeTempIfc();

    await handleModelUpload({ tempFilePath: temp, originalFilename: "fixture.ifc", modelId: MODEL_ID });

    assert.equal(fakeConnection.callsMatching(/INSERT INTO assets/i).length, 0, "política nega ativos");
    assert.equal(fakeConnection.callsMatching(/INSERT INTO spaces/i).length, 2, "identidade persiste na mesma");
});

test("provider substituível: outra fonte de identidade satisfaz a regra estrita sem alterar o pipeline", async () => {
    // Mock que identifica espaços por outra fonte (sem Pset_SpaceCommon)
    identityProvider.setSpaceIdentityResolver({
        resolve: async (c) => ({
            status: "valid", rawValue: `EXT-${c.guid}`, normalizedValue: `EXT-${c.guid}`,
            source: "ExternalRegistry.Id", reasons: [], resolverId: "mock-external",
            resolvedAt: new Date().toISOString(), guid: c.guid,
        }),
    });
    inventoryPayload = INVENTORY_ONE_MISSING; // sem pset num espaço — irrelevante para a fonte externa
    respond(routes());
    const temp = makeTempIfc();

    await handleModelUpload({ tempFilePath: temp, originalFilename: "fixture.ifc", modelId: MODEL_ID });

    assert.equal(fakeConnection.callsMatching(/INSERT INTO spaces/i).length, 3, "3 espaços identificados pela fonte externa");
    const insert = fakeConnection.callsMatching(/INSERT INTO spaces/i)[0]!;
    assert.match(String(insert.params.inventoryCode), /^EXT-/);
});
