/**
 * Integração com reservas (Prompt 5B §19.10): SQL continua a autoridade
 * transacional; ativos não modelados só são reserváveis com projeção
 * concluída + allow + localização válida; movimento não contorna reservas;
 * Fuseki parado não afeta reservas já projetadas.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
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
const reservationDb = (await import("../../utils/reservationDatabase.ts")).default;

let state: FakeSqlState;

const FUTURE_START = new Date(Date.now() + 48 * 3600 * 1000);
const FUTURE_END = new Date(Date.now() + 50 * 3600 * 1000);

beforeEach(() => {
    graph.reset();
    fakeConnection.reset();
    state = freshState();
    fakeConnection.handler = state.handler;
    graphProvider.setGraphClient(graph as any);
    policies.resetPolicyProviders();
});

async function reservableAsset() {
    policies.setReservabilityEvaluator(fixedEvaluator("allow") as any);
    const asset = await registration.register(registerCommand({ initialSpaceId: 1 }));
    policies.resetPolicyProviders();
    return asset;
}

test("allow + localização + sync concluída → reserva criada (mesmo asset_id persistente)", async () => {
    const asset = await reservableAsset();
    const reservationId = await reservationDb.createReservation(asset.assetId, "pg202404", FUTURE_START, FUTURE_END);

    assert.ok(reservationId > 0);
    const reservation = state.reservations[0];
    assert.equal(reservation.asset_id, asset.assetId);
    assert.equal(reservation.status, "pending");
    assert.equal(reservation.space_code_snapshot, "R-101", "snapshot da localização projetada");
    assert.equal(reservation.asset_binding_id_at_booking, null, "sem binding — não aplicável");
});

test("sem localização corrente → reserva bloqueada (condição operacional, ativo preservado)", async () => {
    policies.setReservabilityEvaluator(fixedEvaluator("allow") as any);
    const asset = await registration.register(registerCommand({ initialSpaceId: null }));

    await assert.rejects(
        reservationDb.createReservation(asset.assetId, "pg202404", FUTURE_START, FUTURE_END),
        /no valid current location/
    );
    assert.equal(state.assets.length, 1, "ativo não é apagado");
});

test("espaço da localização corrente absent → reserva bloqueada; reservas existentes não são canceladas", async () => {
    const asset = await reservableAsset();
    await reservationDb.createReservation(asset.assetId, "pg202404", FUTURE_START, FUTURE_END);

    // o espaço 1 passa a absent DEPOIS da reserva
    state.spaces.find((s) => s.id === 1)!.status = "absent";

    await assert.rejects(
        reservationDb.createReservation(asset.assetId, "pg202401", FUTURE_START, FUTURE_END),
        /no valid current location/
    );
    assert.equal(state.reservations.length, 1, "a reserva existente permanece");
    assert.equal(state.reservations[0].status, "pending", "não foi cancelada");
});

test("política deny/undetermined (reservable=0) → reserva bloqueada", async () => {
    const asset = await registration.register(registerCommand({ initialSpaceId: 1 })); // legacy → undetermined
    await assert.rejects(
        reservationDb.createReservation(asset.assetId, "pg202404", FUTURE_START, FUTURE_END),
        /not reservable/
    );
});

test("sync pendente → reserva bloqueada até completar", async () => {
    const asset = await reservableAsset();
    state.ops.push({
        id: state.nextId++, operation_uuid: crypto.randomUUID(), idempotency_key: crypto.randomUUID(),
        operation_type: "move_asset", payload_hash: "x", asset_uuid: asset.assetUuid,
        status: "pending_sql_projection", attempt_count: 1,
    });

    await assert.rejects(
        reservationDb.createReservation(asset.assetId, "pg202404", FUTURE_START, FUTURE_END),
        /pending graph synchronization/
    );
});

test("movimento NÃO contorna reservas: mesmo asset_id continua bloqueado após mudar de espaço", async () => {
    const asset = await reservableAsset();
    await reservationDb.createReservation(asset.assetId, "pg202404", FUTURE_START, FUTURE_END);
    state.reservations[0].status = "approved";

    await location.move({ movementKey: crypto.randomUUID(), assetId: asset.assetId, newSpaceId: 2 });

    await assert.rejects(
        reservationDb.createReservation(asset.assetId, "pg202401", FUTURE_START, FUTURE_END),
        /already reserved/
    );
});

test("movimento não reescreve snapshots de reservas existentes", async () => {
    const asset = await reservableAsset();
    await reservationDb.createReservation(asset.assetId, "pg202404", FUTURE_START, FUTURE_END);
    const snapshotBefore = JSON.stringify(state.reservations[0]);

    await location.move({ movementKey: crypto.randomUUID(), assetId: asset.assetId, newSpaceId: 2 });

    assert.equal(JSON.stringify(state.reservations[0]), snapshotBefore);
});

test("Fuseki parado NÃO quebra reservas de ativos já projetados (nenhuma chamada ao grafo)", async () => {
    const asset = await reservableAsset();

    const failing = {
        providerId: "down",
        healthCheck: async () => { throw new Error("down"); },
        query: async () => { throw new Error("down"); },
        update: async () => { throw new Error("down"); },
        putGraph: async () => { throw new Error("down"); },
        deleteGraph: async () => { throw new Error("down"); },
    };
    graphProvider.setGraphClient(failing as any);

    const reservationId = await reservationDb.createReservation(asset.assetId, "pg202404", FUTURE_START, FUTURE_END);
    assert.ok(reservationId > 0, "reserva criada com o grafo em baixo");
});

test("nova alteração de localização com o grafo em baixo falha de forma CONTROLADA (sem tocar na reserva)", async () => {
    const asset = await reservableAsset();
    await reservationDb.createReservation(asset.assetId, "pg202404", FUTURE_START, FUTURE_END);

    graph.failNextQueries = 1;
    await assert.rejects(
        location.move({ movementKey: crypto.randomUUID(), assetId: asset.assetId, newSpaceId: 2 }),
        (error: any) => error.statusCode === 503 || /graph/i.test(String(error.message))
    );
    assert.equal(state.reservations.length, 1);
    assert.equal(state.reservations[0].status, "pending");
});
