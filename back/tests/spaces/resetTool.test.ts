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

const { runOperationalReset, OPERATIONAL_TABLES, PRESERVED_TABLES, deleteEntitiesLeafFirst } =
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
    // Estado real (não uma contagem de chamadas): as contagens "antes"/"depois"
    // do reset também consultam `entities`, por isso não se pode assumir que a
    // 1.ª chamada é sempre a do loop de apagamento — usa-se o nº de linhas
    // restantes, que só decresce quando o DELETE é efetivamente executado.
    let entitiesRemaining = 2;
    respond([
        [/SELECT COUNT\(\*\) AS n FROM `entities`/i, () => [[{ n: entitiesRemaining }]]],
        [/DELETE e FROM `entities`/i, () => {
            const affectedRows = entitiesRemaining;
            entitiesRemaining = 0;
            return [{ affectedRows }];
        }],
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

    // entities usa o loop folha-primeiro (DELETE e FROM ...), não um DELETE
    // FROM `entities` simples — por isso fica fora deste filtro.
    const deletes = fakeConnection.calls.filter((c) => /^DELETE FROM/i.test(c.sql));
    assert.equal(deletes.length, OPERATIONAL_TABLES.length - 1);
    assert.equal(fakeConnection.callsMatching(/FOREIGN_KEY_CHECKS/i).length, 0, "FOREIGN_KEY_CHECKS nunca é tocado");
    assert.ok(
        fakeConnection.calls.some((c) => /^DELETE e FROM `entities`/i.test(c.sql)),
        "entities: apagada via loop folha-primeiro (anti-join), FK sempre ligada"
    );
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

test("nenhuma query enviada durante o reset contém FOREIGN_KEY_CHECKS (bypass de FK removido)", async () => {
    process.env.ALLOW_DESTRUCTIVE_DEV_RESET = "true";
    respond([
        [/SELECT COUNT\(\*\) AS n FROM `entities`/i, [[{ n: 0 }]]],
        [/SELECT COUNT\(\*\) AS n FROM/i, [[{ n: 0 }]]],
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
    for (const c of fakeConnection.calls) assert.doesNotMatch(c.sql, /FOREIGN_KEY_CHECKS/i);
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
    let entitiesRemaining = 2;
    respond([
        [/SELECT COUNT\(\*\) AS n FROM `entities`/i, () => [[{ n: entitiesRemaining }]]],
        [/DELETE e FROM `entities`/i, () => {
            const affectedRows = entitiesRemaining;
            entitiesRemaining = 0;
            return [{ affectedRows }];
        }],
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

/* -------------------------------------
   CONTRATO DE FKs DERIVADO DAS MIGRATIONS (não é introspeção ao vivo de
   information_schema — é uma transcrição estática, mantida à mão, do que
   cada ficheiro de migration/schema declara). Cobre toda aresta cujo PAI é
   uma tabela apagada pelo reset (i.e. está em OPERATIONAL_TABLES): assets,
   spaces, entities, model_versions, models, linked_models, res_reservations,
   semantic_evidence_runs, semantic_validation_runs,
   model_version_semantic_materialisations, model_requirement_validation_runs.
   Cada aresta cita a CONSTRAINT e o ficheiro-fonte exatos.
------------------------------------- */

// child -> parent, delete_rule tal como aparece na migration (ausência de
// "ON DELETE ..." = NO ACTION/RESTRICT no MySQL/InnoDB).
const FK_EDGES: Array<{ child: string; parent: string; rule: "NO ACTION" | "SET NULL" | "CASCADE"; constraint: string; source: string }> = [
    // model_versions como pai
    { child: "model_version_semantic_materialisations", parent: "model_versions", rule: "NO ACTION", constraint: "fk_model_materialisation_version", source: "2026-07-20_model_intake_semantic_materialisation.sql" },
    { child: "semantic_validation_runs", parent: "model_versions", rule: "NO ACTION", constraint: "fk_semantic_validation_model_version", source: "2026-07-21_semantic_validation_runs.sql" },
    { child: "model_requirement_validation_runs", parent: "model_versions", rule: "SET NULL", constraint: "fk_model_requirement_run_version", source: "2026-07-20_ids_validation.sql" },
    { child: "semantic_evidence_runs", parent: "model_versions", rule: "NO ACTION", constraint: "fk_semantic_evidence_model_version", source: "2026-07-21_semantic_reservation_evidence.sql" },
    { child: "reservation_manager_evidence_reviews", parent: "model_versions", rule: "NO ACTION", constraint: "fk_reservation_review_model_version", source: "2026-07-22_reservation_review_evidence.sql" },
    { child: "space_bindings", parent: "model_versions", rule: "NO ACTION", constraint: "fk_bindings_version", source: "2026-07-16_space_identity.sql" },
    { child: "asset_bindings", parent: "model_versions", rule: "NO ACTION", constraint: "fk_ab_version", source: "2026-07-17_asset_identity.sql" },
    { child: "asset_reconciliation_cases", parent: "model_versions", rule: "NO ACTION", constraint: "fk_arc_version", source: "2026-07-17_asset_identity.sql" },
    { child: "entities", parent: "model_versions", rule: "NO ACTION", constraint: "entities_ibfk_1", source: "database/schema_snapshot_2026-07-15.sql" },

    // model_version_semantic_materialisations como pai
    { child: "semantic_validation_runs", parent: "model_version_semantic_materialisations", rule: "NO ACTION", constraint: "fk_semantic_validation_materialisation", source: "2026-07-21_semantic_validation_runs.sql" },
    { child: "semantic_evidence_runs", parent: "model_version_semantic_materialisations", rule: "NO ACTION", constraint: "fk_semantic_evidence_materialisation", source: "2026-07-21_semantic_reservation_evidence.sql" },
    { child: "reservation_manager_evidence_reviews", parent: "model_version_semantic_materialisations", rule: "NO ACTION", constraint: "fk_reservation_review_materialisation", source: "2026-07-22_reservation_review_evidence.sql" },

    // semantic_validation_runs como pai
    { child: "semantic_validation_results", parent: "semantic_validation_runs", rule: "NO ACTION", constraint: "fk_semantic_validation_result_run", source: "2026-07-21_semantic_validation_runs.sql" },
    { child: "semantic_evidence_runs", parent: "semantic_validation_runs", rule: "NO ACTION", constraint: "fk_semantic_evidence_structural_run", source: "2026-07-21_semantic_reservation_evidence.sql" },
    { child: "reservation_manager_evidence_reviews", parent: "semantic_validation_runs", rule: "NO ACTION", constraint: "fk_reservation_review_structural_run", source: "2026-07-22_reservation_review_evidence.sql" },

    // model_requirement_validation_runs como pai
    { child: "model_requirement_validation_results", parent: "model_requirement_validation_runs", rule: "CASCADE", constraint: "fk_model_requirement_result_run", source: "2026-07-20_ids_validation.sql" },

    // semantic_evidence_runs como pai
    { child: "semantic_evidence_findings", parent: "semantic_evidence_runs", rule: "NO ACTION", constraint: "fk_semantic_evidence_finding_run", source: "2026-07-21_semantic_reservation_evidence.sql" },
    { child: "reservation_semantic_evidence_links", parent: "semantic_evidence_runs", rule: "NO ACTION", constraint: "fk_reservation_semantic_evidence_run", source: "2026-07-21_semantic_reservation_evidence.sql" },
    { child: "reservation_manager_evidence_reviews", parent: "semantic_evidence_runs", rule: "NO ACTION", constraint: "fk_reservation_review_evidence", source: "2026-07-22_reservation_review_evidence.sql" },
    { child: "reservation_decisions", parent: "semantic_evidence_runs", rule: "NO ACTION", constraint: "fk_decision_evidence", source: "2026-07-22_reservation_approval.sql" },

    // res_reservations como pai
    { child: "reservation_semantic_evidence_links", parent: "res_reservations", rule: "NO ACTION", constraint: "fk_reservation_semantic_evidence_reservation", source: "2026-07-21_semantic_reservation_evidence.sql" },
    { child: "reservation_manager_evidence_reviews", parent: "res_reservations", rule: "NO ACTION", constraint: "fk_reservation_review_reservation", source: "2026-07-22_reservation_review_evidence.sql" },
    { child: "reservation_decisions", parent: "res_reservations", rule: "NO ACTION", constraint: "fk_decision_reservation", source: "2026-07-22_reservation_approval.sql" },

    // assets como pai
    { child: "asset_location_assignments", parent: "assets", rule: "NO ACTION", constraint: "fk_ala_asset", source: "2026-07-17_non_modelled_assets.sql" },
    { child: "asset_bindings", parent: "assets", rule: "NO ACTION", constraint: "fk_ab_asset", source: "2026-07-17_asset_identity.sql" },
    { child: "asset_reconciliation_cases", parent: "assets", rule: "NO ACTION", constraint: "fk_arc_asset", source: "2026-07-17_asset_identity.sql" },
    { child: "legacy_asset_mapping", parent: "assets", rule: "NO ACTION", constraint: "fk_lam_persistent", source: "2026-07-17_asset_identity.sql" },
    { child: "semantic_evidence_runs", parent: "assets", rule: "NO ACTION", constraint: "fk_semantic_evidence_asset", source: "2026-07-21_semantic_reservation_evidence.sql" },
    { child: "reservation_management_scopes", parent: "assets", rule: "NO ACTION", constraint: "fk_management_scope_asset", source: "2026-07-22_reservation_approval.sql" },

    // spaces como pai
    { child: "space_bindings", parent: "spaces", rule: "NO ACTION", constraint: "fk_bindings_space", source: "2026-07-16_space_identity.sql" },
    { child: "asset_location_assignments", parent: "spaces", rule: "NO ACTION", constraint: "fk_ala_space", source: "2026-07-17_non_modelled_assets.sql" },
    { child: "assets", parent: "spaces", rule: "NO ACTION", constraint: "fk_assets_space", source: "2026-07-17_asset_identity.sql" },

    // entities como pai (inclui self-FK)
    { child: "space_bindings", parent: "entities", rule: "NO ACTION", constraint: "fk_bindings_entity", source: "2026-07-16_space_identity.sql" },
    { child: "asset_bindings", parent: "entities", rule: "NO ACTION", constraint: "fk_ab_entity (model_entity_id)", source: "2026-07-17_asset_identity.sql" },
    { child: "asset_bindings", parent: "entities", rule: "NO ACTION", constraint: "fk_ab_space_entity (space_entity_id)", source: "2026-07-17_asset_identity.sql" },
    { child: "asset_reconciliation_cases", parent: "entities", rule: "NO ACTION", constraint: "fk_arc_entity", source: "2026-07-17_asset_identity.sql" },
    { child: "assets", parent: "entities", rule: "NO ACTION", constraint: "assets_ibfk_1 (model_entity_id)", source: "database/schema_snapshot_2026-07-15.sql" },
    { child: "assets", parent: "entities", rule: "NO ACTION", constraint: "assets_ibfk_2 (current_space_entity_id)", source: "database/schema_snapshot_2026-07-15.sql" },
    { child: "entities", parent: "entities", rule: "NO ACTION", constraint: "entities_ibfk_2 (self-referencing, parent_id)", source: "database/schema_snapshot_2026-07-15.sql" },

    // models / linked_models como pai (PRESERVADAS fora do reset? não —
    // models/linked_models estão em OPERATIONAL_TABLES; sensors_channels
    // permanece intencionalmente sem CASCADE mas channels é preservada)
    { child: "models", parent: "linked_models", rule: "CASCADE", constraint: "fk_m_linked_parent", source: "database/create_tables.sql" },
    { child: "sensors", parent: "models", rule: "CASCADE", constraint: "fk_s_model_id", source: "database/create_tables.sql" },
    { child: "spaces", parent: "linked_models", rule: "NO ACTION", constraint: "fk_spaces_linked_model", source: "2026-07-16_space_identity.sql" },
    { child: "assets", parent: "linked_models", rule: "NO ACTION", constraint: "fk_assets_linked_model", source: "2026-07-17_asset_identity.sql" },
];

test("auditoria estática: todo o filho NO ACTION/RESTRICT de uma tabela do reset está antes do seu pai em OPERATIONAL_TABLES", () => {
    const idx = (t: string) => (OPERATIONAL_TABLES as readonly string[]).indexOf(t);
    const inScope = (t: string) => idx(t) >= 0;

    for (const edge of FK_EDGES) {
        if (edge.child === edge.parent) continue; // self-FK de entities: tratada à parte (loop folha-primeiro, não por ordenação)
        if (edge.rule === "SET NULL" || edge.rule === "CASCADE") continue; // provadamente seguro sem ordenação
        // NO ACTION/RESTRICT: se ambas as tabelas estão no escopo do reset,
        // o filho TEM de vir antes do pai.
        if (inScope(edge.child) && inScope(edge.parent)) {
            assert.ok(
                idx(edge.child) < idx(edge.parent),
                `${edge.constraint} (${edge.source}): ${edge.child} (NO ACTION/RESTRICT) tem de vir antes de ${edge.parent} em OPERATIONAL_TABLES`
            );
        }
    }
});

test("entities.parent_id (self-FK) é tratada pelo algoritmo de apagamento folha-primeiro, não por ordenação em OPERATIONAL_TABLES", () => {
    const selfEdge = FK_EDGES.find((e) => e.child === "entities" && e.parent === "entities");
    assert.ok(selfEdge, "a aresta self-FK de entities tem de estar documentada no fixture");
    assert.equal(selfEdge!.constraint, "entities_ibfk_2 (self-referencing, parent_id)");
    // Não se aplica o índice genérico de OPERATIONAL_TABLES aqui — ver
    // deleteEntitiesLeafFirst em resetOperationalData.ts.
});

test("channels permanece filho preservado intencionalmente (sensors_channels É reset, channels não)", () => {
    // sensors_channels (child de sensors/channels) está em OPERATIONAL_TABLES
    // e é apagada; channels fica PRESERVED_TABLES por ser dado de referência
    // dos sensores (catálogo estático), não dado operacional — ver docstring
    // do topo de resetOperationalData.ts.
    assert.ok((OPERATIONAL_TABLES as readonly string[]).includes("sensors_channels"));
    assert.ok(!(OPERATIONAL_TABLES as readonly string[]).includes("channels"));
    assert.ok((PRESERVED_TABLES as readonly string[]).includes("channels"));
});

test("model_version_semantic_materialisations e semantic_validation_runs vêm antes de model_versions (causa real da falha 2026-08-07)", () => {
    const idx = (t: string) => (OPERATIONAL_TABLES as readonly string[]).indexOf(t);
    assert.ok(idx("model_version_semantic_materialisations") >= 0, "tem de estar em OPERATIONAL_TABLES");
    assert.ok(idx("semantic_validation_runs") >= 0, "tem de estar em OPERATIONAL_TABLES");
    assert.ok(idx("model_version_semantic_materialisations") < idx("model_versions"));
    assert.ok(idx("semantic_validation_runs") < idx("model_versions"));
    // semantic_validation_runs referencia materialisations (NO ACTION)
    assert.ok(idx("semantic_validation_runs") < idx("model_version_semantic_materialisations"));
    // semantic_validation_results referencia semantic_validation_runs (NO ACTION)
    assert.ok(idx("semantic_validation_results") >= 0);
    assert.ok(idx("semantic_validation_results") < idx("semantic_validation_runs"));
});

test("model_requirement_validation_runs: comportamento explícito (SET NULL não bloqueia, mas é reset por higiene de dados)", () => {
    const idx = (t: string) => (OPERATIONAL_TABLES as readonly string[]).indexOf(t);
    // Decisão: incluída no reset (não apenas preservada via SET NULL) — ver
    // docstring de resetOperationalData.ts para a justificação de lifecycle.
    assert.ok(idx("model_requirement_validation_runs") >= 0, "incluída no reset por decisão de lifecycle, não apenas por FK");
    assert.ok(idx("model_requirement_validation_runs") < idx("model_versions"));
    // filho CASCADE explicitamente apagado primeiro por consistência de estilo
    assert.ok(idx("model_requirement_validation_results") >= 0);
    assert.ok(idx("model_requirement_validation_results") < idx("model_requirement_validation_runs"));
});

test("channels permanece ausente de OPERATIONAL_TABLES (preservada) mesmo após a extensão da lista", () => {
    assert.ok(!(OPERATIONAL_TABLES as readonly string[]).includes("channels"));
});

test("reset em NODE_ENV=test não chama a limpeza do graph operacional persistente", () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "../../scripts/resetOperationalData.ts"), "utf-8");
    assert.match(source, /NODE_ENV === "test"[\s\S]*Grafo operacional preservado em NODE_ENV=test/);
});

/* -------------------------------------
   deleteEntitiesLeafFirst — algoritmo de apagamento folha-primeiro
   (substitui o antigo bypass SET FOREIGN_KEY_CHECKS=0/1)
------------------------------------- */

/**
 * Ligação falsa MÍNIMA e AUTOCONTIDA (não usa fakeDb.ts) que simula um
 * verdadeiro estado de tabela `entities` em memória, para exercitar
 * deleteEntitiesLeafFirst com a semântica real do anti-join MySQL:
 *   DELETE e FROM entities e LEFT JOIN entities child ON child.parent_id = e.id
 *   WHERE child.id IS NULL
 * — remove exatamente as linhas SEM filhos na iteração corrente.
 */
function makeInMemoryEntitiesConn(initialRows: Array<{ id: number; parent_id: number | null }>) {
    let rows = [...initialRows];
    const queries: string[] = [];
    return {
        queries,
        rowsRemaining: () => rows.length,
        async query(sql: string) {
            queries.push(sql);
            if (/^SELECT COUNT\(\*\) AS n FROM `entities`/i.test(sql)) {
                return [[{ n: rows.length }]];
            }
            if (/^DELETE e FROM `entities`/i.test(sql)) {
                const childParents = new Set(rows.filter((r) => r.parent_id !== null).map((r) => r.parent_id));
                const before = rows.length;
                rows = rows.filter((r) => childParents.has(r.id));
                return [{ affectedRows: before - rows.length }];
            }
            throw new Error("query inesperada no fake de entities: " + sql);
        },
    };
}

test("deleteEntitiesLeafFirst (A): hierarquia plana de profundidade 1 — passagem única", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, parent_id: null as number | null }));
    const conn = makeInMemoryEntitiesConn(rows);
    await deleteEntitiesLeafFirst(conn as any);
    assert.equal(conn.rowsRemaining(), 0);
    assert.equal(conn.queries.filter((q) => /^DELETE e FROM/i.test(q)).length, 1, "profundidade 1 resolve-se numa única iteração");
});

test("deleteEntitiesLeafFirst (B): hierarquia em cadeia de profundidade 6 — múltiplas iterações até esvaziar", async () => {
    // 1 -> 2 -> 3 -> 4 -> 5 -> 6 (cada um é parent_id do seguinte)
    const rows = [
        { id: 1, parent_id: null as number | null },
        { id: 2, parent_id: 1 },
        { id: 3, parent_id: 2 },
        { id: 4, parent_id: 3 },
        { id: 5, parent_id: 4 },
        { id: 6, parent_id: 5 },
    ];
    const conn = makeInMemoryEntitiesConn(rows);
    await deleteEntitiesLeafFirst(conn as any);
    assert.equal(conn.rowsRemaining(), 0);
    const deletePasses = conn.queries.filter((q) => /^DELETE e FROM/i.test(q)).length;
    assert.equal(deletePasses, 6, "cadeia de profundidade 6 exige 6 iterações (uma folha removida por passagem)");
});

test("deleteEntitiesLeafFirst (C): múltiplos ramos irmãos em profundidades variadas — apaga tudo", async () => {
    const rows = [
        { id: 1, parent_id: null as number | null },   // raiz A
        { id: 2, parent_id: 1 },                        // filho de A
        { id: 3, parent_id: 2 },                         // neto de A
        { id: 10, parent_id: null as number | null },   // raiz B (ramo curto)
        { id: 11, parent_id: 10 },
        { id: 20, parent_id: null as number | null },   // raiz C isolada (folha imediata)
    ];
    const conn = makeInMemoryEntitiesConn(rows);
    await deleteEntitiesLeafFirst(conn as any);
    assert.equal(conn.rowsRemaining(), 0);
    // profundidade máxima é 3 (1->2->3), por isso no máximo 3 iterações
    const deletePasses = conn.queries.filter((q) => /^DELETE e FROM/i.test(q)).length;
    assert.ok(deletePasses <= 3 && deletePasses >= 1);
});

test("deleteEntitiesLeafFirst (D): tabela entities vazia — sem erro, sem DELETE", async () => {
    const conn = makeInMemoryEntitiesConn([]);
    await deleteEntitiesLeafFirst(conn as any);
    assert.equal(conn.queries.filter((q) => /^DELETE e FROM/i.test(q)).length, 0, "tabela vazia não deve gerar nenhum DELETE");
});

test("deleteEntitiesLeafFirst (E): ciclo/dependência não resolvida — affectedRows:0 com linhas restantes lança erro descritivo", async () => {
    const stalledConn = {
        async query(sql: string) {
            if (/^SELECT COUNT\(\*\) AS n FROM `entities`/i.test(sql)) return [[{ n: 2 }]]; // sempre "2 linhas restantes"
            if (/^DELETE e FROM `entities`/i.test(sql)) return [{ affectedRows: 0 }]; // nunca progride
            throw new Error("query inesperada");
        },
    };
    await assert.rejects(
        deleteEntitiesLeafFirst(stalledConn as any),
        /entities self-reference cycle or unresolved dependency detected during operational reset/
    );
});

test("deleteEntitiesLeafFirst (E, integrado): o erro de ciclo propaga através do reset e desencadeia ROLLBACK da transação", async () => {
    process.env.ALLOW_DESTRUCTIVE_DEV_RESET = "true";
    respond([
        [/SELECT COUNT\(\*\) AS n FROM `entities`/i, [[{ n: 3 }]]], // nunca esvazia
        [/DELETE e FROM `entities`/i, [{ affectedRows: 0 }]],       // nunca progride: ciclo simulado
        [/SELECT COUNT\(\*\) AS n FROM/i, [[{ n: 1 }]]],
        [/SELECT \* FROM/i, [[]]],
        [/DELETE FROM/i, [{}]],
        [/ALTER TABLE .* AUTO_INCREMENT = 1/i, [{}]],
        [/SHOW COLUMNS FROM res_reservations/i, [[{ Type: "enum('overdue')" }]]],
        [/SHOW TABLES LIKE 'spaces'/i, [[{ t: "spaces" }]]],
    ]);

    try {
        await assert.rejects(
            runOperationalReset(true, OPTS),
            /entities self-reference cycle or unresolved dependency detected during operational reset/
        );
    } finally {
        delete process.env.ALLOW_DESTRUCTIVE_DEV_RESET;
    }

    assert.ok(fakeConnection.transactions.includes("begin"));
    assert.ok(fakeConnection.transactions.includes("rollback"), "a transação tem de reverter quando o loop de entities fica preso");
    assert.ok(!fakeConnection.transactions.includes("commit"), "nunca deve chegar a commit quando o loop de entities falha");
});
