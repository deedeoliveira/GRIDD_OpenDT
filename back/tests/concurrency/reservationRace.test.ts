/**
 * Concorrência das reservas (Prompt 6, §4/§5/§11/§12; ADR-0030).
 *
 * O fakeDb emula a semântica de locks do InnoDB: SELECT ... FOR UPDATE numa
 * conexão de transação detém um lock de linha até commit/rollback; outra
 * transação que peça o mesmo lock ESPERA. Isto torna as corridas
 * DETERMINÍSTICAS: dois createReservation verdadeiramente concorrentes são
 * serializados exatamente no lock por asset — e o segundo vê a reserva do
 * primeiro dentro da própria transação.
 *
 * REGRA DE NEGÓCIO PRESERVADA (auditada, NÃO alterada): 'pending' não bloqueia
 * terceiros — bloqueia o PRÓPRIO ator (hasActorConflict). Por isso a corrida
 * de "reserva dupla" observável nas regras atuais é a do MESMO ator (double
 * submit) e a de estados bloqueantes (approved/in_use/no_show) — ambas
 * testadas aqui. A verificação definitiva de terceiros acontecerá na futura
 * transição pending→approved (ponto de extensão documentado, sem workflow).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeMySQL, fakeConnection } from "../helpers/fakeDb.ts";

installFakeMySQL();
const { default: reservationDb } = await import("../../utils/reservationDatabase.ts");
const { ConcurrencyError } = await import("../../utils/concurrencyControl.ts");

/** Estado SQL em memória para o fluxo de reservas de um ativo modelado. */
function reservationState(overrides: any = {}) {
    const state = {
        reservations: [] as any[],
        nextId: 1,
        asset: { lifecycle_status: "active", source: "ifc", reservable: 1, asset_uuid: null, ...overrides },
        insertDelayMs: 0,
    };

    fakeConnection.handler = (sql: string, params?: any) => {
        if (/SET status = 'no_show'|SET status = 'overdue'/.test(sql)) return [{}];

        if (/SELECT lifecycle_status/.test(sql)) {
            return [[state.asset]];
        }
        if (/status IN \('approved','in_use','no_show'\)/.test(sql)) {
            const count = state.reservations.filter((r) =>
                r.asset_id === params.assetId
                && ["approved", "in_use", "no_show"].includes(r.status)
                && r.start_time < params.end && r.end_time > params.start).length;
            return [[{ count }]];
        }
        if (/actor_id = :actorId/.test(sql) && /'pending','approved'/.test(sql)) {
            const count = state.reservations.filter((r) =>
                r.asset_id === params.assetId && r.actor_id === params.actorId
                && ["pending", "approved"].includes(r.status)
                && r.start_time < params.end && r.end_time > params.start).length;
            return [[{ count }]];
        }
        if (/FROM asset_bindings ab/.test(sql)) return [[]];
        if (/INSERT INTO res_reservations/.test(sql)) {
            const doInsert = () => {
                const id = state.nextId++;
                state.reservations.push({
                    id, asset_id: params.assetId, actor_id: params.actorId,
                    start_time: params.start, end_time: params.end, status: "pending",
                });
                return [{ insertId: id }];
            };
            if (state.insertDelayMs > 0) {
                return new Promise((resolve) => setTimeout(() => resolve(doInsert()), state.insertDelayMs));
            }
            return doInsert();
        }
        return [[]];
    };

    return state;
}

const futureStart = () => new Date(Date.now() + 3_600_000);
const futureEnd = () => new Date(Date.now() + 7_200_000);

beforeEach(() => fakeConnection.reset());

/* ================= §11.1 — reserva dupla ================= */

