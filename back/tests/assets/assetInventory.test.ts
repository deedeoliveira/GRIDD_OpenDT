/**
 * Inventário persistente de ativos (Prompt 4) — assetInventoryService.
 *
 * Invariantes cobertas:
 *  - ativo-espaço: mesma identidade (spaces.id) em todas as versões; espaço
 *    sem identidade persistente NÃO gera ativo;
 *  - equipamento: matched atualiza projeção e cria binding (NUNCA novo asset);
 *    ambiguous/unresolved → caso de reconciliação SEM asset nem binding;
 *  - política: deny em candidato NOVO → sem ativo (comportamento legado);
 *    deny/undetermined em ativo EXISTENTE → apenas projeção reservable=0;
 *  - versão explícita em todos os bindings; nunca ORDER BY id DESC.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeMySQL, fakeConnection, respond } from "../helpers/fakeDb.ts";

installFakeMySQL();

const { persistAssetsForVersion, reconcileAssetLifecycleAfterActivation, AssetStageError } =
    await import("../../services/assetInventoryService.ts");
const persistentAssetDb = (await import("../../utils/persistentAssetDatabase.ts")).default;
const providers = await import("../../policies/policyProvider.ts");
const identityProvider = await import("../../identity/assetIdentityProvider.ts");
const classifierProvider = await import("../../classification/equipmentClassifierProvider.ts");

beforeEach(() => {
    fakeConnection.reset();
    providers.resetPolicyProviders();
    identityProvider.resetAssetIdentityResolver();
    classifierProvider.resetEquipmentClassifier();
    delete process.env.ASSET_IDENTITY_PROVIDER;
});

const VERSION_ID = 9;

function makeInput(overrides: Partial<Record<string, any>> = {}) {
    return {
        linkedModelId: 10,
        modelId: 20,
        modelVersionId: VERSION_ID,
        inventoryData: {
            "space-A": {
                spaceGuid: "space-A", spaceName: "Sala A", spaceLongName: "Sala Grande A",
                elements: [],
            },
        },
        spaceEntityIdsByGuid: { "space-A": 100 },
        elementEntityIdsByGuid: {},
        spaceInfoByGuid: { "space-A": { spaceId: 7, code: "R-A" } },
        ...overrides,
    };
}

/** Rotas base: nenhum ativo existente, primeira versão da linha. */
function baseRoutes(overrides: [RegExp, any][] = []): [RegExp, any][] {
    return [
        ...overrides,
        [/SELECT \* FROM assets WHERE space_id/i, [[]]],
        [/FROM assets[\s\S]*asset_code = :tag/i, [[]]],
        [/FROM assets[\s\S]*serial_number = :serial/i, [[]]],
        [/INSERT INTO assets/i, (() => { let id = 300; return () => [{ insertId: id++ }]; })()],
        [/INSERT INTO asset_bindings/i, [{ insertId: 400 }]],
        [/INSERT INTO asset_reconciliation_cases/i, [{ insertId: 900 }]],
        [/UPDATE assets/i, [{}]],
    ];
}

/* -------------------------------------
   ESPAÇOS NÃO SÃO ATIVOS (ADR-0052 §F)
------------------------------------- */

test("espaços NUNCA geram ativos: três espaços, zero equipamento → zero assets, zero bindings, zero casos", async () => {
    respond(baseRoutes());

    const outcome = await persistAssetsForVersion(makeInput({
        inventoryData: {
            "space-A": { spaceGuid: "space-A", spaceName: "Sala A", spaceLongName: "Sala Grande A", elements: [] },
            "space-B": { spaceGuid: "space-B", spaceName: "Sala B", spaceLongName: null, elements: [] },
            "space-C": { spaceGuid: "space-C", spaceName: "Sala C", spaceLongName: "Sala C longa", elements: [] },
        },
        spaceEntityIdsByGuid: { "space-A": 100, "space-B": 101, "space-C": 102 },
        spaceInfoByGuid: {
            "space-A": { spaceId: 7, code: "R-A" },
            "space-B": { spaceId: 8, code: "R-B" },
            "space-C": { spaceId: 9, code: "R-C" },
        },
    }) as any);

    assert.equal(fakeConnection.callsMatching(/INSERT INTO assets/i).length, 0, "um IfcSpace nunca cria um asset");
    assert.equal(fakeConnection.callsMatching(/INSERT INTO asset_bindings/i).length, 0, "sem asset-binding de espaço");
    assert.equal(fakeConnection.callsMatching(/asset_type\s*=\s*'space'|'IfcSpace'/i).length, 0);
    assert.equal(outcome.createdAssetIds.length, 0);
    assert.equal(outcome.bindingsCreated, 0);
    assert.equal(outcome.casesCreated, 0);
});

