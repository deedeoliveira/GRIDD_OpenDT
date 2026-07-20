/**
 * Concorrência dos ativos NÃO modelados (Prompt 6, §8/§11.3/§11.4; ADR-0031).
 *
 * Locks emulados pelo fakeDb: GET_LOCK (nomeado, por conexão do pool) e
 * FOR UPDATE (linha). Os fakes 5B emulam também os UNIQUEs reais:
 * (operation_type, idempotency_key) e o funcional uq_assets_graph_manager_code.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fakeConnection } from "../helpers/fakeDb.ts";
import { FakeOperationalGraph } from "../helpers/fakeOperationalGraph.ts";
import { installNonModelledEnv, freshState, registerCommand, fixedEvaluator } from "../helpers/nonModelledTestSetup.ts";
import type { FakeSqlState } from "../helpers/fakeNonModelledSql.ts";

installNonModelledEnv();

const graph = new FakeOperationalGraph();
const graphProvider = await import("../../graph/graphClientProvider.ts");
const policies = await import("../../policies/policyProvider.ts");
const registration = (await import("../../services/nonModelledAssetRegistrationService.ts")).default;
const location = (await import("../../services/nonModelledAssetLocationService.ts")).default;
const reconciliation = (await import("../../services/graphSqlReconciliationService.ts")).default;

let state: FakeSqlState;

function resetAll() {
    graph.reset();
    fakeConnection.reset();
    state = freshState();
    fakeConnection.handler = state.handler;
    graphProvider.setGraphClient(graph as any);
    policies.resetPolicyProviders();
    policies.setReservabilityEvaluator(fixedEvaluator("allow") as any);
}

beforeEach(resetAll);

function countAssetResources(): number {
    return graph.triples.filter((t) =>
        t.p === "http://www.w3.org/1999/02/22-rdf-syntax-ns#type" && /NonModelledAsset>?$/.test(t.o)).length;
}

/* ================= §8.1/§11.3 — registo com a mesma registrationKey ================= */

test("§11.3 registos simultâneos com a MESMA chave e payload convergem: UMA operação, UM asset_uuid, UMA URI, UMA projeção, UM recurso RDF", async () => {
    for (let i = 0; i < 10; i++) {
        resetAll();

        const cmd = registerCommand({ registrationKey: `race-key-${i}` });
        const [a, b] = await Promise.all([
            registration.register(cmd),
            registration.register({ ...cmd }),
        ]);

        assert.equal(a.assetUuid, b.assetUuid, `iteração ${i}: mesmo asset_uuid`);
        assert.equal(a.assetUri, b.assetUri, "mesma URI permanente");
        assert.equal(a.operation.operationUuid, b.operation.operationUuid, "mesma operação");
        assert.equal(state.ops.length, 1, "uma única operação em SQL");
        assert.equal(state.assets.length, 1, "uma única projeção SQL");
        assert.equal(countAssetResources(), 1, "um único recurso no grafo");
        assert.equal(state.ops[0].attempt_count, 1,
            "o perdedor convergiu SEM retomada efetiva — attempt_count não infla");
    }
});

test("§8.1 mesma chave com payload DIFERENTE sob corrida → um vence, o outro recebe 409 idempotency_conflict", async () => {
    const [a, b] = await Promise.allSettled([
        registration.register(registerCommand({ registrationKey: "k-div", name: "Projetor A" })),
        registration.register(registerCommand({ registrationKey: "k-div", name: "Projetor B" })),
    ]);

    const fulfilled = [a, b].filter((r) => r.status === "fulfilled");
    const rejected = [a, b].filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal((rejected[0]!.reason as any).code, "idempotency_conflict");
    assert.equal(state.assets.length, 1);
});

/* ================= §8.2 — managerCode ================= */

