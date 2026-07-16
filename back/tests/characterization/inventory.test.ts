/**
 * Testes de caracterização — versionamento de modelos e snapshot de inventário
 * (model_versions, entities, assets).
 *
 * Documentam o comportamento ATUAL de criação de versões, entidades e ativos,
 * incluindo a decisão de reservabilidade (hoje: sempre true).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeMySQL, fakeConnection, respond } from "../helpers/fakeDb.ts";

installFakeMySQL();
const { default: inventoryDb } = await import("../../utils/inventoryDatabase.ts");

beforeEach(() => fakeConnection.reset());

/* -------------------------------------
   NOTA (Prompt 2): os testes de createModelVersion/deleteModelVersion foram
   substituídos — a criação de versões passou para modelVersionDatabase
   (reserva segura com version_number, estados processing/active/failed/
   archived) e a compensação de falha deixou de apagar a linha da versão
   (fica 'failed') e passou a apagar o inventário parcial. Os comportamentos
   novos estão caracterizados em tests/versioning/.
------------------------------------- */

test("deleteInventoryForVersion: apaga assets e entities da versão (filhas antes das raízes), em transação", async () => {
    respond([
        [/DELETE FROM assets WHERE model_version_id/i, [{}]],
        [/DELETE FROM entities WHERE model_version_id/i, [{}]],
    ]);

    await inventoryDb.deleteInventoryForVersion(9);

    const deletes = fakeConnection.calls.filter((c) => /^\s*DELETE/i.test(c.sql));
    assert.equal(deletes.length, 3);
    assert.match(deletes[0]!.sql, /DELETE FROM assets/i);
    assert.match(deletes[1]!.sql, /parent_id IS NOT NULL/i);
    assert.match(deletes[2]!.sql, /DELETE FROM entities WHERE model_version_id/i);
    assert.deepEqual(fakeConnection.transactions, ["begin", "commit"]);
});

/* -------------------------------------
   SNAPSHOT DE INVENTÁRIO
------------------------------------- */

const SAMPLE_INVENTORY = {
    "space-guid-1": {
        spaceGuid: "space-guid-1",
        spaceName: "Sala 101",
        elements: [
            { guid: "elem-guid-1", type: "IfcFurniture", name: "Mesa" },
            { guid: "sensor-guid-1", type: "IfcSensor", name: "Sensor T" },
            { guid: "elem-guid-1", type: "IfcFurniture", name: "Mesa duplicada" },
        ],
    },
};

function snapshotRoutes(): [RegExp, any][] {
    let nextEntityId = 100;
    return [
        [/SELECT COUNT\(\*\) as count[\s\S]*FROM entities/i, [[{ count: 0 }]]],
        [/INSERT INTO entities/i, () => [{ insertId: nextEntityId++ }]],
        [/INSERT INTO assets/i, [{ insertId: 500 }]],
    ];
}

test("saveInventorySnapshot: inventário já existente para a versão → erro", async () => {
    respond([[/SELECT COUNT\(\*\) as count[\s\S]*FROM entities/i, [[{ count: 3 }]]]]);

    await assert.rejects(
        inventoryDb.saveInventorySnapshot(9, SAMPLE_INVENTORY),
        /Inventory already exists for this version/
    );
});

test("saveInventorySnapshot: espaço cria entity 'space' e asset 'space' reservável", async () => {
    respond(snapshotRoutes());

    await inventoryDb.saveInventorySnapshot(9, SAMPLE_INVENTORY);

    const entityInserts = fakeConnection.callsMatching(/INSERT INTO entities/i);
    const spaceEntity = entityInserts.find((c) => c.params.guid === "space-guid-1")!;
    assert.ok(spaceEntity, "espaço inserido como entity");
    assert.match(spaceEntity.sql, /'IfcSpace', 'space'/);
    assert.equal(spaceEntity.params.versionId, 9);

    const assetInserts = fakeConnection.callsMatching(/INSERT INTO assets/i);
    const spaceAsset = assetInserts.find((c) => /'space'/.test(c.sql))!;
    assert.ok(spaceAsset, "espaço inserido como asset");
    // Caracterização: reservable é SEMPRE true no código atual (hardcoded no SQL)
    assert.match(spaceAsset.sql, /true/);
    // Espaços não têm current_space_entity_id (NULL no SQL)
    assert.match(spaceAsset.sql, /NULL/);
});

