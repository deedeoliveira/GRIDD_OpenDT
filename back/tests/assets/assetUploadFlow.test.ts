/**
 * Integração dos ativos persistentes no fluxo de upload (Prompt 4):
 * etapa de reconciliação antes da ativação, identidade estável entre
 * versões, casos pendentes não bloqueiam a ativação, compensações.
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { installFakeMySQL, fakeConnection, respond } from "../helpers/fakeDb.ts";

installFakeMySQL();
process.env.IFCOPENSHELL_FLASK_API_ROUTE ??= "http://flask.test/api";
process.env.PORT ??= "3001";

const { handleModelUpload } = await import("../../services/modelUploadService.ts");
const providers = await import("../../policies/policyProvider.ts");
const identityProvider = await import("../../identity/assetIdentityProvider.ts");
const classifierProvider = await import("../../classification/equipmentClassifierProvider.ts");
const requirementsProvider = await import("../../requirements/modelRequirementsProvider.ts");
const { STORAGE_ROOT } = await import("../../utils/storage.ts");

const MODEL_ID = 999501;
const VERSION_ID = 999601;

/** 1 espaço válido + 1 equipamento com Tag EQP- + 1 sensor com Tag. */
const INVENTORY = {
    "space-A": {
        spaceGuid: "space-A", spaceName: "Sala A", spaceLongName: "Sala Grande A",
        psets: { Pset_SpaceCommon: { Reference: "R-A" } },
        elements: [
            { guid: "g-eq", type: "IfcFurniture", name: "Mesa 01", tag: "EQP-1", psets: {} },
            { guid: "g-sensor", type: "IfcSensor", name: "Sensor T", tag: "EQP-SEN-1", psets: {} },
        ],
    },
};

/** Versão posterior: mesma Tag mas serial DIVERGENTE (caso de reconciliação). */
const INVENTORY_SERIAL_CONFLICT = {
    "space-A": {
        spaceGuid: "space-A", spaceName: "Sala A", spaceLongName: null,
        psets: { Pset_SpaceCommon: { Reference: "R-A" } },
        elements: [{ guid: "g-eq2", type: "IfcFurniture", name: "Mesa substituída", tag: "EQP-1",
                     psets: { Pset_ManufacturerOccurrence: { SerialNumber: "SN-NOVO" } } }],
    },
};

/** Equipamento gerido SEM Tag (deve falhar no preflight EQUIPMENT-001). */
const INVENTORY_MISSING_TAG = {
    "space-A": {
        spaceGuid: "space-A", spaceName: "Sala A", spaceLongName: null,
        psets: { Pset_SpaceCommon: { Reference: "R-A" } },
        elements: [{ guid: "g-semtag", type: "IfcFurniture", name: "Mesa sem tag", psets: {} }],
    },
};

/** Proxy sem ObjectType (deve falhar no preflight PROXY-001). */
const INVENTORY_INVALID_PROXY = {
    "space-A": {
        spaceGuid: "space-A", spaceName: "Sala A", spaceLongName: null,
        psets: { Pset_SpaceCommon: { Reference: "R-A" } },
        elements: [{ guid: "g-px", type: "IfcBuildingElementProxy", name: "Proxy", tag: "EQP-9", psets: {} }],
    },
};

const realFetch = globalThis.fetch;
let inventoryPayload: any = INVENTORY;

after(() => {
    (globalThis as any).fetch = realFetch;
    fs.rmSync(path.join(STORAGE_ROOT, `models/${MODEL_ID}`), { recursive: true, force: true });
});

function makeTempIfc(): string {
    const p = path.join(os.tmpdir(), `oswadt-assets-${Date.now()}-${Math.random().toString(36).slice(2)}.ifc`);
    fs.writeFileSync(p, "ISO-10303-21; fixture");
    return p;
}