test("§11.1 reserva dupla: duas criações simultâneas incompatíveis do MESMO ator → exatamente UMA aceite (múltiplas iterações)", async () => {
    for (let i = 0; i < 20; i++) {
        fakeConnection.reset();
        const state = reservationState();

        const results = await Promise.allSettled([
            reservationDb.createReservation(1, "actor1", futureStart(), futureEnd()),
            reservationDb.createReservation(1, "actor1", futureStart(), futureEnd()),
        ]);

        const accepted = results.filter((r) => r.status === "fulfilled");
        const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];

        assert.equal(accepted.length, 1, `iteração ${i}: exatamente uma aceite`);
        assert.equal(rejected.length, 1, `iteração ${i}: exatamente uma rejeitada`);
        assert.match(String(rejected[0]!.reason?.message), /You already have a reservation overlapping this period/);
        assert.equal(state.reservations.length, 1, `iteração ${i}: uma única linha inserida`);
    }
});

test("§11.1 estado bloqueante: reserva 'approved' existente → dois pedidos simultâneos de atores diferentes são AMBOS rejeitados", async () => {
    const state = reservationState();
    state.reservations.push({
        id: 99, asset_id: 1, actor_id: "dono",
        start_time: futureStart(), end_time: futureEnd(), status: "approved",
    });
    state.nextId = 100;

    const results = await Promise.allSettled([
        reservationDb.createReservation(1, "a2", futureStart(), futureEnd()),
        reservationDb.createReservation(1, "a3", futureStart(), futureEnd()),
    ]);

    assert.ok(results.every((r) => r.status === "rejected"), "nenhum pedido passa sobre um approved");
    for (const r of results as PromiseRejectedResult[]) {
        assert.match(String(r.reason?.message), /Asset already reserved for this period/);
    }
    assert.equal(state.reservations.length, 1);
});

test("regra preservada (§4.4): 'pending' NÃO bloqueia terceiros — dois atores diferentes obtêm ambos pending (comportamento documentado, não alterado)", async () => {
    const state = reservationState();

    const results = await Promise.allSettled([
        reservationDb.createReservation(1, "actorA", futureStart(), futureEnd()),
        reservationDb.createReservation(1, "actorB", futureStart(), futureEnd()),
    ]);

    assert.ok(results.every((r) => r.status === "fulfilled"));
    assert.equal(state.reservations.length, 2);
    assert.ok(state.reservations.every((r) => r.status === "pending"));
});

/* ================= §11.2 — ativos diferentes não se serializam ================= */

test("§11.2 ativos diferentes prosseguem em paralelo (sem serialização global): o lock é por asset", async () => {
    const state = reservationState();
    state.insertDelayMs = 60; // o INSERT do asset 1 demora; o do asset 2 não pode esperar por ele

    const t0 = Date.now();
    const order: number[] = [];
    await Promise.all([
        reservationDb.createReservation(1, "a1", futureStart(), futureEnd()).then(() => order.push(1)),
        (async () => {
            // pequeno atraso para garantir que o asset 1 já detém o SEU lock
            await new Promise((r) => setTimeout(r, 10));
            state.insertDelayMs = 0;
            await reservationDb.createReservation(2, "a2", futureStart(), futureEnd());
            order.push(2);
        })(),
    ]);

    assert.deepEqual(order, [2, 1], "o asset 2 terminou primeiro — não esperou pelo lock do asset 1");
    assert.ok(Date.now() - t0 >= 60);
    assert.equal(state.reservations.length, 2);
});

/* ================= protocolo transacional (§4.2) ================= */

test("§4.2 protocolo: lock por asset é a PRIMEIRA instrução da transação; verificação e INSERT na mesma transação", async () => {
    reservationState();
    await reservationDb.createReservation(1, "actor1", futureStart(), futureEnd());

    // uma transação única: begin ... commit (sem rollback)
    assert.deepEqual(fakeConnection.transactions, ["begin", "commit"]);

    // ordem das queries: (2 lazy updates fora da tx) → FOR UPDATE → conflitos → insert
    const sqls = fakeConnection.calls.map((c) => c.sql);
    const forUpdateIdx = sqls.findIndex((s) => /SELECT lifecycle_status[\s\S]*FOR UPDATE/.test(s));
    const conflictIdx = sqls.findIndex((s) => /status IN \('approved','in_use','no_show'\)/.test(s));
    const insertIdx = sqls.findIndex((s) => /INSERT INTO res_reservations/.test(s));
    assert.ok(forUpdateIdx >= 0, "usa SELECT ... FOR UPDATE na linha do asset");
    assert.ok(forUpdateIdx < conflictIdx && conflictIdx < insertIdx,
        "lock → verificação → inserção, por esta ordem, dentro da mesma fronteira");
});

