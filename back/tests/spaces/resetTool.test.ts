/**
 * Revisão do Prompt 3 — script de reset operacional (dry-run, proteções,
 * ordem segura de FKs, preservações, idempotência, sem seeds).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeMySQL, fakeConnection, respond } from "../helpers/fakeDb.ts";

installFakeMySQL();

const { runOperationalReset, OPERATIONAL_TABLES, PRESERVED_TABLES } =
    await import("../../scripts/resetOperationalData.ts");

beforeEach(() => fakeConnection.reset());

/* -------------------------------------
   SCRIPT DE RESET
------------------------------------- */

const COUNT_ROUTES: [RegExp, any][] = [[/SELECT COUNT\(\*\) AS n FROM/i, [[{ n: 7 }]]]];

test("reset em --dry-run não escreve nada", async () => {
    respond(COUNT_ROUTES);

    await runOperationalReset(false);

    assert.equal(fakeConnection.callsMatching(/DELETE|TRUNCATE|DROP|ALTER/i).length, 0);
});

test("reset --apply sem ALLOW_DESTRUCTIVE_DEV_RESET falha de forma controlada", async () => {
    delete process.env.ALLOW_DESTRUCTIVE_DEV_RESET;
    await assert.rejects(runOperationalReset(true), /ALLOW_DESTRUCTIVE_DEV_RESET/);
});

test("reset --apply limpa as tabelas operacionais por ordem segura de FKs, preserva channels e o schema", async () => {
    process.env.ALLOW_DESTRUCTIVE_DEV_RESET = "true";
    respond([
        [/SELECT COUNT\(\*\) AS n FROM/i, [[{ n: 3 }]]],
        [/SELECT \* FROM/i, [[]]],
        [/DELETE FROM/i, [{}]],
        [/ALTER TABLE .* AUTO_INCREMENT = 1/i, [{}]],
        [/SHOW COLUMNS FROM res_reservations/i, [[{ Type: "enum('pending','approved','rejected','cancelled','in_use','no_show','completed','overdue')" }]]],
        [/SHOW TABLES LIKE 'spaces'/i, [[{ t: "spaces" }]]],
    ]);

    try {
        await runOperationalReset(true);
    } finally {
        delete process.env.ALLOW_DESTRUCTIVE_DEV_RESET;
    }

    const deletes = fakeConnection.calls.filter((c) => /^DELETE FROM/i.test(c.sql));
    // +1: entities tem um DELETE extra (filhas com parent_id antes das raízes)
    assert.equal(deletes.length, OPERATIONAL_TABLES.length + 1);
    assert.match(deletes[0]!.sql, /space_bindings/, "filhos antes dos pais");
    assert.match(deletes[deletes.length - 1]!.sql, /linked_models/);

    // channels preservada (sensors_channels é operacional e É limpa); nenhum
    // DROP/ENUM/coluna tocada; nenhum INSERT (sem seeds)
    for (const d of deletes) assert.doesNotMatch(d.sql, /DELETE FROM `channels`/i);
    assert.equal(fakeConnection.callsMatching(/DROP|MODIFY|ADD COLUMN|TRUNCATE/i).length, 0);
    assert.equal(fakeConnection.callsMatching(/INSERT INTO/i).length, 0, "nenhum dado fictício");

    assert.ok(fakeConnection.transactions.includes("begin") && fakeConnection.transactions.includes("commit"));
});

test("segunda execução do reset é segura (idempotente: DELETE sobre tabelas vazias)", async () => {
    process.env.ALLOW_DESTRUCTIVE_DEV_RESET = "true";
    respond([
        [/SELECT COUNT\(\*\) AS n FROM/i, [[{ n: 0 }]]],
        [/SELECT \* FROM/i, [[]]],
        [/DELETE FROM/i, [{}]],
        [/ALTER TABLE .* AUTO_INCREMENT = 1/i, [{}]],
        [/SHOW COLUMNS FROM res_reservations/i, [[{ Type: "enum('overdue')" }]]],
        [/SHOW TABLES LIKE 'spaces'/i, [[{ t: "spaces" }]]],
    ]);

    try {
        await runOperationalReset(true);
        await assert.doesNotReject(async () => { /* já correu uma vez acima */ });
    } finally {
        delete process.env.ALLOW_DESTRUCTIVE_DEV_RESET;
    }
});

test("tabelas preservadas documentadas: channels (referência); não existem tabelas de utilizadores/papéis", () => {
    assert.deepEqual([...PRESERVED_TABLES], ["channels"]);
    assert.ok(!([...OPERATIONAL_TABLES] as string[]).includes("channels"));
});
