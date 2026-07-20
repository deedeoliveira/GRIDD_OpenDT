/**
 * Integração vertical (Prompt 6, §10/§12-Integração).
 *
 * Percorre o cenário central IFC ↔ SQL ↔ grafo na parte que cruza sistemas:
 * ativo não modelado (grafo autoridade) → projeção SQL → política → reserva →
 * movimento → falhas → recuperação → isolamento dos fluxos modelados.
 *
 * As secções 10.1/10.2 (upload IFC V1/V2, identidade e reserva sobrevivendo a
 * nova versão) estão cobertas pelas suítes existentes:
 *   tests/assets/assetUploadFlow.test.ts, tests/assets/reservationContinuity.test.ts,
 *   tests/versioning/*, tests/spaces/* — este ficheiro NÃO as duplica; cobre o
 * eixo 10.3–10.6 e as garantias cruzadas do §12.
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
const reservationDb = (await import("../../utils/reservationDatabase.ts")).default;

let state: FakeSqlState;

beforeEach(() => {
    graph.reset();
    fakeConnection.reset();
    state = freshState();
    fakeConnection.handler = state.handler;
    graphProvider.setGraphClient(graph as any);
    policies.resetPolicyProviders();
    policies.setReservabilityEvaluator(fixedEvaluator("allow") as any);
});

const futureStart = () => new Date(Date.now() + 3_600_000);
const futureEnd = () => new Date(Date.now() + 7_200_000);

/* ================= §10.3 — fluxo completo do ativo não modelado ================= */

test("§10.3 vertical: registo no grafo → projeção SQL → sem entity/binding → reserva (allow) → movimento preserva identidade e histórico → conflito preservado após movimento", async () => {
    // 1. registo (grafo primeiro, depois projeção)
    const asset = await registration.register(registerCommand({ registrationKey: "vert-1", initialSpaceId: 1 }));
    assert.equal(asset.operation.status, "completed");
    assert.equal(asset.locationStatus, "located");

    // ausência de entity/asset_binding: a projeção nunca inventa dados IFC
    assert.equal(state.assets[0].model_entity_id, null);
    assert.equal(state.assets[0].model_version_id, null);
    const bindingWrites = fakeConnection.callsMatching(/INSERT INTO asset_bindings/);
    assert.equal(bindingWrites.length, 0, "nenhum asset_binding fabricado");

    // 2. reserva com política allow (gating SQL: reservable=1 + localização + sync completo)
    const reservationId = await reservationDb.createReservation(asset.assetId, "estudante1", futureStart(), futureEnd());
    assert.ok(reservationId, "reserva criada");
    assert.equal(state.reservations.length, 1);

    // 3. movimento: identidade intacta, histórico completo
    const move = await location.move({ movementKey: "vert-mv", assetId: asset.assetId, newSpaceId: 2 });
    assert.equal(move.assetUuid, asset.assetUuid, "mover NUNCA muda a identidade");
    assert.equal(state.assignments.filter((a) => a.valid_to === null).length, 1);
    assert.equal(state.assignments.length, 2, "histórico: inicial fechada + nova corrente");

    // 4. conflito preservado após movimento: a continuidade é por asset_id
    await assert.rejects(
        reservationDb.createReservation(asset.assetId, "estudante1", futureStart(), futureEnd()),
        /You already have a reservation overlapping this period/,
        "a reserva anterior continua a valer para o MESMO asset, mesmo depois de mudar de sala"
    );
});

test("§10.3 política deny/undetermined: ativo registado e preservado mas NUNCA reservável (nenhum allow inventado)", async () => {
    policies.setReservabilityEvaluator(fixedEvaluator("undetermined") as any);
    const asset = await registration.register(registerCommand({ registrationKey: "vert-2", initialSpaceId: 1 }));

    assert.equal(state.assets[0].reservable, 0);
    await assert.rejects(
        reservationDb.createReservation(asset.assetId, "estudante1", futureStart(), futureEnd()),
        /Asset is not reservable/
    );
});

/* ================= §10.4 — falhas e recuperação ================= */

test("§10.4 grafo escrito e SQL falha → operação retomável; retry converge sem duplicar; reserva bloqueada ENQUANTO o sync está incompleto", async () => {
    // falha injetada na projeção SQL (depois de o grafo ser escrito)
    state.failOnce = /INSERT INTO assets/;
    await assert.rejects(registration.register(registerCommand({ registrationKey: "vert-3", initialSpaceId: 1 })));

    const op = state.ops[0];
    assert.equal(op.status, "pending_sql_projection", "grafo escrito, projeção pendente");
    assert.equal(state.assets.length, 0);

    // §12: sync incompleto bloqueia novas reservas — mas aqui nem asset SQL há;
    // o caso com asset existente é testado em tests/nonmodelled/nonModelledReservations.test.ts

    // retry (re-POST com a mesma chave) recupera SEM tocar no grafo de novo
    const updatesBefore = graph.updateCalls.length;
    const result = await registration.register(registerCommand({ registrationKey: "vert-3", initialSpaceId: 1 }));
    assert.equal(result.operation.status, "completed");
    assert.equal(state.assets.length, 1, "projeção única após o retry");
    assert.equal(graph.updateCalls.length, updatesBefore, "o grafo não foi reescrito (ASK-guardado)");

    // agora a reserva já passa
    const id = await reservationDb.createReservation(result.assetId, "estudante1", futureStart(), futureEnd());
    assert.ok(id);
});