test("mudança de Name/LongName do espaço não cria ativo", async () => {
    respond(baseRoutes());
    const outcome = await persistAssetsForVersion(makeInput({
        inventoryData: { "space-A": { spaceGuid: "space-A", spaceName: "Sala A RENOMEADA", spaceLongName: "Novo rótulo", elements: [] } },
    }) as any);
    assert.equal(fakeConnection.callsMatching(/INSERT INTO assets/i).length, 0);
    assert.equal(outcome.createdAssetIds.length, 0);
});

/* -------------------------------------
   EQUIPAMENTOS: correspondência e não-fusão
------------------------------------- */

function equipmentInput(element: Record<string, any>) {
    return makeInput({
        inventoryData: {
            "space-A": { spaceGuid: "space-A", spaceName: "Sala A", elements: [element] },
        },
        elementEntityIdsByGuid: { [element.guid]: 101 },
    });
}

test("equipamento matched pela Tag: atualiza projeção e cria binding — NUNCA um novo asset", async () => {
    respond(baseRoutes([
        [/SELECT \* FROM assets WHERE space_id/i, [[{ id: 55 }]]],
        [/FROM assets[\s\S]*asset_code = :tag/i, [[{ id: 77, asset_code: "EQP-1", serial_number: null }]]],
    ]));

    await persistAssetsForVersion(equipmentInput({
        guid: "g-eq", type: "IfcFurniture", name: "Mesa 01 v2", tag: "EQP-1", psets: {},
    }) as any);

    assert.equal(fakeConnection.callsMatching(/INSERT INTO assets/i).length, 0);
    const binding = fakeConnection.callsMatching(/INSERT INTO asset_bindings/i).find((c) => c.params.assetId === 77)!;
    assert.equal(binding.params.reconciliationMethod, "equipment_tag");
    assert.equal(binding.params.assetCodeSnapshot, "EQP-1");
    assert.equal(binding.params.spaceEntityId, 100, "localização é atributo do binding, não da identidade");
});

test("mesma Tag + mesmo serial: matched forte; serial vai para snapshot separado (nunca para asset_code)", async () => {
    respond(baseRoutes([
        [/SELECT \* FROM assets WHERE space_id/i, [[{ id: 55 }]]],
        [/FROM assets[\s\S]*asset_code = :tag/i, [[{ id: 77, asset_code: "EQP-1", serial_number: "SN-9" }]]],
    ]));

    await persistAssetsForVersion(equipmentInput({
        guid: "g-eq", type: "IfcFurniture", name: "Mesa", tag: "EQP-1",
        psets: { Pset_ManufacturerOccurrence: { SerialNumber: "SN-9" } },
    }) as any);

    const binding = fakeConnection.callsMatching(/INSERT INTO asset_bindings/i).find((c) => c.params.assetId === 77)!;
    assert.equal(binding.params.reconciliationMethod, "tag_and_serial");
    assert.equal(binding.params.assetCodeSnapshot, "EQP-1");
    assert.equal(binding.params.serialSnapshot, "SN-9");
});