function routes(overrides: [RegExp, any][] = []): [RegExp, any][] {
    let entityId = 800;
    return [
        ...overrides,
        [/SELECT\s+id,[\s\S]*FROM models[\s\S]*WHERE id = :id/i, [[{ id: MODEL_ID, name: "M", linked_parent_id: 10 }]]],
        [/SELECT id FROM models WHERE id = :modelId FOR UPDATE/i, [[{ id: MODEL_ID }]]],
        [/COALESCE\(MAX\(version_number\), 0\) \+ 1/i, [[{ next: 2 }]]],
        [/INSERT INTO model_versions/i, [{ insertId: VERSION_ID }]],
        [/UPDATE model_versions SET storage_key/i, [{}]],
        [/spatial_authority_model_id/i, [[{ spatial_authority_model_id: null, model_count: 1, single_model_id: MODEL_ID }]]],
        [/SELECT COUNT\(\*\) as count[\s\S]*FROM entities/i, [[{ count: 0 }]]],
        [/INSERT INTO entities/i, () => [{ insertId: entityId++ }]],
        [/SELECT \* FROM spaces/i, [[]]],
        [/INSERT INTO spaces/i, [{ insertId: 300 }]],
        [/INSERT INTO space_bindings/i, [{ insertId: 400 }]],
        [/UPDATE spaces SET status/i, [{}]],
        [/SELECT \* FROM assets WHERE space_id/i, [[]]],
        [/FROM assets[\s\S]*asset_code = :tag/i, [[]]],
        [/FROM assets[\s\S]*serial_number = :serial/i, [[]]],
        [/INSERT INTO assets/i, (() => { let id = 600; return () => [{ insertId: id++ }]; })()],
        [/INSERT INTO asset_bindings/i, [{ insertId: 700 }]],
        [/INSERT INTO asset_reconciliation_cases/i, [{ insertId: 900 }]],
        [/UPDATE assets/i, [{}]],
        [/SELECT id, status FROM model_versions WHERE id = :versionId AND model_id = :modelId FOR UPDATE/i,
            [[{ id: VERSION_ID, status: "processing" }]]],
        [/SELECT current_version_id FROM models WHERE id = :modelId FOR UPDATE/i, [[{ current_version_id: 42 }]]],
        [/UPDATE model_versions SET status = 'active'/i, [{}]],
        [/UPDATE model_versions SET status = 'archived'/i, [{}]],
        [/UPDATE models SET current_version_id/i, [{}]],
        [/UPDATE model_versions[\s\S]*SET status = 'failed'/i, [{}]],
        [/DELETE FROM/i, [{}]],
    ];
}

beforeEach(() => {
    fakeConnection.reset();
    providers.resetPolicyProviders();
    identityProvider.resetAssetIdentityResolver();
    classifierProvider.resetEquipmentClassifier();
    requirementsProvider.resetModelRequirementsValidator();
    delete process.env.ASSET_IDENTITY_PROVIDER;
    inventoryPayload = INVENTORY;
    (globalThis as any).fetch = async () => ({ ok: true, json: async () => ({ data: inventoryPayload }) });
    fs.rmSync(path.join(STORAGE_ROOT, `models/${MODEL_ID}`), { recursive: true, force: true });
});

/* -------------------------------------
   SUCESSO
------------------------------------- */

test("primeira versão: cria ativos persistentes + bindings ANTES da ativação; ciclo de vida reconciliado DEPOIS", async () => {
    respond(routes());
    const temp = makeTempIfc();

    await handleModelUpload({ tempFilePath: temp, originalFilename: "v1.ifc", modelId: MODEL_ID });

    // espaço + equipamento EQ-1; sensor negado pela política (comportamento legado)
    assert.equal(fakeConnection.callsMatching(/INSERT INTO assets/i).length, 2);
    assert.equal(fakeConnection.callsMatching(/INSERT INTO asset_bindings/i).length, 2);
    assert.equal(fakeConnection.callsMatching(/INSERT INTO asset_reconciliation_cases/i).length, 0);

    const sqls = fakeConnection.calls.map((c) => c.sql);
    const lastBinding = sqls.map((s, i) => (/INSERT INTO asset_bindings/i.test(s) ? i : -1)).filter((i) => i >= 0).pop()!;
    const activation = sqls.findIndex((s) => /UPDATE models SET current_version_id/i.test(s));
    const lifecycle = sqls.findIndex((s) => /UPDATE assets[\s\S]*'absent'/i.test(s));
    assert.ok(lastBinding < activation, "bindings antes da ativação");
    assert.ok(lifecycle > activation, "ciclo de vida reconciliado após a ativação");
});

