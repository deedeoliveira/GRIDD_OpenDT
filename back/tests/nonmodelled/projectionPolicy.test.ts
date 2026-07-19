/**
 * Projeção SQL (Prompt 5B §19.5) e política de reservabilidade (§19.6):
 * mesma identidade projetada, sem entity/binding, source='graph', provider
 * SEMPRE consultado (nunca reservable=true fixo), allow/deny/undetermined/
 * error, e provider IFC legado intacto.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fakeConnection } from "../helpers/fakeDb.ts";
import { FakeOperationalGraph } from "../helpers/fakeOperationalGraph.ts";
import { installNonModelledEnv, freshState, registerCommand, fixedEvaluator } from "../helpers/nonModelledTestSetup.ts";
import type { FakeSqlState } from "../helpers/fakeNonModelledSql.ts";

installNonModelledEnv();

const graph = new FakeOperationalGraph();
const graphProvider = await import("../../graph/graphClientProvider.ts");
const policies = await import("../../policies/policyProvider.ts");
const registration = (await import("../../services/nonModelledAssetRegistrationService.ts")).default;
const { LegacyIfcReservabilityEvaluator } = await import("../../policies/legacyIfcReservabilityEvaluator.ts");

let state: FakeSqlState;

beforeEach(() => {
    graph.reset();
    fakeConnection.reset();
    state = freshState();
    fakeConnection.handler = state.handler;
    graphProvider.setGraphClient(graph as any);
    policies.resetPolicyProviders();
    delete process.env.RESERVABILITY_POLICY_PROVIDER;
});

test("projeção usa o MESMO asset_uuid e a MESMA URI do grafo; source='graph'", async () => {
    const result = await registration.register(registerCommand());
    const projected = state.assets[0];
    assert.equal(projected.asset_uuid, result.assetUuid);
    assert.equal(projected.semantic_uri, result.assetUri);
    assert.equal(projected.source, "graph");
    assert.equal(projected.asset_subtype, "PortableEquipment");
});

test("NÃO cria entity nem asset_binding (não aplicáveis a ativos não modelados)", async () => {
    await registration.register(registerCommand());
    assert.equal(fakeConnection.callsMatching(/INSERT INTO entities/i).length, 0);
    assert.equal(fakeConnection.callsMatching(/INSERT INTO asset_bindings/i).length, 0);
});

test("localização inicial é projetada em asset_location_assignments (mesmo assignment UUID)", async () => {
    const result = await registration.register(registerCommand({ initialSpaceId: 2 }));
    assert.equal(state.assignments.length, 1);
    assert.equal(state.assignments[0].asset_id, result.assetId);
    assert.equal(state.assignments[0].space_id, 2);
    assert.equal(state.assignments[0].assignment_uuid, result.currentLocation?.assignmentUuid);
});

test("o provider configurado é SEMPRE chamado — nenhum reservable=true fixo no código", async () => {
    let called = 0;
    policies.setReservabilityEvaluator({
        evaluate: async () => { called += 1; return fixedEvaluator("deny").evaluate(); },
    } as any);
    await registration.register(registerCommand());
    assert.equal(called, 1);

    // guarda de código: os serviços 5B nunca fixam reservable=true
    for (const file of ["nonModelledAssetRegistrationService.ts", "graphSqlReconciliationService.ts", "nonModelledAssetLocationService.ts"]) {
        const source = fs.readFileSync(path.join(import.meta.dirname, "../../services", file), "utf-8");
        assert.doesNotMatch(source, /reservable:\s*true/, file);
    }
});

test("allow → reservável; deny/undetermined → ativo preservado NÃO reservável; error → nunca reservável", async () => {
    for (const [decision, expected] of [["allow", 1], ["deny", 0], ["undetermined", 0], ["error", 0]] as const) {
        graph.reset(); fakeConnection.reset();
        state = freshState(); fakeConnection.handler = state.handler;
        policies.setReservabilityEvaluator(fixedEvaluator(decision) as any);

        const result = await registration.register(registerCommand());
        assert.equal(state.assets.length, 1, `${decision}: ativo preservado`);
        assert.equal(state.assets[0].reservable, expected, `${decision} → reservable=${expected}`);
        assert.equal(result.policyDecision, decision);
    }
});

test("existir no grafo NÃO implica allow: com o provider legado, o ativo nasce não reservável (undetermined defensivo)", async () => {
    const result = await registration.register(registerCommand());
    assert.equal(result.policyDecision, "undetermined");
    assert.equal(state.assets[0].reservable, 0);
    assert.ok(graph.triplesOf(result.assetUri).length > 0, "o ativo EXISTE no grafo na mesma");
});

test("o candidato não modelado NÃO quebra o provider IFC legado (regra da baseline intacta)", async () => {
    const legacy = new LegacyIfcReservabilityEvaluator();

    const space = await legacy.evaluate({ guid: "g", entityType: "space" } as any, {});
    assert.equal(space.decision, "allow");

    const sensor = await legacy.evaluate({ guid: "g", ifcType: "IfcSensor", entityType: "element" } as any, {});
    assert.equal(sensor.decision, "deny");

    const element = await legacy.evaluate({ guid: "g", ifcType: "IfcFurniture", entityType: "element" } as any, {});
    assert.equal(element.decision, "allow");

    const nonModelled = await legacy.evaluate({ candidateKind: "non_modelled_asset", entityType: "element" } as any, {});
    assert.equal(nonModelled.decision, "undetermined");
});

test("o candidato enviado ao provider não contém SPARQL, password nem SQL IDs sem contexto", async () => {
    let received: any = null;
    policies.setReservabilityEvaluator({
        evaluate: async (candidate: any) => { received = candidate; return fixedEvaluator("allow").evaluate(); },
    } as any);
    await registration.register(registerCommand());

    const serialized = JSON.stringify(received);
    assert.doesNotMatch(serialized, /SELECT|INSERT DATA|GRAPH </);
    assert.doesNotMatch(serialized, /password/i);
});
