/**
 * Reconciliação grafo–SQL (Prompt 5B §19.9): deteção de divergências,
 * correção APENAS dos casos seguros, report mode sem escrita, apply-safe
 * idempotente.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { fakeConnection } from "../helpers/fakeDb.ts";
import { FakeOperationalGraph } from "../helpers/fakeOperationalGraph.ts";
import { installNonModelledEnv, freshState, registerCommand, fixedEvaluator, BASE } from "../helpers/nonModelledTestSetup.ts";
import type { FakeSqlState } from "../helpers/fakeNonModelledSql.ts";

installNonModelledEnv();

const graph = new FakeOperationalGraph();
const graphProvider = await import("../../graph/graphClientProvider.ts");
const policies = await import("../../policies/policyProvider.ts");
const registration = (await import("../../services/nonModelledAssetRegistrationService.ts")).default;
const location = (await import("../../services/nonModelledAssetLocationService.ts")).default;
const reconciliation = (await import("../../services/graphSqlReconciliationService.ts")).default;

let state: FakeSqlState;

beforeEach(() => {
    graph.reset();
    fakeConnection.reset();
    state = freshState();
    fakeConnection.handler = state.handler;
    graphProvider.setGraphClient(graph as any);
    policies.resetPolicyProviders();
});

test("estado consistente → relatório sem findings (além de operações completas)", async () => {
    await registration.register(registerCommand());
    const report = await reconciliation.report();
    assert.equal(report.findings.length, 0);
    assert.equal(report.graphAssetCount, 1);
    assert.equal(report.sqlProjectionCount, 1);
});

test("deteta projeção SQL ausente (graph_asset_missing_sql_projection) e apply-safe recria-a", async () => {
    const asset = await registration.register(registerCommand({ initialSpaceId: 1 }));
    // simular perda da projeção (ex.: rollback local)
    state.assets = [];
    state.assignments = [];

    const report = await reconciliation.report();
    assert.ok(report.findings.some((f) => f.type === "graph_asset_missing_sql_projection" && f.safeToApply));

    const applied = await reconciliation.applySafe();
    assert.ok(applied.applied.some((f) => f.type === "graph_asset_missing_sql_projection"));
    const recreated = state.assets.find((a) => a.asset_uuid === asset.assetUuid);
    assert.ok(recreated, "projeção recriada a partir do grafo");
    assert.equal(recreated.semantic_uri, asset.assetUri);
    assert.equal(state.assignments.filter((a) => a.valid_to === null).length, 1, "localização corrente reprojetada");

    // idempotente: 2.ª execução não aplica nada
    const again = await reconciliation.applySafe();
    assert.equal(again.applied.length, 0);
});

test("deteta recurso do grafo ausente (sql_projection_missing_graph_asset) e NÃO corrige automaticamente", async () => {
    state.assets.push({
        id: 900, asset_uuid: crypto.randomUUID(), semantic_uri: `${BASE}/asset/x`,
        source: "graph", lifecycle_status: "active", name: "Fantasma",
    });

    const report = await reconciliation.report();
    const finding = report.findings.find((f) => f.type === "sql_projection_missing_graph_asset");
    assert.ok(finding);
    assert.equal(finding!.safeToApply, false, "linha SQL não é prova de existência semântica — decisão humana");

    const applied = await reconciliation.applySafe();
    assert.ok(applied.skipped.some((f) => f.type === "sql_projection_missing_graph_asset"));
    assert.equal(state.assets.some((a) => a.id === 900), true, "nada foi apagado");
});

test("deteta URI divergente (semantic_uri_mismatch) como caso NÃO seguro", async () => {
    const asset = await registration.register(registerCommand());
    state.assets[0].semantic_uri = `${BASE}/asset/outro-uri`;

    const report = await reconciliation.report();
    const finding = report.findings.find((f) => f.type === "semantic_uri_mismatch");
    assert.ok(finding && !finding.safeToApply);
    void asset;
});

test("deteta localização divergente e atualiza o SQL quando o grafo é INEQUÍVOCO", async () => {
    const asset = await registration.register(registerCommand({ initialSpaceId: 1 }));
    await location.move({ movementKey: crypto.randomUUID(), assetId: asset.assetId, newSpaceId: 2 });

    // regredir a projeção SQL para o espaço antigo (divergência artificial)
    const current = state.assignments.find((a) => a.valid_to === null);
    current.space_id = 1;

    const report = await reconciliation.report();
    const finding = report.findings.find((f) => f.type === "current_location_mismatch");
    assert.ok(finding?.safeToApply, "grafo inequívoco → seguro");

    await reconciliation.applySafe();
    const fixed = state.assignments.find((a) => a.valid_to === null);
    assert.equal(fixed.space_id, 2, "SQL alinhado com a autoridade");
});

test("múltiplas localizações correntes no GRAFO: reportadas, NUNCA auto-corrigidas", async () => {
    const asset = await registration.register(registerCommand({ initialSpaceId: 1 }));
    const rogue = `${BASE}/location-assignment/${crypto.randomUUID()}`;
    await graph.update(`INSERT DATA { GRAPH <${BASE}/graph/operational> {\n<${asset.assetUri}> <${BASE}/vocab/operational-v1#hasLocationAssignment> <${rogue}> .\n<${rogue}> <${BASE}/vocab/operational-v1#assignedSpace> <${BASE}/space/22222222-2222-4222-8222-bbbbbbbbbbbb> .\n} }`);

    const report = await reconciliation.report();
    const finding = report.findings.find((f) => f.type === "multiple_current_graph_locations");
    assert.ok(finding && !finding.safeToApply);

    const before = graph.triples.length;
    const applied = await reconciliation.applySafe();
    assert.ok(applied.skipped.some((f) => f.type === "multiple_current_graph_locations"));
    assert.equal(graph.triples.length, before, "o grafo nunca é alterado pela reconciliação");
});

test("report mode NÃO escreve (nem SQL nem grafo)", async () => {
    await registration.register(registerCommand());
    fakeConnection.calls = [];
    const updatesBefore = graph.updateCalls.length;

    await reconciliation.report();

    assert.equal(graph.updateCalls.length, updatesBefore);
    const writes = fakeConnection.calls.filter((c) => /INSERT|UPDATE|DELETE/i.test(c.sql));
    assert.deepEqual(writes.map((c) => c.sql), []);
});

test("operações incompletas aparecem no relatório e apply-safe retoma-as (allow → reservável)", async () => {
    policies.setReservabilityEvaluator(fixedEvaluator("allow") as any);
    const command = registerCommand();
    state.failOnce = /INSERT INTO assets/;
    await assert.rejects(registration.register(command));

    const report = await reconciliation.report();
    assert.ok(report.findings.some((f) => f.type === "incomplete_sync_operation" && f.safeToApply));

    await reconciliation.applySafe();
    assert.equal(state.ops[0].status, "completed");
    assert.equal(state.assets.length, 1);
    assert.equal(state.assets[0].reservable, 1);
});
