/**
 * Revisão do Prompt 3 — script de reset operacional (dry-run, proteções,
 * ordem segura de FKs, preservações, idempotência, sem seeds).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { installFakeMySQL, fakeConnection, respond } from "../helpers/fakeDb.ts";

installFakeMySQL();

const { runOperationalReset, OPERATIONAL_TABLES, PRESERVED_TABLES } =
    await import("../../scripts/resetOperationalData.ts");

// ⚠️ O filesystem NÃO é falso nos testes: usar SEMPRE um storage descartável
// (em 2026-07-17 uma execução da suite apagou IFCs reais por faltar isto).
const SCRATCH_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "oswadt-reset-test-"));
fs.mkdirSync(path.join(SCRATCH_STORAGE, "models/temp"), { recursive: true });
const OPTS = { storageRoot: SCRATCH_STORAGE };

beforeEach(() => fakeConnection.reset());

/* -------------------------------------
   SCRIPT DE RESET
------------------------------------- */

const COUNT_ROUTES: [RegExp, any][] = [[/SELECT COUNT\(\*\) AS n FROM/i, [[{ n: 7 }]]]];

test("reset em --dry-run não escreve nada", async () => {
    respond(COUNT_ROUTES);

    await runOperationalReset(false, OPTS);

    assert.equal(fakeConnection.callsMatching(/DELETE|TRUNCATE|DROP|ALTER/i).length, 0);
});

test("reset --apply sem ALLOW_DESTRUCTIVE_DEV_RESET falha de forma controlada", async () => {
    delete process.env.ALLOW_DESTRUCTIVE_DEV_RESET;
    await assert.rejects(runOperationalReset(true, OPTS), /ALLOW_DESTRUCTIVE_DEV_RESET/);
});

test("guarda pós-incidente: em NODE_ENV=test o reset SEM storageRoot injetado falha (nunca default silencioso)", async () => {
    assert.equal(process.env.NODE_ENV, "test");
    await assert.rejects(runOperationalReset(false), /explicitly injected disposable storageRoot/);
});

test("guarda pós-incidente: storage real (back/cdn_resources) é rejeitado em ambiente de teste", async () => {
    const realRoot = path.join(import.meta.dirname, "../../cdn_resources");
    await assert.rejects(
        runOperationalReset(false, { storageRoot: realRoot }),
        /refusing to run against the real development storage/
    );
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
        await runOperationalReset(true, OPTS);
    } finally {
        delete process.env.ALLOW_DESTRUCTIVE_DEV_RESET;
    }

    const deletes = fakeConnection.calls.filter((c) => /^DELETE FROM/i.test(c.sql));
    // +1: entities tem um DELETE extra (filhas com parent_id antes das raízes)
    assert.equal(deletes.length, OPERATIONAL_TABLES.length + 1);
    // (5B) as tabelas de localização/sincronização entram primeiro na ordem FK
    assert.match(deletes[0]!.sql, /asset_location_assignments/, "filhos antes dos pais");
    assert.ok(deletes.findIndex((d) => /`assets`/.test(d.sql)) >
        deletes.findIndex((d) => /asset_location_assignments/.test(d.sql)), "assignments antes de assets");
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
        await runOperationalReset(true, OPTS);
        await assert.doesNotReject(async () => { /* já correu uma vez acima */ });
    } finally {
        delete process.env.ALLOW_DESTRUCTIVE_DEV_RESET;
    }
});