test("nova versão do mesmo modelo: identidades reutilizadas (0 ativos novos), bindings novos apontam para os MESMOS asset_id", async () => {
    respond(routes([
        [/SELECT \* FROM assets WHERE space_id/i, [[{ id: 55, name: "Sala A" }]]],
        [/FROM assets[\s\S]*asset_code = :tag/i, (sql: string, params: any) =>
            [[{ id: params.tag === "EQP-1" ? 77 : 78, asset_code: params.tag, serial_number: null }]]],
    ]));
    const temp = makeTempIfc();

    await handleModelUpload({ tempFilePath: temp, originalFilename: "v2.ifc", modelId: MODEL_ID });

    assert.equal(fakeConnection.callsMatching(/INSERT INTO assets/i).length, 0,
        "invariante: nova versão NUNCA cria nova identidade para o mesmo recurso");
    const bindings = fakeConnection.callsMatching(/INSERT INTO asset_bindings/i);
    assert.deepEqual(bindings.map((b) => b.params.assetId).sort(), [55, 77, 78], "Mesa=77, Sensor=78 pela Tag");
    assert.equal(fakeConnection.callsMatching(/UPDATE models SET current_version_id/i).length, 1);
});

test("mesma Tag com serial divergente em versão posterior: caso de reconciliação aberto e a versão ATIVA na mesma (inventário incompleto sinalizado)", async () => {
    inventoryPayload = INVENTORY_SERIAL_CONFLICT;
    respond(routes([
        [/SELECT \* FROM assets WHERE space_id/i, [[{ id: 55 }]]],
        [/FROM assets[\s\S]*asset_code = :tag/i, [[{ id: 77, asset_code: "EQP-1", serial_number: "SN-VELHO" }]]],
    ]));
    const temp = makeTempIfc();

    await handleModelUpload({ tempFilePath: temp, originalFilename: "v3.ifc", modelId: MODEL_ID });

    assert.equal(fakeConnection.callsMatching(/INSERT INTO asset_reconciliation_cases/i).length, 1);
    assert.equal(fakeConnection.callsMatching(/INSERT INTO assets/i).length, 0, "sem merge nem ativo especulativo");
    assert.equal(fakeConnection.callsMatching(/UPDATE models SET current_version_id/i).length, 1,
        "a geometria fica disponível; o elemento pendente é que não é reservável");
});

/* -------------------------------------
   PREFLIGHT DE EQUIPAMENTOS/PROXIES (falha ANTES de qualquer persistência)
------------------------------------- */

async function expectRequirementsFailure(inventory: any, requirementId: string, messagePattern: RegExp) {
    inventoryPayload = inventory;
    respond(routes());
    const temp = makeTempIfc();

    let caught: any = null;
    try {
        await handleModelUpload({ tempFilePath: temp, originalFilename: "x.ifc", modelId: MODEL_ID });
        assert.fail("devia rejeitar");
    } catch (error: any) { caught = error; }

    assert.equal(caught.statusCode, 422, "erro estruturado 422 (sem stack trace para o frontend)");
    assert.match(caught.message, messagePattern);

    // zero dados parciais: nem entities, nem assets, nem bindings, nem casos
    assert.equal(fakeConnection.callsMatching(/INSERT INTO entities/i).length, 0);
    assert.equal(fakeConnection.callsMatching(/INSERT INTO assets/i).length, 0);
    assert.equal(fakeConnection.callsMatching(/INSERT INTO asset_bindings/i).length, 0);
    assert.equal(fakeConnection.callsMatching(/INSERT INTO asset_reconciliation_cases/i).length, 0);
    assert.equal(fakeConnection.callsMatching(/UPDATE res_reservations/i).length, 0, "reservas intocadas");

    // versão anterior permanece corrente; failed com etapa + requirement ID
    assert.equal(fakeConnection.callsMatching(/UPDATE models SET current_version_id/i).length, 0);
    const failed = fakeConnection.callsMatching(/SET status = 'failed'/i)[0]!;
    assert.match(String(failed.params.reason), new RegExp(`^model_requirements_preflight: .*${requirementId}`));

    // compensação de ficheiros
    assert.ok(!fs.existsSync(path.join(STORAGE_ROOT, `models/${MODEL_ID}/versions/${VERSION_ID}`)));
    assert.ok(!fs.existsSync(temp));
}

