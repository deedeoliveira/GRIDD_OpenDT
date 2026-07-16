/**
 * Testes do planeamento de backfill (Prompt 2) — lógica pura, sem BD/ficheiros.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { planBackfill, parseArchiveFileName, type VersionRow } from "../../scripts/lib/backfillPlanner.ts";

function v(id: number, model_id: number, backfilled = false): VersionRow {
    return {
        id, model_id, created_at: new Date(2026, 0, id),
        version_number: backfilled ? id : null,
        status: backfilled ? "archived" : null,
        storage_key: null,
    };
}

test("parseArchiveFileName: extrai timestamp e modelId; rejeita nomes fora do padrão", () => {
    const parsed = parseArchiveFileName("1784135203791_3.ifc")!;
    assert.equal(parsed.modelId, 3);
    assert.equal(parsed.archivedAtMs, 1784135203791);
    assert.equal(parseArchiveFileName("nao-e-archive.ifc"), null);
});

test("versão corrente com ficheiro legado → current_file_associated, active e is_current", () => {
    const { plans } = planBackfill([v(1, 1)], new Set([1]), []);

    assert.equal(plans.length, 1);
    assert.equal(plans[0]!.classification, "current_file_associated");
    assert.equal(plans[0]!.storageKey, "models/1.ifc");
    assert.equal(plans[0]!.status, "active");
    assert.equal(plans[0]!.isCurrent, true);
    assert.equal(plans[0]!.versionNumber, 1);
});

test("números de versão sequenciais por modelo; modelos distintos podem ambos ter versão 1", () => {
    const { plans } = planBackfill([v(10, 1), v(11, 1), v(20, 2)], new Set([1, 2]), []);

    const model1 = plans.filter((p) => p.modelId === 1).map((p) => p.versionNumber);
    const model2 = plans.filter((p) => p.modelId === 2).map((p) => p.versionNumber);
    assert.deepEqual(model1, [1, 2]);
    assert.deepEqual(model2, [1]);
});

test("archives associados ordinalmente APENAS quando a contagem é exata (não inventar histórico)", () => {
    const archives = [
        parseArchiveFileName("2000000000_3.ifc")!,
        parseArchiveFileName("1000000000_3.ifc")!,
    ];
    const { plans, orphanArchives } = planBackfill([v(1, 3), v(2, 3), v(3, 3)], new Set([3]), archives);

    // 2 archives ↔ 2 versões históricas: ordinal por timestamp crescente
    assert.equal(plans[0]!.classification, "historical_file_associated");
    assert.equal(plans[0]!.storageKey, "models/archive/1000000000_3.ifc");
    assert.equal(plans[1]!.classification, "historical_file_associated");
    assert.equal(plans[1]!.storageKey, "models/archive/2000000000_3.ifc");
    assert.equal(orphanArchives.length, 0);
});

test("contagem divergente de archives → ambiguous_file, nada associado, archives ficam órfãos", () => {
    const archives = [
        parseArchiveFileName("1000000000_2.ifc")!,
        parseArchiveFileName("2000000000_2.ifc")!,
        parseArchiveFileName("3000000000_2.ifc")!,
    ];
    const { plans, orphanArchives } = planBackfill([v(1, 2), v(2, 2)], new Set([2]), archives);

    assert.equal(plans[0]!.classification, "ambiguous_file");
    assert.equal(plans[0]!.storageKey, null);
    assert.equal(orphanArchives.length, 3);
});

test("versão histórica sem archives → missing_file (histórico não recuperável, sem metadados falsos)", () => {
    const { plans } = planBackfill([v(1, 5), v(2, 5)], new Set([5]), []);

    assert.equal(plans[0]!.classification, "missing_file");
    assert.equal(plans[0]!.storageKey, null);
    assert.equal(plans[0]!.note, "histórico não recuperável");
});

test("versão corrente sem ficheiro legado → missing_file diagnosticado", () => {
    const { plans } = planBackfill([v(1, 9)], new Set(), []);

    assert.equal(plans[0]!.classification, "missing_file");
    assert.equal(plans[0]!.note, "ficheiro corrente legado inexistente");
});

test("segunda execução: linhas já preenchidas ficam already_backfilled (no-op seguro)", () => {
    const { plans } = planBackfill([v(1, 1, true)], new Set([1]), []);

    assert.equal(plans[0]!.classification, "already_backfilled");
});