test("mesma Tag + serial diferente: caso de reconciliação; SEM asset e SEM binding (não reservável, não contorna reservas)", async () => {
    respond(baseRoutes([
        [/SELECT \* FROM assets WHERE space_id/i, [[{ id: 55 }]]],
        [/FROM assets[\s\S]*asset_code = :tag/i, [[{ id: 77, asset_code: "EQP-1", serial_number: "SN-OLD" }]]],
    ]));

    const outcome = await persistAssetsForVersion(equipmentInput({
        guid: "g-eq", type: "IfcFurniture", name: "Mesa", tag: "EQP-1",
        psets: { Pset_ManufacturerOccurrence: { SerialNumber: "SN-NEW" } },
    }) as any);

    assert.equal(outcome.casesCreated, 1);
    const kase = fakeConnection.callsMatching(/INSERT INTO asset_reconciliation_cases/i)[0]!;
    assert.equal(kase.params.ifcGuid, "g-eq");
    assert.match(kase.sql, /'open'/);
    assert.ok(JSON.parse(kase.params.candidatesJson).length === 1, "candidato registado para decisão humana");

    assert.equal(fakeConnection.callsMatching(/INSERT INTO assets/i).length, 0, "sem merge automático");
    assert.equal(fakeConnection.callsMatching(/INSERT INTO asset_bindings/i).filter((c) => c.params.assetId !== 55).length, 0);
});

test("mesmo serial + Tag diferente (renumeração): caso de reconciliação, sem asset novo", async () => {
    respond(baseRoutes([
        [/SELECT \* FROM assets WHERE space_id/i, [[{ id: 55 }]]],
        [/FROM assets[\s\S]*serial_number = :serial/i, [[{ id: 88, asset_code: "EQP-OUTRA", serial_number: "SN-9" }]]],
    ]));

    const outcome = await persistAssetsForVersion(equipmentInput({
        guid: "g-eq", type: "IfcFurniture", name: "Mesa", tag: "EQP-NOVA",
        psets: { Pset_ManufacturerOccurrence: { SerialNumber: "SN-9" } },
    }) as any);

    assert.equal(outcome.casesCreated, 1);
    assert.equal(fakeConnection.callsMatching(/INSERT INTO assets/i).length, 0);
});

test("classe fora do perfil (undetermined): entity preservada, SEM asset, diagnóstico explícito — nunca silenciosamente ignorado", async () => {
    respond(baseRoutes([[/SELECT \* FROM assets WHERE space_id/i, [[{ id: 55 }]]]]));

    const outcome = await persistAssetsForVersion(
        equipmentInput({ guid: "g-duto", type: "IfcDuctSegment", name: "Duto", tag: null, psets: {} }) as any);

    assert.equal(fakeConnection.callsMatching(/INSERT INTO assets/i).length, 0);
    assert.deepEqual(outcome.diagnostics.undetermined_classification, [{ guid: "g-duto", ifcClass: "IfcDuctSegment" }]);
});

test("elemento arquitetónico (IfcWall): entity apenas, sem asset, sem caso — não é candidato", async () => {
    respond(baseRoutes([[/SELECT \* FROM assets WHERE space_id/i, [[{ id: 55 }]]]]));

    const outcome = await persistAssetsForVersion(
        equipmentInput({ guid: "g-wall", type: "IfcWall", name: "Parede", tag: null, psets: {} }) as any);

    assert.equal(fakeConnection.callsMatching(/INSERT INTO assets/i).length, 0);
    assert.equal(outcome.casesCreated, 0);
    assert.deepEqual(outcome.diagnostics.non_equipment_elements,
        [{ guid: "g-wall", ifcClass: "IfcWall", classification: "architectural_element" }]);
});

test("equipamento NÃO-proxy: object_type_snapshot fica NULL mesmo quando o export traz ObjectType (sem efeito de domínio)", async () => {
    respond(baseRoutes([
        [/SELECT \* FROM assets WHERE space_id/i, [[{ id: 55 }]]],
        [/FROM assets[\s\S]*asset_code = :tag/i, [[{ id: 77, asset_code: "EQP-1", serial_number: null }]]],
    ]));

    await persistAssetsForVersion(equipmentInput({
        guid: "g-eq", type: "IfcBoiler", name: "Caldeira", tag: "EQP-1",
        objectType: "Caldeira Mural Exportada", psets: {},
    }) as any);

    const binding = fakeConnection.callsMatching(/INSERT INTO asset_bindings/i).find((c) => c.params.assetId === 77)!;
    assert.equal(binding.params.objectTypeSnapshot, null, "snapshot de ObjectType é exclusivo do proxy");
    assert.equal(binding.params.reconciliationMethod, "equipment_tag");
    assert.equal(binding.params.reconciliationConfidence, "high",
        "confiança vem da Tag/serial — ObjectType não participa");
});