test("equipamento gerido sem Tag → 422 EQUIPMENT-001, nada persistido, corrente preservada", async () => {
    await expectRequirementsFailure(INVENTORY_MISSING_TAG, "EQUIPMENT-001",
        /managed equipment candidate without an IfcElement\.Tag/);
});

test("proxy sem ObjectType → 422 PROXY-001 com diagnóstico (classe, guid, nome, motivo)", async () => {
    await expectRequirementsFailure(INVENTORY_INVALID_PROXY, "PROXY-001",
        /IfcBuildingElementProxy without a valid ObjectType/);
});

test("proxy com ObjectType mas Tag inválida → 422 PROXY-002", async () => {
    const inventory = JSON.parse(JSON.stringify(INVENTORY_INVALID_PROXY));
    inventory["space-A"].elements[0] = { guid: "g-px", type: "IfcBuildingElementProxy",
        name: "Proxy", tag: "SEM-PREFIXO", objectType: "Betoneira", psets: {} };
    await expectRequirementsFailure(inventory, "PROXY-002",
        /without a valid equipment Tag starting with EQP-/);
});

test("Tags duplicadas na mesma versão → 422 EQUIPMENT-003", async () => {
    const inventory = JSON.parse(JSON.stringify(INVENTORY));
    inventory["space-A"].elements = [
        { guid: "g-1", type: "IfcFurniture", name: "Mesa A", tag: "EQP-DUP", psets: {} },
        { guid: "g-2", type: "IfcFurniture", name: "Mesa B", tag: "EQP-DUP", psets: {} },
    ];
    await expectRequirementsFailure(inventory, "EQUIPMENT-003", /Duplicate equipment inventory Tag/);
});

/* -------------------------------------
   FALHAS E COMPENSAÇÕES
------------------------------------- */

test("falha na etapa de bindings: failure_reason 'asset_binding:', compensação limpa bindings/casos e SÓ os ativos criados (com guardas), corrente preservada", async () => {
    respond(routes([[/INSERT INTO asset_bindings/i, () => { throw new Error("binding falhou"); }]]));
    const temp = makeTempIfc();

    await assert.rejects(
        handleModelUpload({ tempFilePath: temp, originalFilename: "x.ifc", modelId: MODEL_ID }),
        /binding falhou/
    );

    const failed = fakeConnection.callsMatching(/SET status = 'failed'/i)[0]!;
    assert.match(String(failed.params.reason), /^asset_binding: binding falhou/);

    assert.ok(fakeConnection.callsMatching(/DELETE FROM asset_bindings/i).length >= 1);
    assert.ok(fakeConnection.callsMatching(/DELETE FROM asset_reconciliation_cases/i).length >= 1);
    const assetDelete = fakeConnection.callsMatching(/DELETE FROM assets\s+WHERE id = :assetId/i)[0]!;
    assert.match(assetDelete.sql, /NOT EXISTS \(SELECT 1 FROM res_reservations/i,
        "um ativo com reservas nunca é removido pela compensação");

    assert.equal(fakeConnection.callsMatching(/UPDATE models SET current_version_id/i).length, 0);
    assert.ok(!fs.existsSync(path.join(STORAGE_ROOT, `models/${MODEL_ID}/versions/${VERSION_ID}`)));
    assert.ok(!fs.existsSync(temp));
});

test("falha na política durante a etapa de ativos: failure_reason 'asset_policy:'", async () => {
    providers.setReservabilityEvaluator({
        evaluate: async () => { throw new Error("policy provider caiu"); },
    });
    respond(routes());
    const temp = makeTempIfc();

    await assert.rejects(
        handleModelUpload({ tempFilePath: temp, originalFilename: "x.ifc", modelId: MODEL_ID }),
        /policy provider caiu/
    );

    const failed = fakeConnection.callsMatching(/SET status = 'failed'/i)[0]!;
    assert.match(String(failed.params.reason), /^asset_policy: /);
});