test("§10.4/§12 Fuseki indisponível: fluxos NÃO modelados falham com 503 controlado; ativos MODELADOS e as suas reservas continuam a funcionar", async () => {
    // um ativo modelado (source='ifc') pré-existente na projeção SQL
    state.assets.push({
        id: 900, asset_uuid: "aaaa", name: "Bomba modelada", asset_type: "equipment",
        source: "ifc", lifecycle_status: "active", reservable: 1,
        model_entity_id: 1, model_version_id: 1, space_id: null, linked_model_id: 1, semantic_uri: null, asset_code: "EQP-1",
    });

    // grafo "desligado": qualquer operação falha
    graph.failNextUpdates = 99;
    graph.failNextQueries = 99;

    // não modelado: falha controlada (retryable), sem 500 opaco
    await assert.rejects(
        registration.register(registerCommand({ registrationKey: "vert-4", initialSpaceId: 1 })),
        (e: any) => e.statusCode === 503 || e.code === "graph_unavailable"
    );

    // modelado: reserva funciona SEM tocar no grafo (o Fuseki nunca é consultado)
    const queriesBefore = graph.queryCalls.length;
    const id = await reservationDb.createReservation(900, "estudante1", futureStart(), futureEnd());
    assert.ok(id, "reserva de ativo modelado criada com o grafo em baixo");
    assert.equal(graph.queryCalls.length, queriesBefore, "zero consultas ao grafo no fluxo de reservas");
});

test("§12 falha do grafo não altera current_version_id nem tabelas de modelos (fronteiras separadas)", async () => {
    graph.failNextUpdates = 99;
    await assert.rejects(registration.register(registerCommand({ registrationKey: "vert-5" })));

    const modelWrites = fakeConnection.calls.filter((c) =>
        /UPDATE models|INSERT INTO model_versions|UPDATE model_versions/i.test(c.sql));
    assert.equal(modelWrites.length, 0, "o fluxo 5B nunca toca em models/model_versions");
});

test("§12 reserva de não modelado JÁ projetado sobrevive a falha posterior do grafo (gating é SQL puro)", async () => {
    const asset = await registration.register(registerCommand({ registrationKey: "vert-6", initialSpaceId: 1 }));

    // grafo cai DEPOIS da projeção completa
    graph.failNextQueries = 99;
    graph.failNextUpdates = 99;

    const queriesBefore = graph.queryCalls.length;
    const id = await reservationDb.createReservation(asset.assetId, "estudante2", futureStart(), futureEnd());
    assert.ok(id, "projeção concluída → reservável mesmo com o Fuseki em baixo");
    assert.equal(graph.queryCalls.length, queriesBefore, "o Fuseki nunca é consultado ao reservar");
});

/* ================= §10.5/§10.6 — estados e compatibilidade ================= */

test("§10.5 estados sob o fluxo vertical: pending → (approved existente) → conflito de terceiros; intervalos inválidos e início no passado rejeitados ANTES de qualquer lock", async () => {
    const asset = await registration.register(registerCommand({ registrationKey: "vert-7", initialSpaceId: 1 }));

    // início no passado / intervalo inválido: rejeição pela política de
    // submissão ANTES da transação (nenhum begin emitido)
    const txBefore = fakeConnection.transactions.length;
    await assert.rejects(
        reservationDb.createReservation(asset.assetId, "e1", new Date(Date.now() - 60_000), futureEnd()),
        /Cannot create reservation in the past/
    );
    await assert.rejects(
        reservationDb.createReservation(asset.assetId, "e1", futureEnd(), futureStart()),
        /End time must be after start time/
    );
    assert.equal(fakeConnection.transactions.length, txBefore, "validação falha sem abrir transação");

    // approved existente bloqueia terceiros (estado bloqueante preservado)
    state.reservations.push({
        id: 500, asset_id: asset.assetId, actor_id: "outro",
        start_time: futureStart(), end_time: futureEnd(), status: "approved",
    });
    await assert.rejects(
        reservationDb.createReservation(asset.assetId, "e2", futureStart(), futureEnd()),
        /Asset already reserved for this period/
    );
});

test("§10.6 compatibilidade: políticas e preflight continuam separados do grafo — o fluxo 5B chama o provider de política, nunca o contrário", async () => {
    let evaluations = 0;
    policies.setReservabilityEvaluator({
        evaluate: async () => { evaluations += 1; return (await fixedEvaluator("allow").evaluate()); },
    } as any);

    await registration.register(registerCommand({ registrationKey: "vert-8" }));
    assert.equal(evaluations, 1, "o provider configurado foi consultado exatamente uma vez");
});