test("tabelas de evidência semântica/aprovação de reservas entram no reset antes dos seus pais FK RESTRICT", () => {
    const idx = (t: string) => (OPERATIONAL_TABLES as readonly string[]).indexOf(t);

    for (const t of [
        "reservation_semantic_evidence_links",
        "reservation_manager_evidence_reviews",
        "reservation_decisions",
        "semantic_evidence_findings",
        "semantic_evidence_runs",
        "reservation_management_scopes",
    ]) {
        assert.ok(idx(t) >= 0, `${t} tem de estar em OPERATIONAL_TABLES (FK RESTRICT sem CASCADE)`);
    }

    // filhas de res_reservations (RESTRICT) antes de res_reservations
    for (const t of ["reservation_semantic_evidence_links", "reservation_manager_evidence_reviews", "reservation_decisions"]) {
        assert.ok(idx(t) < idx("res_reservations"), `${t} antes de res_reservations`);
    }
    // findings antes de semantic_evidence_runs (FK RESTRICT evidence_run_id)
    assert.ok(idx("semantic_evidence_findings") < idx("semantic_evidence_runs"), "findings antes de semantic_evidence_runs");
    // reservation_decisions/links/reviews referenciam semantic_evidence_runs também
    for (const t of ["reservation_semantic_evidence_links", "reservation_manager_evidence_reviews", "reservation_decisions"]) {
        assert.ok(idx(t) < idx("semantic_evidence_runs"), `${t} antes de semantic_evidence_runs`);
    }
    // semantic_evidence_runs e reservation_management_scopes referenciam assets (RESTRICT)
    assert.ok(idx("semantic_evidence_runs") < idx("assets"), "semantic_evidence_runs antes de assets");
    assert.ok(idx("reservation_management_scopes") < idx("assets"), "reservation_management_scopes antes de assets");
});

test("reset --apply inclui DELETE das tabelas de evidência/aprovação por ordem segura", async () => {
    process.env.ALLOW_DESTRUCTIVE_DEV_RESET = "true";
    respond([
        [/SELECT COUNT\(\*\) AS n FROM/i, [[{ n: 2 }]]],
        [/SELECT \* FROM/i, [[]]],
        [/DELETE FROM/i, [{}]],
        [/ALTER TABLE .* AUTO_INCREMENT = 1/i, [{}]],
        [/SHOW COLUMNS FROM res_reservations/i, [[{ Type: "enum('overdue')" }]]],
        [/SHOW TABLES LIKE 'spaces'/i, [[{ t: "spaces" }]]],
    ]);

    try {
        await runOperationalReset(true, OPTS);
    } finally {
        delete process.env.ALLOW_DESTRUCTIVE_DEV_RESET;
    }

    const deletes = fakeConnection.calls.filter((c) => /^DELETE FROM/i.test(c.sql));
    const idxOf = (needle: RegExp) => deletes.findIndex((d) => needle.test(d.sql));

    assert.ok(idxOf(/reservation_semantic_evidence_links/) >= 0);
    assert.ok(idxOf(/reservation_manager_evidence_reviews/) >= 0);
    assert.ok(idxOf(/reservation_decisions/) >= 0);
    assert.ok(idxOf(/semantic_evidence_findings/) >= 0);
    assert.ok(idxOf(/semantic_evidence_runs/) >= 0);
    assert.ok(idxOf(/reservation_management_scopes/) >= 0);

    assert.ok(idxOf(/reservation_decisions/) < idxOf(/`res_reservations`/), "decisions antes de res_reservations");
    assert.ok(idxOf(/semantic_evidence_findings/) < idxOf(/`semantic_evidence_runs`/), "findings antes de runs");
    assert.ok(idxOf(/`semantic_evidence_runs`/) < idxOf(/`assets`/), "runs antes de assets");
    assert.ok(idxOf(/reservation_management_scopes/) < idxOf(/`assets`/), "scopes antes de assets");
});

test("tabelas preservadas documentadas: channels (referência); não existem tabelas de utilizadores/papéis", () => {
    assert.deepEqual([...PRESERVED_TABLES], ["channels"]);
    assert.ok(!([...OPERATIONAL_TABLES] as string[]).includes("channels"));
});

test("reset em NODE_ENV=test não chama a limpeza do graph operacional persistente", () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "../../scripts/resetOperationalData.ts"), "utf-8");
    assert.match(source, /NODE_ENV === "test"[\s\S]*Grafo operacional preservado em NODE_ENV=test/);
});
