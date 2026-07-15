/**
 * Testes de caracterização — ciclo de vida das reservas (res_reservations).
 *
 * Estes testes documentam o comportamento ATUAL, mesmo quando não é o
 * comportamento final desejado. Não devem ser "corrigidos" sem uma decisão
 * explícita de mudança de regra de negócio.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeMySQL, fakeConnection, respond } from "../helpers/fakeDb.ts";

installFakeMySQL();
const { default: reservationDb } = await import("../../utils/reservationDatabase.ts");

const NO_CONFLICT: [RegExp, any][] = [
    [/SELECT COUNT\(\*\) as count/i, [[{ count: 0 }]]],
];

beforeEach(() => fakeConnection.reset());

/* -------------------------------------
   CRIAÇÃO DE RESERVA
------------------------------------- */

test("createReservation: rejeita início no passado (ou igual a agora)", async () => {
    respond(NO_CONFLICT);
    const past = new Date(Date.now() - 60_000);
    const end = new Date(Date.now() + 3_600_000);

    await assert.rejects(
        reservationDb.createReservation(1, "actor1", past, end),
        /Cannot create reservation in the past/
    );
});

test("createReservation: rejeita fim anterior ou igual ao início", async () => {
    respond(NO_CONFLICT);
    const start = new Date(Date.now() + 3_600_000);
    const end = new Date(start.getTime() - 1);

    await assert.rejects(
        reservationDb.createReservation(1, "actor1", start, end),
        /End time must be after start time/
    );
});

test("createReservation: conflito com reserva aprovada bloqueia (statuses approved, in_use E no_show)", async () => {
    // Caracterização importante: uma reserva 'no_show' AINDA conta como conflito
    respond([[/status IN \('approved','in_use','no_show'\)/i, [[{ count: 1 }]]]]);

    const start = new Date(Date.now() + 3_600_000);
    const end = new Date(Date.now() + 7_200_000);

    await assert.rejects(
        reservationDb.createReservation(1, "actor1", start, end),
        /Asset already reserved for this period/
    );

    // Documenta os estados considerados bloqueantes no SQL atual
    const conflictCall = fakeConnection.callsMatching(/status IN \('approved','in_use','no_show'\)/i);
    assert.equal(conflictCall.length, 1);
});

test("createReservation: auto-conflito do ator bloqueia (statuses pending e approved)", async () => {
    respond([
        [/status IN \('approved','in_use','no_show'\)/i, [[{ count: 0 }]]],
        [/actor_id = :actorId[\s\S]*status IN \('pending','approved'\)/i, [[{ count: 1 }]]],
    ]);

    const start = new Date(Date.now() + 3_600_000);
    const end = new Date(Date.now() + 7_200_000);

    await assert.rejects(
        reservationDb.createReservation(1, "actor1", start, end),
        /You already have a reservation overlapping this period/
    );
});

test("createReservation: sucesso insere com status 'pending' e devolve insertId", async () => {
    respond([
        [/SELECT COUNT\(\*\) as count/i, [[{ count: 0 }]]],
        [/INSERT INTO res_reservations/i, [{ insertId: 42 }]],
    ]);

    const start = new Date(Date.now() + 3_600_000);
    const end = new Date(Date.now() + 7_200_000);

    const id = await reservationDb.createReservation(7, "actor1", start, end);
    assert.equal(id, 42);

    const insert = fakeConnection.callsMatching(/INSERT INTO res_reservations/i)[0]!;
    assert.ok(insert, "deve inserir na tabela res_reservations");
    assert.match(insert.sql, /'pending'/);
    assert.equal(insert.params.assetId, 7);
    assert.equal(insert.params.actorId, "actor1");
});

test("createReservation: antes de tudo marca reservas expiradas como no_show", async () => {
    respond([
        [/SELECT COUNT\(\*\) as count/i, [[{ count: 0 }]]],
        [/INSERT INTO res_reservations/i, [{ insertId: 1 }]],
    ]);

    const start = new Date(Date.now() + 3_600_000);
    const end = new Date(Date.now() + 7_200_000);
    await reservationDb.createReservation(1, "a", start, end);

    // A primeira query emitida é o UPDATE de no_show (regra: approved sem check-in até 10 min após o início)
    const first = fakeConnection.calls[0]!;
    assert.match(first.sql, /SET status = 'no_show'/);
    assert.match(first.sql, /checkin_time IS NULL/);
    assert.match(first.sql, /INTERVAL 10 MINUTE/);
});

/* -------------------------------------
   CHECK-IN
------------------------------------- */

test("checkIn: sem reserva aprovada na janela temporal → erro", async () => {
    respond([[/SELECT \*[\s\S]*FROM res_reservations/i, [[]]]]);

    await assert.rejects(
        reservationDb.checkIn(10, "actor1"),
        /Check-in not allowed: outside allowed time window or no approved reservation/
    );
});

test("checkIn: a janela é definida no SQL — 20 min antes até 10 min depois do início, apenas status 'approved'", async () => {
    respond([[/SELECT \*[\s\S]*FROM res_reservations/i, [[]]]]);

    await reservationDb.checkIn(10, "actor1").catch(() => { /* esperado */ });

    const select = fakeConnection.callsMatching(/DATE_SUB\(start_time, INTERVAL :before MINUTE\)/i)[0]!;
    assert.ok(select, "o SELECT de check-in usa janela relativa ao start_time");
    assert.match(select.sql, /status = 'approved'/);
    assert.equal(select.params.before, 20);
    assert.equal(select.params.after, 10);
});

