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

// (Prompt 4) Comportamento explicitamente alterado: o viewer resolve agora o
// ATIVO PERSISTENTE via asset_bindings da versão corrente explícita
// (models.current_version_id) — nunca por maior id, nunca por linha por versão.
test("getAssetByGuidLatest: entity da versão corrente → asset_binding → ativo persistente", async () => {
    respond([
        [/FROM models m[\s\S]*INNER JOIN asset_bindings/i,
            [[{ id: 77, asset_uuid: "uuid-77", reservable: 1, lifecycle_status: "active", binding_id: 5 }]]],
    ]);

    const asset = await assetDb.getAssetByGuidLatest(3, "guid-abc");
    assert.equal(asset.id, 77);

    const query = fakeConnection.calls[0]!;
    assert.match(query.sql, /m\.current_version_id/);
    assert.match(query.sql, /asset_bindings/);
    assert.doesNotMatch(query.sql, /ORDER BY id DESC/i);
    assert.equal(query.params.guid, "guid-abc");
    assert.equal(query.params.modelId, 3);
});

test("getAssetByGuidLatest: elemento não inventariado (sem binding) → null — é assim que o viewer detecta 'não pertence ao inventário'", async () => {
    respond([[/FROM models m[\s\S]*INNER JOIN asset_bindings/i, [[]]]]);

    const asset = await assetDb.getAssetByGuidLatest(3, "guid-nao-modelado");
    assert.equal(asset, null);
});

/* -------------------------------------
   CONSULTAS POR VERSÃO
------------------------------------- */

test("getAssetsBySpace: resolve por asset_bindings (space_entity_id snapshot) e versão explícita", async () => {
    respond([[/FROM asset_bindings ab/i, [[{ id: 1 }, { id: 2 }]]]]);

    const assets = await assetDb.getAssetsBySpace(100, 12);
    assert.equal(assets.length, 2);

    const q = fakeConnection.callsMatching(/FROM asset_bindings/i)[0]!;
    assert.match(q.sql, /space_entity_id = :spaceEntityId/);
    assert.match(q.sql, /model_version_id = :versionId/);
});

test("getAssetById: ativo persistente com binding opcional da versão; sem linha → null", async () => {
    respond([[/FROM assets a/i, [[]]]]);

    const asset = await assetDb.getAssetById(5, 12);
    assert.equal(asset, null);

    const q = fakeConnection.callsMatching(/FROM assets a/i)[0]!;
    assert.match(q.sql, /LEFT JOIN asset_bindings/);
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