test("saveInventorySnapshot: elemento não-sensor cria entity 'element' + asset 'equipment' reservável, ligado ao espaço", async () => {
    respond(snapshotRoutes());

    await inventoryDb.saveInventorySnapshot(9, SAMPLE_INVENTORY);

    const entityInserts = fakeConnection.callsMatching(/INSERT INTO entities/i);
    const elemEntity = entityInserts.find((c) => c.params.guid === "elem-guid-1")!;
    assert.ok(elemEntity, "elemento inserido como entity");
    assert.match(elemEntity.sql, /'element'/);
    // parent_id = id da entity do espaço (100 = primeiro insertId gerado)
    assert.equal(elemEntity.params.parentId, 100);

    const assetInserts = fakeConnection.callsMatching(/INSERT INTO assets/i);
    const equipAsset = assetInserts.find((c) => /'equipment'/.test(c.sql))!;
    assert.ok(equipAsset, "elemento inserido como asset equipment");
    assert.equal(equipAsset.params.spaceId, 100);
    assert.match(equipAsset.sql, /true/); // reservable sempre true
});

test("saveInventorySnapshot: IfcSensor cria entity mas NÃO cria asset", async () => {
    respond(snapshotRoutes());

    await inventoryDb.saveInventorySnapshot(9, SAMPLE_INVENTORY);

    const entityInserts = fakeConnection.callsMatching(/INSERT INTO entities/i);
    const sensorEntity = entityInserts.find((c) => c.params.guid === "sensor-guid-1");
    assert.ok(sensorEntity, "sensor inserido como entity");

    // 3 asset inserts esperados: 1 espaço + 1 equipamento (sensor excluído, duplicado ignorado)
    const assetInserts = fakeConnection.callsMatching(/INSERT INTO assets/i);
    assert.equal(assetInserts.length, 2);
});

test("saveInventorySnapshot: GUID duplicado no payload é ignorado (primeira ocorrência vence)", async () => {
    respond(snapshotRoutes());

    await inventoryDb.saveInventorySnapshot(9, SAMPLE_INVENTORY);

    const entityInserts = fakeConnection.callsMatching(/INSERT INTO entities/i);
    const dupes = entityInserts.filter((c) => c.params.guid === "elem-guid-1");
    assert.equal(dupes.length, 1, "guid duplicado só é inserido uma vez");
});

test("saveInventorySnapshot: usa transação — commit no sucesso", async () => {
    respond(snapshotRoutes());

    await inventoryDb.saveInventorySnapshot(9, SAMPLE_INVENTORY);

    assert.deepEqual(fakeConnection.transactions, ["begin", "commit"]);
});

test("saveInventorySnapshot: erro a meio → rollback e propaga o erro", async () => {
    let entityCount = 0;
    respond([
        [/SELECT COUNT\(\*\) as count[\s\S]*FROM entities/i, [[{ count: 0 }]]],
        [/INSERT INTO entities/i, () => {
            entityCount++;
            if (entityCount > 1) throw new Error("DB falhou");
            return [{ insertId: 100 }];
        }],
        [/INSERT INTO assets/i, [{ insertId: 500 }]],
    ]);

    await assert.rejects(inventoryDb.saveInventorySnapshot(9, SAMPLE_INVENTORY), /DB falhou/);
    assert.deepEqual(fakeConnection.transactions, ["begin", "rollback"]);
});