test("checkIn: reserva já com checkin_time → 'Already checked in'", async () => {
    respond([[/SELECT \*[\s\S]*FROM res_reservations/i,
        [[{ id: 10, checkin_time: "2026-01-01 10:00:00", status: "approved" }]]]]);

    await assert.rejects(reservationDb.checkIn(10, "actor1"), /Already checked in/);
});

test("checkIn: sucesso muda status para 'in_use' e grava checkin_time", async () => {
    respond([
        [/SELECT \*[\s\S]*FROM res_reservations/i, [[{ id: 10, checkin_time: null, status: "approved" }]]],
        [/UPDATE res_reservations/i, [{}]],
    ]);

    const result = await reservationDb.checkIn(10, "actor1");
    assert.equal(result.message, "Check-in successful");
    assert.equal(result.reservationId, 10);

    const update = fakeConnection.callsMatching(/SET status = 'in_use'/i)[0]!;
    assert.ok(update);
    assert.match(update.sql, /checkin_time = NOW\(\)/);
});

/* -------------------------------------
   CHECKOUT
------------------------------------- */

test("checkOut: sem reserva 'in_use' → erro", async () => {
    respond([[/SELECT \*[\s\S]*status = 'in_use'/i, [[]]]]);

    await assert.rejects(
        reservationDb.checkOut(10, "actor1"),
        /No active reservation to checkout/
    );
});

test("checkOut: sucesso muda status para 'completed'", async () => {
    respond([
        [/SELECT \*[\s\S]*status = 'in_use'/i, [[{ id: 10, status: "in_use" }]]],
        [/UPDATE res_reservations/i, [{}]],
    ]);

    const result = await reservationDb.checkOut(10, "actor1");
    assert.equal(result.message, "Checkout successful");

    const update = fakeConnection.callsMatching(/SET status = 'completed'/i)[0]!;
    assert.ok(update);
});

/* -------------------------------------
   CANCELAMENTO
------------------------------------- */

function reservationRow(overrides: any = {}) {
    return {
        id: 5,
        asset_id: 1,
        actor_id: "actor1",
        // por omissão: começa daqui a 48h → cancelável
        start_time: new Date(Date.now() + 48 * 3_600_000).toISOString(),
        end_time: new Date(Date.now() + 50 * 3_600_000).toISOString(),
        status: "pending",
        ...overrides,
    };
}

test("cancelReservation: reserva inexistente → 'Reservation not found'", async () => {
    respond([[/SELECT \*[\s\S]*WHERE id = :id/i, [[]]]]);
    await assert.rejects(reservationDb.cancelReservation(5, "actor1"), /Reservation not found/);
});

test("cancelReservation: apenas o próprio ator pode cancelar", async () => {
    respond([[/SELECT \*[\s\S]*WHERE id = :id/i, [[reservationRow({ actor_id: "outro" })]]]]);
    await assert.rejects(reservationDb.cancelReservation(5, "actor1"), /Not authorized/);
});

test("cancelReservation: não cancela reserva 'in_use'", async () => {
    respond([[/SELECT \*[\s\S]*WHERE id = :id/i, [[reservationRow({ status: "in_use" })]]]]);
    await assert.rejects(reservationDb.cancelReservation(5, "actor1"), /Cannot cancel reservation that is in use/);
});

test("cancelReservation: estados finais (completed/cancelled/no_show) não são canceláveis", async () => {
    respond([[/SELECT \*[\s\S]*WHERE id = :id/i, [[reservationRow({ status: "completed" })]]]]);
    await assert.rejects(reservationDb.cancelReservation(5, "actor1"), /Reservation cannot be cancelled/);
});

test("cancelReservation: regra das 24h — menos de 24h antes do início → erro", async () => {
    const soon = new Date(Date.now() + 3_600_000).toISOString(); // daqui a 1h
    respond([[/SELECT \*[\s\S]*WHERE id = :id/i, [[reservationRow({ start_time: soon })]]]]);
    await assert.rejects(
        reservationDb.cancelReservation(5, "actor1"),
        /Cancellation allowed only up to 24h before start time/
    );
});

test("cancelReservation: sucesso muda status para 'cancelled'", async () => {
    respond([
        [/SELECT \*[\s\S]*WHERE id = :id/i, [[reservationRow()]]],
        [/UPDATE res_reservations/i, [{}]],
    ]);

    const result = await reservationDb.cancelReservation(5, "actor1");
    assert.equal(result.message, "Reservation cancelled");

    const update = fakeConnection.callsMatching(/SET status = 'cancelled'/i)[0]!;
    assert.ok(update);
});

/* -------------------------------------
   LISTAGENS
------------------------------------- */

test("getReservationsByActor: devolve linhas ordenadas por start_time DESC", async () => {
    const rows = [reservationRow({ id: 2 }), reservationRow({ id: 1 })];
    respond([[/WHERE actor_id = \?/i, [rows]]]);

    const result = await reservationDb.getReservationsByActor("actor1");
    assert.deepEqual(result.map((r: any) => r.id), [2, 1]);

    const select = fakeConnection.callsMatching(/WHERE actor_id = \?/i)[0]!;
    assert.match(select.sql, /ORDER BY start_time DESC/);
});

test("getReservationsByAsset: devolve linhas ordenadas por start_time ASC", async () => {
    respond([[/WHERE asset_id = :assetId/i, [[reservationRow()]]]]);

    const result = await reservationDb.getReservationsByAsset(1);
    assert.equal(result.length, 1);

    const select = fakeConnection.callsMatching(/WHERE asset_id = :assetId/i)[0]!;
    assert.match(select.sql, /ORDER BY start_time ASC/);
});
