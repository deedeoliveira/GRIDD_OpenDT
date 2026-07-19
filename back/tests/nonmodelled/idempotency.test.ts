/**
 * Idempotência do registo (Prompt 5B §19.3): mesma chave+payload → mesmo
 * resultado; payload diferente → conflito; retry preserva UUID/URI e não
 * duplica triplos nem linhas SQL; payload hash verificado.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fakeConnection } from "../helpers/fakeDb.ts";
import { FakeOperationalGraph } from "../helpers/fakeOperationalGraph.ts";
import { installNonModelledEnv, freshState, registerCommand, BASE } from "../helpers/nonModelledTestSetup.ts";
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

test("mesma chave + mesmo payload devolvem o MESMO ativo (sem duplicação)", async () => {
    const command = registerCommand();
    const first = await registration.register(command);
    const second = await registration.register({ ...command });

    assert.equal(second.assetUuid, first.assetUuid);
    assert.equal(second.assetUri, first.assetUri);
    assert.equal(state.assets.length, 1, "uma única linha SQL");
    assert.equal(state.ops.length, 1, "uma única operação");
    assert.equal(graph.updateCalls.length, 1, "uma única escrita no grafo");
    assert.equal(state.ops[0].attempt_count, 1, "repetir uma operação completed NÃO conta como tentativa");
});

test("mesma chave + payload DIFERENTE → conflito 409 (hash do payload verificado)", async () => {
    const command = registerCommand();
    await registration.register(command);

    await assert.rejects(
        registration.register({ ...command, name: "Outro nome" }),
        (error: any) => error.code === "idempotency_conflict" && error.statusCode === 409
    );
    assert.equal(state.assets.length, 1);
});

test("retry após falha SQL preserva UUID/URI, não duplica triplos nem linhas", async () => {
    const command = registerCommand();
    state.failOnce = /INSERT INTO assets/;

    await assert.rejects(registration.register(command));
    const op = state.ops[0];
    assert.equal(op.status, "pending_sql_projection", "grafo escrito, projeção pendente");
    assert.equal(state.assets.length, 0, "falha SQL não deixou projeção parcial ativa");

    const retried = await registration.register({ ...command });
    assert.equal(retried.assetUuid, op.asset_uuid, "retry reutiliza o MESMO asset UUID");
    assert.equal(retried.assetUri, `${BASE}/asset/${op.asset_uuid}`);
    assert.equal(retried.operation.status, "completed");
    assert.equal(state.assets.length, 1);
    assert.equal(graph.updateCalls.length, 1, "retry não reescreveu o grafo (ASK-guardado)");
    assert.equal(graph.triplesOf(retried.assetUri).filter((t) => t.p.endsWith("#assetUuid")).length, 1, "sem triplos duplicados");
});

test("a chave idempotente NÃO é usada como URI pública do ativo", async () => {
    const command = registerCommand({ registrationKey: "chave-legivel-do-comando" });
    const result = await registration.register(command);
    assert.ok(!result.assetUri.includes("chave-legivel-do-comando"));
});
