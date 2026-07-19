/**
 * Consistência distribuída (Prompt 5B §19.8): sem transação conjunta
 * MySQL↔Fuseki — falha do grafo não cria projeção; falha SQL deixa a
 * operação pendente; retry reutiliza recursos; erros sanitizados; reservas
 * nunca são tocadas pelos fluxos de sincronização.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { fakeConnection } from "../helpers/fakeDb.ts";
import { FakeOperationalGraph } from "../helpers/fakeOperationalGraph.ts";
import { installNonModelledEnv, freshState, registerCommand } from "../helpers/nonModelledTestSetup.ts";
import type { FakeSqlState } from "../helpers/fakeNonModelledSql.ts";

installNonModelledEnv();

const graph = new FakeOperationalGraph();
const graphProvider = await import("../../graph/graphClientProvider.ts");
const policies = await import("../../policies/policyProvider.ts");
const registration = (await import("../../services/nonModelledAssetRegistrationService.ts")).default;

let state: FakeSqlState;

beforeEach(() => {
    graph.reset();
    fakeConnection.reset();
    state = freshState();
    fakeConnection.handler = state.handler;
    graphProvider.setGraphClient(graph as any);
    policies.resetPolicyProviders();
});

test("grafo falha ANTES de escrever → nenhum asset SQL, operação failed_retryable, nada reservável", async () => {
    graph.failNextQueries = 1; // o ASK inicial falha (serviço indisponível)

    await assert.rejects(registration.register(registerCommand()), /graph/i);

    assert.equal(state.assets.length, 0, "nenhuma projeção criada");
    assert.equal(state.assignments.length, 0);
    assert.equal(state.ops[0].status, "failed_retryable");
    assert.ok(state.ops[0].last_error_code, "erro registado");
});

test("grafo escrito e SQL falha → pending_sql_projection; retry conclui SEM recriar recursos", async () => {
    const command = registerCommand();
    state.failOnce = /INSERT INTO assets/;

    await assert.rejects(registration.register(command));
    const op = state.ops[0];
    assert.equal(op.status, "pending_sql_projection", "grafo permanece autoridade; SQL pendente");
    const uuidAfterFailure = op.asset_uuid;
    const graphWrites = graph.updateCalls.length;

    const result = await registration.register({ ...command });
    assert.equal(result.operation.status, "completed");
    assert.equal(result.assetUuid, uuidAfterFailure, "retry reutiliza o asset UUID");
    assert.equal(graph.updateCalls.length, graphWrites, "retry NÃO voltou a escrever no grafo");
    assert.equal(state.assets.length, 1);
});

test("verificação falhada → operação retryable e SQL não ativado", async () => {
    // o fake devolve verificação vazia se o UUID não bater; simular removendo
    // o triplo de UUID após a escrita é complexo — em alternativa, injetamos
    // falha na QUERY de verificação (2.ª query: ASK passa, SELECT falha)
    graph.failNextQueries = 0;
    const command = registerCommand();

    // 1.ª query = ASK (existe?), 2.ª = SELECT verificação → falhar a 2.ª
    const originalQuery = graph.query.bind(graph);
    let queryCount = 0;
    (graph as any).query = async (sparql: string) => {
        queryCount += 1;
        if (queryCount === 2) {
            const { GraphError } = await import("../../graph/graphTypes.ts");
            throw new GraphError("graph_invalid_response", "fake: verification garbled");
        }
        return originalQuery(sparql);
    };

    await assert.rejects(registration.register(command));
    (graph as any).query = originalQuery;

    assert.equal(state.ops[0].status, "failed_retryable");
    assert.equal(state.assets.length, 0, "verificação falhada não projeta");
});

test("retry REAL após falha incrementa attempt_count; repetir uma completed não incrementa nem reexecuta", async () => {
    const command = registerCommand();
    state.failOnce = /INSERT INTO assets/;
    await assert.rejects(registration.register(command));
    assert.equal(state.ops[0].attempt_count, 1, "primeira tentativa (falhada)");
    assert.ok(state.ops[0].last_error_message);

    // retry real (mesma chave) → reexecução conta como 2.ª tentativa
    const result = await registration.register({ ...command });
    assert.equal(result.operation.status, "completed");
    assert.equal(state.ops[0].attempt_count, 2, "a reexecução real incrementou o contador");

    // repetir a operação já completed devolve o existente SEM nova tentativa
    const graphWrites = graph.updateCalls.length;
    const again = await registration.register({ ...command });
    assert.equal(again.assetUuid, result.assetUuid);
    assert.equal(state.ops[0].attempt_count, 2, "completed não incrementa");
    assert.equal(graph.updateCalls.length, graphWrites, "completed não reexecuta nada");
    assert.equal(state.assets.length, 1, "sem duplicação");
});

test("mensagens de erro persistidas são sanitizadas (sem credenciais)", async () => {
    process.env.GRAPH_USERNAME = "admin";
    process.env.GRAPH_PASSWORD = "segredo-que-nao-pode-vazar";
    try {
        graph.failNextQueries = 1;
        await assert.rejects(registration.register(registerCommand()));
        assert.ok(!String(state.ops[0].last_error_message).includes("segredo-que-nao-pode-vazar"));
    } finally {
        delete process.env.GRAPH_USERNAME;
        delete process.env.GRAPH_PASSWORD;
    }
});

test("os fluxos de sincronização NUNCA tocam em reservas nem em versões/bindings IFC", async () => {
    state.failOnce = /INSERT INTO assets/;
    await assert.rejects(registration.register(registerCommand()));
    await registration.register(registerCommand({ registrationKey: crypto.randomUUID() }));

    assert.equal(fakeConnection.callsMatching(/res_reservations/i).length, 0);
    assert.equal(fakeConnection.callsMatching(/UPDATE models/i).length, 0);
    assert.equal(fakeConnection.callsMatching(/asset_bindings/i).filter((c) => /INSERT|UPDATE|DELETE/i.test(c.sql)).length, 0);
});
