/**
 * Movimento e histórico de localização (Prompt 5B §19.7): identidade
 * preservada, atribuição anterior encerrada (nunca apagada), histórico
 * intacto, validações de espaço e detecção de estados inconsistentes.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { fakeConnection } from "../helpers/fakeDb.ts";
import { FakeOperationalGraph } from "../helpers/fakeOperationalGraph.ts";
import { installNonModelledEnv, freshState, registerCommand, BASE } from "../helpers/nonModelledTestSetup.ts";
import type { FakeSqlState } from "../helpers/fakeNonModelledSql.ts";

installNonModelledEnv();

const graph = new FakeOperationalGraph();
const graphProvider = await import("../../graph/graphClientProvider.ts");
const policies = await import("../../policies/policyProvider.ts");
const registration = (await import("../../services/nonModelledAssetRegistrationService.ts")).default;
const location = (await import("../../services/nonModelledAssetLocationService.ts")).default;

let state: FakeSqlState;

beforeEach(() => {
    graph.reset();
    fakeConnection.reset();
    state = freshState();
    fakeConnection.handler = state.handler;
    graphProvider.setGraphClient(graph as any);
    policies.resetPolicyProviders();
});

async function registeredAsset() {
    return registration.register(registerCommand({ initialSpaceId: 1 }));
}

function moveCommand(assetId: number, overrides: Record<string, unknown> = {}) {
    return { movementKey: crypto.randomUUID(), assetId, newSpaceId: 2, ...overrides };
}

test("mover preserva asset_id, asset_uuid e URI — Sala X → Sala Y, MESMO ativo", async () => {
    const asset = await registeredAsset();
    const moved = await location.move(moveCommand(asset.assetId));

    assert.equal(moved.assetId, asset.assetId);
    assert.equal(moved.assetUuid, asset.assetUuid);
    assert.equal(moved.assetUri, asset.assetUri);
    assert.equal(state.assets.length, 1, "movimento NÃO cria outro asset");
    assert.equal(fakeConnection.callsMatching(/INSERT INTO asset_bindings/i).length, 0, "nem binding IFC");
});

test("a atribuição anterior recebe validTo (grafo e SQL) e o histórico permanece", async () => {
    const asset = await registeredAsset();
    const firstAssignment = asset.currentLocation!.assignmentUuid;

    await location.move(moveCommand(asset.assetId));

    // SQL: duas linhas — a antiga fechada, a nova corrente
    assert.equal(state.assignments.length, 2);
    const old = state.assignments.find((a) => a.assignment_uuid === firstAssignment);
    const current = state.assignments.find((a) => a.valid_to === null);
    assert.ok(old.valid_to !== null, "antiga encerrada, não apagada");
    assert.equal(current.space_id, 2);

    // Grafo: a antiga ainda EXISTE (com validTo); a corrente é a nova
    const oldUri = `${BASE}/location-assignment/${firstAssignment}`;
    assert.ok(graph.triplesOf(oldUri).length > 0, "atribuição antiga preservada no grafo");
    assert.ok(graph.triplesOf(oldUri).some((t) => t.p.endsWith("#validTo")));
    const graphCurrent = graph.currentAssignments(asset.assetUri);
    assert.equal(graphCurrent.length, 1);
    assert.equal(graphCurrent[0]!.space, `${BASE}/space/22222222-2222-4222-8222-bbbbbbbbbbbb`);
});

test("movimento é idempotente: mesma movementKey não duplica; payload diferente → 409", async () => {
    const asset = await registeredAsset();
    const command = moveCommand(asset.assetId);

    const first = await location.move(command);
    const second = await location.move({ ...command });
    assert.equal(second.newAssignment.assignmentUuid, first.newAssignment.assignmentUuid);
    assert.equal(state.assignments.length, 2);

    await assert.rejects(
        location.move({ ...command, newSpaceId: 1 }),
        (error: any) => error.code === "idempotency_conflict"
    );
});

test("espaço destino inválido, absent ou não persistente é rejeitado", async () => {
    const asset = await registeredAsset();
    await assert.rejects(location.move(moveCommand(asset.assetId, { newSpaceId: 99 })), /does not exist/);
    await assert.rejects(location.move(moveCommand(asset.assetId, { newSpaceId: 3 })), /'absent'/);
});

test("fontes não implementadas não podem ser declaradas por clientes (sensor_inference/external_system)", async () => {
    const asset = await registeredAsset();
    for (const source of ["sensor_inference", "external_system"]) {
        await assert.rejects(
            location.move(moveCommand(asset.assetId, { source })),
            (error: any) => error.code === "source_not_implemented"
        );
    }
});

test("ativo MODELADO (source ifc) não pode ser movido por este serviço", async () => {
    state.assets.push({
        id: 500, asset_uuid: crypto.randomUUID(), semantic_uri: null, source: "ifc",
        lifecycle_status: "active", name: "Equip IFC", asset_type: "equipment",
    });
    await assert.rejects(
        location.move(moveCommand(500)),
        (error: any) => error.code === "not_a_non_modelled_asset"
    );
    assert.equal(graph.updateCalls.length, 0);
});

test("múltiplas atribuições correntes no grafo → erro de reconciliação (movimento recusado)", async () => {
    const asset = await registeredAsset();
    // corromper deliberadamente a autoridade: segunda atribuição corrente
    const rogue = `${BASE}/location-assignment/${crypto.randomUUID()}`;
    await graph.update(`INSERT DATA { GRAPH <${BASE}/graph/operational> {\n<${asset.assetUri}> <${BASE}/vocab/operational-v1#hasLocationAssignment> <${rogue}> .\n<${rogue}> <${BASE}/vocab/operational-v1#assignedSpace> <${BASE}/space/22222222-2222-4222-8222-bbbbbbbbbbbb> .\n} }`);

    await assert.rejects(
        location.move(moveCommand(asset.assetId)),
        (error: any) => error.code === "multiple_current_locations"
    );
});

test("ativo sem localização corrente no grafo: movimento recusado com diagnóstico (não inventa localização)", async () => {
    const asset = await registration.register(registerCommand({ initialSpaceId: null }));
    await assert.rejects(
        location.move(moveCommand(asset.assetId)),
        (error: any) => error.code === "no_current_location"
    );
});

test("tempo: para movimento manual, observedAt fica nulo (não é substituído por createdAt)", async () => {
    const asset = await registeredAsset();
    await location.move(moveCommand(asset.assetId));
    const current = state.assignments.find((a) => a.valid_to === null);
    assert.equal(current.observed_at ?? null, null);
    assert.ok(current.valid_from, "validFrom preenchido");
});
