/**
 * Backfill da identidade persistente dos ativos (Prompt 4) — promover-e-mapear,
 * expand-and-contract, idempotente, sem dados inventados; ambiguidade em
 * reservas bloqueantes ABORTA (decisão humana obrigatória).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeMySQL, fakeConnection, respond } from "../helpers/fakeDb.ts";

installFakeMySQL();

const { runAssetsBackfill } = await import("../../scripts/backfillAssets.ts");

beforeEach(() => fakeConnection.reset());

const FUTURE = new Date(Date.now() + 86_400_000).toISOString();
const PAST = new Date(Date.now() - 86_400_000).toISOString();

/** Linhas legadas: 2 versões do mesmo espaço + 2 versões do mesmo equipamento (por GUID). */
const LEGACY_ROWS = [
    { id: 1, name: "Sala A", asset_type: "space", reservable: 1, model_version_id: 3,
      model_entity_id: 101, guid: "sp-A", model_id: 20, linked_parent_id: 10, current_version_id: 4, space_id: 5 },
    { id: 2, name: "Sala A", asset_type: "space", reservable: 1, model_version_id: 4,
      model_entity_id: 201, guid: "sp-A", model_id: 20, linked_parent_id: 10, current_version_id: 4, space_id: 5 },
    { id: 3, name: "Mesa 01", asset_type: "equipment", reservable: 1, model_version_id: 3,
      model_entity_id: 102, guid: "g-1", model_id: 20, linked_parent_id: 10, current_version_id: 4, space_id: null },
    { id: 4, name: "Mesa 01", asset_type: "equipment", reservable: 1, model_version_id: 4,
      model_entity_id: 202, guid: "g-1", model_id: 20, linked_parent_id: 10, current_version_id: 4, space_id: null },
];

function routes(overrides: [RegExp, any][] = []): [RegExp, any][] {
    return [
        ...overrides,
        [/FROM assets a[\s\S]*LEFT JOIN legacy_asset_mapping/i, [LEGACY_ROWS]],
        [/FROM res_reservations r/i, [[]]],
        [/UPDATE assets/i, [{}]],
        [/INSERT INTO asset_bindings/i, [{ insertId: 700 }]],
        [/INSERT INTO legacy_asset_mapping/i, [{}]],
        [/UPDATE res_reservations/i, [{}]],
    ];
}

test("modo relatório: analisa e NÃO escreve nada", async () => {
    respond(routes());

    await runAssetsBackfill(false);

    assert.equal(fakeConnection.callsMatching(/UPDATE|INSERT|DELETE/i).length, 0);
    assert.equal(fakeConnection.transactions.length, 0);
});

test("apply: promove a linha da versão CORRENTE por grupo, cria bindings históricos, mapeia e NÃO apaga duplicados (expand-and-contract)", async () => {
    respond(routes([[/FROM res_reservations r/i,
        [[{ id: 100, asset_id: 3, status: "completed", end_time: PAST }]]]]));

    await runAssetsBackfill(true);

    // promoção: exatamente as linhas da versão corrente (ids 2 e 4)
    const promotions = fakeConnection.callsMatching(/UPDATE assets[\s\S]*SET asset_uuid/i);
    assert.deepEqual(promotions.map((p) => p.params.id).sort(), [2, 4]);
    for (const p of promotions) {
        assert.ok(p.params.uuid, "uuid atribuído na promoção");
        assert.equal(p.params.lifecycle, "active", "linha corrente promovida como active");
        assert.match(p.sql, /model_version_id = NULL/, "identidade deixa de pertencer a uma versão");
        assert.match(p.sql, /AND asset_uuid IS NULL/, "idempotência: nunca re-promove");
    }

    // bindings: um por linha legada (histórico preservado), todos no promovido
    const bindings = fakeConnection.callsMatching(/INSERT INTO asset_bindings/i);
    assert.equal(bindings.length, 4);
    assert.ok(bindings.every((b) => b.params.assetId === 2 || b.params.assetId === 4));

    // reserva da linha não-promovida re-apontada para o ativo persistente
    const repointed = fakeConnection.callsMatching(/UPDATE res_reservations SET asset_id/i);
    assert.equal(repointed.length, 2, "uma por linha não-promovida (3→4 e 1→2)");
    assert.ok(repointed.some((r) => r.params.legacyId === 3 && r.params.pid === 4));

    // expand-and-contract: nenhuma linha legada é removida
    assert.equal(fakeConnection.callsMatching(/DELETE FROM assets/i).length, 0);

    // mapeamento completo (2 promovidos + 2 fundidos)
    assert.equal(fakeConnection.callsMatching(/INSERT INTO legacy_asset_mapping/i).length, 4);
    assert.ok(fakeConnection.transactions.includes("commit"));
});

test("reserva bloqueante sobre linha sem mapeamento confiável → ABORTA sem escrever (decisão humana)", async () => {
    const unrecoverableRow = [{ id: 9, name: "??", asset_type: "equipment", reservable: 1,
        model_version_id: 3, model_entity_id: 103, guid: null, model_id: 20,
        linked_parent_id: 10, current_version_id: 4, space_id: null }];

    respond(routes([
        [/FROM assets a[\s\S]*LEFT JOIN legacy_asset_mapping/i, [unrecoverableRow]],
        [/FROM res_reservations r/i, [[{ id: 101, asset_id: 9, status: "approved", end_time: FUTURE }]]],
    ]));

    await assert.rejects(runAssetsBackfill(true), /ambiguous reservations require human decision/);

    assert.equal(fakeConnection.callsMatching(/UPDATE|INSERT/i).length, 0, "aborta ANTES de qualquer escrita");
});

test("linha sem evidência (sem space_binding e sem guid): 'unrecoverable' no mapeamento, nada inventado", async () => {
    const rows = [{ id: 9, name: "Sala fantasma", asset_type: "space", reservable: 1,
        model_version_id: 3, model_entity_id: 103, guid: "sp-x", model_id: 20,
        linked_parent_id: 10, current_version_id: 4, space_id: null }];

    respond(routes([[/FROM assets a[\s\S]*LEFT JOIN legacy_asset_mapping/i, [rows]]]));

    await runAssetsBackfill(true);

    assert.equal(fakeConnection.callsMatching(/UPDATE assets/i).length, 0, "nenhuma promoção sem identidade verificável");
    const mapping = fakeConnection.callsMatching(/INSERT INTO legacy_asset_mapping/i)[0]!;
    assert.match(mapping.sql, /'unrecoverable'/);
});

test("idempotente: sem linhas legadas por migrar → no-op (nenhuma transação)", async () => {
    respond(routes([[/FROM assets a[\s\S]*LEFT JOIN legacy_asset_mapping/i, [[]]]]));

    await runAssetsBackfill(true);

    assert.equal(fakeConnection.calls.length, 1, "apenas a consulta inicial");
    assert.equal(fakeConnection.transactions.length, 0);
});