test("conflito de negócio faz ROLLBACK (nada inserido) e não é repetido (sem retry de erros de negócio)", async () => {
    const state = reservationState();
    state.reservations.push({
        id: 1, asset_id: 1, actor_id: "x",
        start_time: futureStart(), end_time: futureEnd(), status: "approved",
    });

    await assert.rejects(
        reservationDb.createReservation(1, "actor1", futureStart(), futureEnd()),
        /Asset already reserved for this period/
    );
    assert.deepEqual(fakeConnection.transactions, ["begin", "rollback"]);
    // uma única avaliação do conflito — nenhum retry automático de erro de negócio
    assert.equal(fakeConnection.callsMatching(/status IN \('approved','in_use','no_show'\)/).length, 1);
});

/* ================= deadlocks e timeouts (§9) ================= */

test("§9 deadlock InnoDB (1213): retry automático limitado com backoff — a 2.ª tentativa vence", async () => {
    const state = reservationState();
    let deadlocksToThrow = 1;
    const base = fakeConnection.handler;
    fakeConnection.handler = (sql, params) => {
        if (/FOR UPDATE/.test(sql) && deadlocksToThrow > 0) {
            deadlocksToThrow -= 1;
            const err: any = new Error("Deadlock found when trying to get lock");
            err.errno = 1213; err.code = "ER_LOCK_DEADLOCK";
            throw err;
        }
        return base(sql, params);
    };

    const id = await reservationDb.createReservation(1, "actor1", futureStart(), futureEnd());
    assert.ok(id, "a reserva foi criada na tentativa seguinte");
    assert.equal(state.reservations.length, 1);
    // rollback da tentativa falhada + begin/commit da vencedora
    assert.deepEqual(fakeConnection.transactions, ["begin", "rollback", "begin", "commit"]);
});

test("§9 limite de retry: deadlock persistente esgota as tentativas e devolve erro CONTROLADO (sem detalhes internos)", async () => {
    reservationState();
    const base = fakeConnection.handler;
    fakeConnection.handler = (sql, params) => {
        if (/FOR UPDATE/.test(sql)) {
            const err: any = new Error("Deadlock found when trying to get lock");
            err.errno = 1213; err.code = "ER_LOCK_DEADLOCK";
            throw err;
        }
        return base(sql, params);
    };

    await assert.rejects(
        reservationDb.createReservation(1, "actor1", futureStart(), futureEnd()),
        (e: any) => e instanceof ConcurrencyError && e.code === "deadlock_retry_exhausted"
            && !/1213|ER_LOCK_DEADLOCK|SQL/i.test(e.message)
    );
    // 1 tentativa + 2 retries = 3 transações
    assert.equal(fakeConnection.transactions.filter((t) => t === "begin").length, 3);
});

test("§9 lock wait timeout (1205): NUNCA há retry automático — propaga imediatamente", async () => {
    reservationState();
    const base = fakeConnection.handler;
    let attempts = 0;
    fakeConnection.handler = (sql, params) => {
        if (/FOR UPDATE/.test(sql)) {
            attempts += 1;
            const err: any = new Error("Lock wait timeout exceeded");
            err.errno = 1205; err.code = "ER_LOCK_WAIT_TIMEOUT";
            throw err;
        }
        return base(sql, params);
    };

    await assert.rejects(reservationDb.createReservation(1, "actor1", futureStart(), futureEnd()));
    assert.equal(attempts, 1, "sem retry para lock wait timeout");
});

/* ================= transições CAS (§5) ================= */

