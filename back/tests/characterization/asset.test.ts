/**
 * Testes de caracterização — consulta de ativos e disponibilidade
 * (assets, entities, model_versions, res_reservations).
 *
 * Incluem: identificação da última versão, tratamento de elemento não
 * modelado/não inventariado (devolve null) e decisão de disponibilidade.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeMySQL, fakeConnection, respond } from "../helpers/fakeDb.ts";

installFakeMySQL();
const { default: assetDb } = await import("../../utils/assetDatabase.ts");

beforeEach(() => fakeConnection.reset());

/* -------------------------------------
   ÚLTIMA VERSÃO
------------------------------------- */

// (Prompt 2) Comportamento explicitamente alterado: a "versão corrente" deixou
// de ser o maior id (ORDER BY id DESC) e passou a ser a referência explícita
// models.current_version_id — uma versão 'failed'/'processing' nunca é corrente.
test("getAssetByGuidLatest: a versão corrente vem de models.current_version_id (não do maior id)", async () => {
    respond([
        [/SELECT current_version_id AS id[\s\S]*FROM models/i, [[{ id: 12 }]]],
        [/FROM assets a[\s\S]*INNER JOIN entities/i, [[{ id: 77, model_version_id: 12, reservable: 1 }]]],
    ]);

    const asset = await assetDb.getAssetByGuidLatest(3, "guid-abc");
    assert.equal(asset.id, 77);

    const versionQuery = fakeConnection.callsMatching(/FROM models/i)[0]!;
    assert.match(versionQuery.sql, /current_version_id/);
    assert.doesNotMatch(versionQuery.sql, /ORDER BY id DESC/);

    // O asset é procurado na versão corrente (12), com o guid via JOIN a entities
    const assetQuery = fakeConnection.callsMatching(/INNER JOIN entities/i)[0]!;
    assert.equal(assetQuery.params.versionId, 12);
    assert.equal(assetQuery.params.guid, "guid-abc");
});

test("getAssetByGuidLatest: modelo sem versão corrente (current_version_id NULL) → null", async () => {
    respond([[/SELECT current_version_id AS id[\s\S]*FROM models/i, [[{ id: null }]]]]);

    const asset = await assetDb.getAssetByGuidLatest(3, "guid-abc");
    assert.equal(asset, null);
});

test("getAssetByGuidLatest: elemento não inventariado (sem asset) → null — é assim que o viewer detecta 'não pertence ao inventário'", async () => {
    respond([
        [/SELECT current_version_id AS id[\s\S]*FROM models/i, [[{ id: 12 }]]],
        [/INNER JOIN entities/i, [[]]],
    ]);

    const asset = await assetDb.getAssetByGuidLatest(3, "guid-nao-modelado");
    assert.equal(asset, null);
});

/* -------------------------------------
   CONSULTAS POR VERSÃO
------------------------------------- */

test("getAssetsBySpace: filtra por current_space_entity_id E model_version_id (isolamento de versão)", async () => {
    respond([[/FROM assets/i, [[{ id: 1 }, { id: 2 }]]]]);

    const assets = await assetDb.getAssetsBySpace(100, 12);
    assert.equal(assets.length, 2);

    const q = fakeConnection.callsMatching(/FROM assets/i)[0]!;
    assert.match(q.sql, /current_space_entity_id = :spaceEntityId/);
    assert.match(q.sql, /model_version_id = :versionId/);
});

test("getAssetById: exige versão explícita; sem linha → null", async () => {
    respond([[/FROM assets/i, [[]]]]);

    const asset = await assetDb.getAssetById(5, 12);
    assert.equal(asset, null);

    const q = fakeConnection.callsMatching(/FROM assets/i)[0]!;
    assert.match(q.sql, /model_version_id = :versionId/);
});

/* -------------------------------------
   DISPONIBILIDADE
------------------------------------- */

test("getAvailability: sem reservas sobrepostas → available true", async () => {
    respond([[/FROM res_reservations/i, [[]]]]);

    const result = await assetDb.getAvailability(
        5,
        new Date("2026-08-01T10:00:00"),
        new Date("2026-08-01T12:00:00")
    );

    assert.equal(result.available, true);
    assert.deepEqual(result.conflicts, []);
});

test("getAvailability: reserva sobreposta → available false com lista de conflitos", async () => {
    respond([[/FROM res_reservations/i, [[{ id: 33 }]]]]);

    const result = await assetDb.getAvailability(
        5,
        new Date("2026-08-01T10:00:00"),
        new Date("2026-08-01T12:00:00")
    );

    assert.equal(result.available, false);
    assert.deepEqual(result.conflicts, [{ id: 33 }]);
});

test("getAvailability: só considera 'approved' e 'in_use' (pending NÃO bloqueia disponibilidade)", async () => {
    respond([[/FROM res_reservations/i, [[]]]]);

    await assetDb.getAvailability(5, new Date("2026-08-01T10:00:00"), new Date("2026-08-01T12:00:00"));

    const q = fakeConnection.callsMatching(/FROM res_reservations/i)[0]!;
    assert.match(q.sql, /status IN \('approved', 'in_use'\)/);
    // Sobreposição: start_time < :end AND end_time > :start
    assert.match(q.sql, /start_time < :end/);
    assert.match(q.sql, /end_time > :start/);
});

test("getAvailability: datas são formatadas em hora LOCAL 'YYYY-MM-DD HH:mm:ss' (sem timezone)", async () => {
    respond([[/FROM res_reservations/i, [[]]]]);

    await assetDb.getAvailability(5, new Date("2026-08-01T10:00:00"), new Date("2026-08-01T12:00:00"));

    const q = fakeConnection.callsMatching(/FROM res_reservations/i)[0]!;
    assert.match(q.params.start, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.match(q.params.end, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});