test("mudar o ObjectType num equipamento não-proxy não altera identidade, reconciliação nem política", async () => {
    for (const objectType of [null, "Tipo A", "Tipo B Completamente Diferente"]) {
        fakeConnection.reset();
        respond(baseRoutes([
            [/SELECT \* FROM assets WHERE space_id/i, [[{ id: 55 }]]],
            [/FROM assets[\s\S]*asset_code = :tag/i, [[{ id: 77, asset_code: "EQP-1", serial_number: null }]]],
        ]));

        const outcome = await persistAssetsForVersion(equipmentInput({
            guid: "g-eq", type: "IfcBoiler", name: "Caldeira", tag: "EQP-1", objectType, psets: {},
        }) as any);

        assert.equal(fakeConnection.callsMatching(/INSERT INTO assets/i).length, 0, "sempre o MESMO ativo (77)");
        assert.equal(outcome.casesCreated, 0, "nunca vira caso de reconciliação por ObjectType");
        const binding = fakeConnection.callsMatching(/INSERT INTO asset_bindings/i).find((c) => c.params.assetId === 77)!;
        assert.equal(binding.params.reconciliationMethod, "equipment_tag");
    }
});

test("proxy válido segue o fluxo normal de equipamento: ObjectType vai para snapshot do binding, NUNCA para asset_code", async () => {
    respond(baseRoutes([[/SELECT \* FROM assets WHERE space_id/i, [[{ id: 55 }]]]]));

    await persistAssetsForVersion(equipmentInput({
        guid: "g-px", type: "IfcBuildingElementProxy", name: "Betoneira",
        tag: "EQP-000123", objectType: "Betoneira Diesel", psets: {},
    }) as any);

    const insert = fakeConnection.callsMatching(/INSERT INTO assets/i)[0]!;
    assert.equal(insert.params.assetCode, "EQP-000123", "asset_code = Tag");
    assert.notEqual(insert.params.assetCode, "Betoneira Diesel");

    const binding = fakeConnection.callsMatching(/INSERT INTO asset_bindings/i).find((c) => c.params.assetId !== 55)!;
    assert.equal(binding.params.objectTypeSnapshot, "Betoneira Diesel", "ObjectType preservado como snapshot");
});

/* -------------------------------------
   POLÍTICA: separada da identidade
------------------------------------- */

test("deny em candidato NOVO → comportamento legado: sem ativo (caso IfcSensor)", async () => {
    respond(baseRoutes([[/SELECT \* FROM assets WHERE space_id/i, [[{ id: 55 }]]]]));

    const outcome = await persistAssetsForVersion(
        equipmentInput({ guid: "g-sensor", type: "IfcSensor", name: "Sensor T", tag: "EQP-SEN-1", psets: {} }) as any);

    assert.deepEqual(outcome.diagnostics.policy_denied_new, ["g-sensor"]);
    assert.equal(fakeConnection.callsMatching(/INSERT INTO assets/i).length, 0);
});

