/** Recovery a partir do comando canónico append-only, sem usar SQL como fonte RDF. */
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fakeConnection } from "../helpers/fakeDb.ts";
import { FakeOperationalGraph } from "../helpers/fakeOperationalGraph.ts";
import { freshState, installNonModelledEnv, registerCommand } from "../helpers/nonModelledTestSetup.ts";
import type { FakeSqlState } from "../helpers/fakeNonModelledSql.ts";

installNonModelledEnv();

const graph = new FakeOperationalGraph();
const graphProvider = await import("../../graph/graphClientProvider.ts");
const registration = (await import("../../services/nonModelledAssetRegistrationService.ts")).default;

let state: FakeSqlState;

beforeEach(() => {
    graph.reset();
    fakeConnection.reset();
    state = freshState();
    fakeConnection.handler = state.handler;
    graphProvider.setGraphClient(graph as any);
});

test("recovery reemite no grafo somente o comando registado, preserva identidade e acrescenta evento", async () => {
    const initial = await registration.register(registerCommand({ managerCode: "RECOVERY-001" }));
    const original = state.ops[0];
    const originalSnapshot = { ...original };

    graph.reset(); // simula perda posterior do named graph, não uma projeção SQL autoritativa
    const recovered = await registration.recoverCompletedRegistration(original);

    assert.equal(recovered.graphWasRestored, true);
    assert.equal(recovered.assetUuid, initial.assetUuid);
    assert.equal(recovered.assetUri, initial.assetUri);
    assert.ok(graph.triplesOf(initial.assetUri).length > 0, "a confirmação vem do grafo remoto");
    assert.equal(graph.literalOf(initial.assetUri, "registrationKey"), original.idempotency_key);
    assert.equal(graph.literalOf(initial.assetUri, "assetCode"), "RECOVERY-001");
    assert.equal(graph.currentAssignments(initial.assetUri).length, 1);
    assert.deepEqual(state.ops[0], originalSnapshot, "o incidente original permanece append-only");

    const recoveryEvent = state.ops[1];
    assert.equal(recoveryEvent.status, "completed");
    assert.match(recoveryEvent.idempotency_key, /^recover-registration:/);
    assert.equal(JSON.parse(recoveryEvent.payload_json).originalOperationUuid, original.operation_uuid);
});

test("recovery recusa payload canónico cujo hash não corresponde", async () => {
    await registration.register(registerCommand());
    const original = state.ops[0];
    original.payload_hash = "0".repeat(64);

    await assert.rejects(
        () => registration.recoverCompletedRegistration(original),
        /persisted hash/
    );
    assert.equal(state.ops.length, 1, "não acrescenta evento quando a prova canónica falha");
});