test("§8.2 registos simultâneos com o MESMO managerCode e chaves diferentes: a base impede o duplicado — 409 duplicate_manager_code, nunca dois ativos", async () => {
    const results = await Promise.allSettled([
        registration.register(registerCommand({ registrationKey: "mc-1", managerCode: "EQP-MOV-77" })),
        registration.register(registerCommand({ registrationKey: "mc-2", managerCode: "eqp-mov-77" })), // normalização UPPER(TRIM)
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    assert.equal(fulfilled.length, 1, "exatamente um registo vence");
    assert.equal(rejected.length, 1);
    assert.equal((rejected[0]!.reason as any).code, "duplicate_manager_code");
    assert.equal((rejected[0]!.reason as any).statusCode, 409);
    assert.equal(state.assets.length, 1, "um único ativo com o código");

    // a operação perdedora fica TERMINAL (retry nunca projetaria) e o recurso
    // órfão do grafo fica para o relatório de reconciliação (decisão humana)
    const loser = state.ops.find((o) => o.status === "failed_terminal");
    assert.ok(loser, "a operação perdedora existe e é terminal");
    assert.equal(loser!.last_error_code, "duplicate_manager_code");
});

/* ================= §8.3/§11.4 — movimentos ================= */

test("§11.4 movimentos simultâneos do MESMO ativo (chaves diferentes): serializados — UMA localização corrente, histórico completo, identidade intacta", async () => {
    const asset = await registration.register(registerCommand({ registrationKey: "mv-base", initialSpaceId: 1 }));

    const results = await Promise.allSettled([
        location.move({ movementKey: "mv-A", assetId: asset.assetId, newSpaceId: 2 }),
        location.move({ movementKey: "mv-B", assetId: asset.assetId, newSpaceId: 1 }),
    ]);

    assert.ok(results.every((r) => r.status === "fulfilled"),
        "ambos os movimentos vencem POR ORDEM (comportamento explícito documentado — sem last-write-wins silencioso)");

    // SQL: exatamente uma corrente; histórico = inicial + 2 movimentos
    const current = state.assignments.filter((a) => a.valid_to === null);
    assert.equal(current.length, 1, "uma única localização corrente em SQL");
    assert.equal(state.assignments.length, 3, "histórico completo: inicial + 2 movimentos");

    // grafo (autoridade): exatamente uma corrente — a corrida que criava duas
    // correntes no grafo foi eliminada pela serialização por ativo
    assert.equal(graph.currentAssignments(asset.assetUri).length, 1, "uma única corrente no grafo");

    // identidade nunca muda com o movimento
    assert.equal(state.assets.length, 1);
    assert.equal(state.assets[0].asset_uuid, asset.assetUuid);
});

test("§8.3 movimentos simultâneos com a MESMA movementKey e payload convergem para a mesma operação (sem duplicar atribuições)", async () => {
    const asset = await registration.register(registerCommand({ registrationKey: "mv-samekey", initialSpaceId: 1 }));

    const cmd = { movementKey: "mv-K", assetId: asset.assetId, newSpaceId: 2 };
    const [a, b] = await Promise.all([location.move(cmd), location.move({ ...cmd })]);

    assert.equal(a.operation.operationUuid, b.operation.operationUuid);
    assert.equal(a.newAssignment.assignmentUuid, b.newAssignment.assignmentUuid);
    assert.equal(state.assignments.filter((x) => x.valid_to === null).length, 1);
    assert.equal(state.assignments.length, 2, "inicial (fechada) + nova (corrente)");
    assert.equal(graph.currentAssignments(asset.assetUri).length, 1);
});

test("§8.3 mesma movementKey com payload diferente → 409 idempotency_conflict (também sob corrida)", async () => {
    const asset = await registration.register(registerCommand({ registrationKey: "mv-div", initialSpaceId: 1 }));

    const results = await Promise.allSettled([
        location.move({ movementKey: "mv-D", assetId: asset.assetId, newSpaceId: 2 }),
        location.move({ movementKey: "mv-D", assetId: asset.assetId, newSpaceId: 1 }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal((rejected[0]!.reason as any).code, "idempotency_conflict");
    assert.equal(state.assignments.filter((x) => x.valid_to === null).length, 1);
});

/* ================= §8.4 — retries simultâneos ================= */

test("§8.4 dois retries simultâneos da MESMA operação: no máximo UMA retomada efetiva — attempt_count correto, sem triples nem linhas duplicadas", async () => {
    // registo que falha na primeira escrita ao grafo → failed_retryable
    graph.failNextUpdates = 1;
    await assert.rejects(registration.register(registerCommand({ registrationKey: "rt-1" })));
    assert.equal(state.ops[0].attempt_count, 1);
    assert.equal(state.ops[0].status, "failed_retryable");

    // dois retries em corrida (como dois POST /sync/:id/retry simultâneos)
    const op = state.ops[0];
    const [a, b] = await Promise.all([
        registration.resumeOperation({ ...op }),
        registration.resumeOperation({ ...op }),
    ]);

    assert.equal(a.operation.status, "completed");
    assert.equal(b.operation.status, "completed");
    assert.equal(state.ops[0].attempt_count, 2,
        "UMA retomada efetiva: 1 (original) + 1 (retry vencedor); o perdedor devolveu o resultado sem incrementar");
    assert.equal(state.assets.length, 1, "projeção única");
    assert.equal(countAssetResources(), 1, "sem triples duplicados");
});

/* ================= §8.5 — apply-safe simultâneo ================= */

test("§8.5 duas execuções simultâneas de reconciliation apply-safe: serializadas e idempotentes — uma correção não desfaz a outra", async () => {
    // cria divergência: ativo existe no grafo mas sem projeção SQL
    await registration.register(registerCommand({ registrationKey: "rc-1", initialSpaceId: null }));
    state.assets = []; // simula projeção perdida (o grafo é a autoridade)
    state.ops = [];    // sem operações pendentes — o único finding é a projeção em falta

    const [a, b] = await Promise.all([
        reconciliation.applySafe(),
        reconciliation.applySafe(),
    ]);

    // a projeção foi recriada exatamente uma vez
    assert.equal(state.assets.length, 1, "uma única projeção recriada");
    const totalApplied = a.applied.length + b.applied.length;
    assert.ok(totalApplied >= 1, "pelo menos uma execução aplicou a correção");
    // a execução que correu depois já não encontra a divergência (revalidação)
    const finalFindings = b.report.findings.filter((f) => f.type === "graph_asset_missing_sql_projection");
    assert.equal(finalFindings.length, 0, "estado convergiu — nada por aplicar");
});

test("§8.5 report NUNCA escreve (mesmo chamado em paralelo)", async () => {
    await registration.register(registerCommand({ registrationKey: "rc-2" }));
    const updatesBefore = graph.updateCalls.length;
    const callsBefore = fakeConnection.calls.length;

    await Promise.all([reconciliation.report(), reconciliation.report()]);

    const writes = fakeConnection.calls.slice(callsBefore)
        .filter((c) => /INSERT|UPDATE|DELETE/i.test(c.sql) && !/GET_LOCK|RELEASE_LOCK/i.test(c.sql));
    assert.equal(writes.length, 0, "nenhuma escrita SQL");
    assert.equal(graph.updateCalls.length, updatesBefore, "nenhuma escrita no grafo");
});