function transitionState(row: any) {
    const state = { row: { ...row } };
    fakeConnection.handler = (sql: string, params?: any) => {
        if (/SET status = 'no_show'|SET status = 'overdue'/.test(sql) && !/WHERE id/.test(sql)) return [{}];
        if (/SELECT \*[\s\S]*FROM res_reservations/.test(sql)) {
            // devolve CÓPIA (como o mysql2) — o estado só muda via UPDATE
            return [[{ ...state.row }]];
        }
        if (/UPDATE res_reservations[\s\S]*SET status = 'completed'/.test(sql)) {
            const ok = ["in_use", "overdue"].includes(state.row.status);
            if (ok) state.row.status = "completed";
            return [{ affectedRows: ok ? 1 : 0 }];
        }
        if (/UPDATE res_reservations[\s\S]*SET status = 'cancelled'/.test(sql)) {
            const ok = ["pending", "approved"].includes(state.row.status);
            if (ok) state.row.status = "cancelled";
            return [{ affectedRows: ok ? 1 : 0 }];
        }
        if (/UPDATE res_reservations[\s\S]*SET status = 'in_use'/.test(sql)) {
            const ok = state.row.status === "approved" && !state.row.checkin_time;
            if (ok) { state.row.status = "in_use"; state.row.checkin_time = new Date(); }
            return [{ affectedRows: ok ? 1 : 0 }];
        }
        return [[]];
    };
    return state;
}

test("§5 checkout duplo: dois checkouts simultâneos → exatamente um vence; o outro recebe o erro sequencial", async () => {
    const state = transitionState({ id: 10, actor_id: "a", status: "in_use", checkin_time: new Date() });

    const results = await Promise.allSettled([
        reservationDb.checkOut(10, "a"),
        reservationDb.checkOut(10, "a"),
    ]);

    const ok = results.filter((r) => r.status === "fulfilled");
    const ko = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    assert.equal(ok.length, 1);
    assert.equal(ko.length, 1);
    assert.match(String(ko[0]!.reason?.message), /No active reservation to checkout/);
    assert.equal(state.row.status, "completed", "estado final válido — nunca um estado impossível");
});

test("§5 cancelamento vs início: check-in e cancelamento simultâneos → um vencedor; nunca 'cancelled' sobre 'in_use'", async () => {
    const soon = new Date(Date.now() + 25 * 3_600_000); // >24h → cancelável se approved
    const state = transitionState({ id: 11, actor_id: "a", status: "approved", checkin_time: null, start_time: soon });

    const results = await Promise.allSettled([
        reservationDb.checkIn(11, "a"),
        reservationDb.cancelReservation(11, "a"),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    assert.equal(fulfilled, 1, "exatamente uma transição vence");
    assert.ok(["in_use", "cancelled"].includes(state.row.status), `estado final coerente: ${state.row.status}`);
});

test("§5 cancelamento repetido: o segundo recebe conflito claro ('Reservation cannot be cancelled'), nunca duplo efeito", async () => {
    const state = transitionState({
        id: 12, actor_id: "a", status: "pending",
        start_time: new Date(Date.now() + 48 * 3_600_000),
    });

    await reservationDb.cancelReservation(12, "a");
    assert.equal(state.row.status, "cancelled");

    await assert.rejects(reservationDb.cancelReservation(12, "a"), /Reservation cannot be cancelled/);
});

test("§5 transição sobre reserva concluída: checkout de 'completed' falha de forma controlada", async () => {
    transitionState({ id: 13, actor_id: "a", status: "completed" });
    await assert.rejects(reservationDb.checkOut(13, "a"), /No active reservation to checkout/);
});

test("§5 overdue lazy vs checkout: o CAS aceita in_use E overdue — o checkout vence mesmo que o lazy update mude o estado entre o SELECT e o UPDATE", async () => {
    const state = transitionState({ id: 14, actor_id: "a", status: "in_use", checkin_time: new Date() });
    // simula o lazy update a correr "no meio": muda o estado para overdue
    state.row.status = "overdue";
    const result = await reservationDb.checkOut(14, "a");
    assert.equal(result.message, "Checkout successful");
    assert.equal(state.row.status, "completed");
});
