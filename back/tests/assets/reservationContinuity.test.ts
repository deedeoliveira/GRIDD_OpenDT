/**
 * Continuidade das reservas sobre a identidade persistente (Prompt 4).
 *
 * Invariante central do prompt: "uma nova versão não pode contornar uma
 * reserva existente pela criação de outro asset_id" — os conflitos são
 * verificados pelo asset_id persistente, que sobrevive às versões (a
 * estabilidade do asset_id está coberta em assetInventory.test.ts).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeMySQL, fakeConnection, respond } from "../helpers/fakeDb.ts";

installFakeMySQL();

const { default: reservationDb } = await import("../../utils/reservationDatabase.ts");
const providers = await import("../../policies/policyProvider.ts");

beforeEach(() => {
    fakeConnection.reset();
    providers.resetPolicyProviders();
});

const FUTURE_START = () => new Date(Date.now() + 3_600_000);
const FUTURE_END = () => new Date(Date.now() + 7_200_000);

function routes(overrides: [RegExp, any][] = []): [RegExp, any][] {
    return [
        ...overrides,
        [/SELECT lifecycle_status\b[^\n]*FROM assets/i, [[{ lifecycle_status: "active" }]]],
        [/SELECT COUNT\(\*\) as count/i, [[{ count: 0 }]]],
        [/SELECT ab\.id AS binding_id/i, [[]]],
        [/INSERT INTO res_reservations/i, [{ insertId: 42 }]],
    ];
}

/* -------------------------------------
   CICLO DE VIDA: absent bloqueia NOVAS, preserva existentes
------------------------------------- */

test("ativo 'absent' (fora da versão corrente): NOVA reserva é rejeitada com mensagem clara", async () => {
    respond(routes([[/SELECT lifecycle_status\b[^\n]*FROM assets/i, [[{ lifecycle_status: "absent" }]]]]));

    await assert.rejects(
        reservationDb.createReservation(7, "actor1", FUTURE_START(), FUTURE_END()),
        /Asset is not available for new reservations \(lifecycle: absent\)/
    );

    assert.equal(fakeConnection.callsMatching(/INSERT INTO res_reservations/i).length, 0);
});

test("ativo 'retired' e 'pending_reconciliation' também bloqueiam novas reservas", async () => {
    for (const lifecycle of ["retired", "pending_reconciliation"]) {
        fakeConnection.reset();
        respond(routes([[/SELECT lifecycle_status\b[^\n]*FROM assets/i, [[{ lifecycle_status: lifecycle }]]]]));

        await assert.rejects(
            reservationDb.createReservation(7, "actor1", FUTURE_START(), FUTURE_END()),
            new RegExp(`lifecycle: ${lifecycle}`)
        );
    }
});

test("bloqueio por ciclo de vida NÃO altera reservas existentes (nenhum UPDATE além dos sweeps no_show/overdue)", async () => {
    respond(routes([[/SELECT lifecycle_status\b[^\n]*FROM assets/i, [[{ lifecycle_status: "absent" }]]]]));

    await assert.rejects(reservationDb.createReservation(7, "actor1", FUTURE_START(), FUTURE_END()));

    const updates = fakeConnection.callsMatching(/UPDATE res_reservations/i);
    for (const u of updates) {
        assert.match(u.sql, /no_show|overdue/, "apenas os sweeps de expiração tocam reservas");
    }
});

test("ativo legado sem linha (ou lifecycle NULL): reserva prossegue (compatibilidade expand-and-contract)", async () => {
    respond(routes([[/SELECT lifecycle_status\b[^\n]*FROM assets/i, [[]]]]));

    const id = await reservationDb.createReservation(7, "actor1", FUTURE_START(), FUTURE_END());
    assert.equal(id, 42);
});

/* -------------------------------------
   CONFLITOS: pelo asset_id persistente
------------------------------------- */

test("conflito continua a ser verificado pelo asset_id persistente — versões não participam da regra", async () => {
    respond(routes([[/status IN \('approved','in_use','no_show'\)/i, [[{ count: 1 }]]]]));

    await assert.rejects(
        reservationDb.createReservation(7, "actor1", FUTURE_START(), FUTURE_END()),
        /Asset already reserved for this period/
    );

    const conflict = fakeConnection.callsMatching(/status IN \('approved','in_use','no_show'\)/i)[0]!;
    assert.equal(conflict.params.assetId, 7);
    assert.doesNotMatch(conflict.sql, /model_version_id/i,
        "o conflito é do recurso físico, não de uma representação por versão");
});

/* -------------------------------------
   SNAPSHOTS NO MOMENTO DA RESERVA
------------------------------------- */

test("reserva grava snapshots do contexto: binding/versão correntes, nome do ativo, espaço e código", async () => {
    respond(routes([[/SELECT ab\.id AS binding_id/i,
        [[{ binding_id: 400, model_version_id: 9, space_id: 7, asset_name: "Mesa 01", space_code: "R-A" }]]]]));

    await reservationDb.createReservation(7, "actor1", FUTURE_START(), FUTURE_END());

    const snapshotQuery = fakeConnection.callsMatching(/SELECT ab\.id AS binding_id/i)[0]!;
    assert.match(snapshotQuery.sql, /m\.current_version_id = v\.id/,
        "binding corrente = versão corrente EXPLÍCITA do modelo");
    assert.doesNotMatch(snapshotQuery.sql, /ORDER BY id DESC/i);

    const insert = fakeConnection.callsMatching(/INSERT INTO res_reservations/i)[0]!;
    assert.equal(insert.params.bindingId, 400);
    assert.equal(insert.params.versionId, 9);
    assert.equal(insert.params.assetName, "Mesa 01");
    assert.equal(insert.params.spaceId, 7);
    assert.equal(insert.params.spaceCode, "R-A");
});

test("ativo sem binding corrente (ex.: legado): snapshots ficam NULL, reserva não é impedida", async () => {
    respond(routes());

    await reservationDb.createReservation(7, "actor1", FUTURE_START(), FUTURE_END());

    const insert = fakeConnection.callsMatching(/INSERT INTO res_reservations/i)[0]!;
    assert.equal(insert.params.bindingId, null);
    assert.equal(insert.params.versionId, null);
    assert.equal(insert.params.assetName, null);
    assert.equal(insert.params.spaceId, null);
    assert.equal(insert.params.spaceCode, null);
});