test("deny/undetermined em ativo EXISTENTE → apenas projeção reservable=0; identidade e binding preservados", async () => {
    providers.setReservabilityEvaluator({
        evaluate: async () => ({ decision: "undetermined", reasons: ["mock"], evaluatorId: "mock", evaluatedAt: new Date().toISOString() }),
    });
    respond(baseRoutes([
        [/SELECT \* FROM assets WHERE space_id/i, [[{ id: 55 }]]],
        [/FROM assets[\s\S]*asset_code = :tag/i, [[{ id: 77, asset_code: "EQP-1", serial_number: null }]]],
    ]));

    const outcome = await persistAssetsForVersion(equipmentInput({
        guid: "g-eq", type: "IfcFurniture", name: "Mesa", tag: "EQP-1", psets: {},
    }) as any);

    const projections = fakeConnection.callsMatching(/UPDATE assets[\s\S]*SET name = COALESCE/i);
    assert.ok(projections.some((c) => c.params.assetId === 77 && c.params.reservable === false));
    assert.ok(fakeConnection.callsMatching(/INSERT INTO asset_bindings/i).some((c) => c.params.assetId === 77),
        "o binding continua a existir: identidade ≠ reservabilidade");
    assert.equal(fakeConnection.callsMatching(/DELETE/i).length, 0, "nada é apagado por decisão de política");
    assert.ok(outcome.diagnostics.policy_not_allow_existing.some((d) => d.guid === "g-eq"));
});

/* -------------------------------------
   FALHAS E INVARIANTES TRANSVERSAIS
------------------------------------- */

test("falha no binding → AssetStageError com etapa 'asset_binding' e ids criados (para compensação)", async () => {
    respond(baseRoutes([[/INSERT INTO asset_bindings/i, () => { throw new Error("binding insert failed"); }]]));

    // Equipamento NOVO (sem tag/serial correspondentes) → cria asset (300) e depois falha no binding.
    await assert.rejects(persistAssetsForVersion(equipmentInput({
        guid: "g-eq", type: "IfcFurniture", name: "Mesa nova", tag: "EQP-NEW", psets: {},
    }) as any), (error: any) => {
        assert.ok(error instanceof AssetStageError);
        assert.equal(error.uploadStage, "asset_binding");
        assert.deepEqual(error.createdAssetIds, [300], "o serviço reporta o que criou antes de falhar");
        return true;
    });
});

test("nenhuma consulta do fluxo de ativos deriva versão corrente por ORDER BY id DESC", async () => {
    respond(baseRoutes());
    await persistAssetsForVersion(makeInput() as any);

    for (const call of fakeConnection.calls) {
        assert.doesNotMatch(call.sql, /ORDER BY id DESC/i);
    }
});

/* -------------------------------------
   CICLO DE VIDA PÓS-ATIVAÇÃO
------------------------------------- */

test("reconciliação de ciclo de vida: absent/reativação por UPDATE com versão corrente explícita; NUNCA apaga, NUNCA infere retired; SEM sincronização de espaço-ativo (ADR-0052 §F)", async () => {
    respond([[/UPDATE assets/i, [{}]]]);

    await reconcileAssetLifecycleAfterActivation({ modelId: 20, currentVersionId: VERSION_ID });

    const updates = fakeConnection.callsMatching(/UPDATE assets/i);
    assert.equal(updates.length, 2, "apenas equipamento: absent + reativação (nenhuma sincronização de espaço-ativo)");

    const toAbsent = updates[0]!;
    assert.match(toAbsent.sql, /'absent'/);
    assert.match(toAbsent.sql, /NOT EXISTS/i, "ausente = tem histórico na linha mas não está na versão corrente");
    assert.equal(toAbsent.params.currentVersionId, VERSION_ID);

    assert.equal(fakeConnection.callsMatching(/INNER JOIN spaces/i).length, 0, "nenhuma query toca ativos por space_id");
    assert.equal(fakeConnection.callsMatching(/DELETE/i).length, 0);
    assert.equal(fakeConnection.callsMatching(/SET lifecycle_status = 'retired'/i).length, 0);
});

test("compensação guardada: só remove ativos sem bindings, sem reservas e sem casos resolvidos", async () => {
    respond([[/DELETE FROM assets/i, [{}]]]);

    await persistentAssetDb.deleteAssetsWithoutReferences([300]);

    const del = fakeConnection.callsMatching(/DELETE FROM assets/i)[0]!;
    assert.match(del.sql, /NOT EXISTS \(SELECT 1 FROM asset_bindings/i);
    assert.match(del.sql, /NOT EXISTS \(SELECT 1 FROM res_reservations/i, "um ativo com reservas nunca é removido");
    assert.match(del.sql, /NOT EXISTS \(SELECT 1 FROM asset_reconciliation_cases/i);
});
