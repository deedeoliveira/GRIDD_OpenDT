/**
 * Testes da camada de políticas (Prompt 1 — fronteiras sem mudança de comportamento).
 *
 * Provam, ponto a ponto:
 *  1. reservabilidade antes/depois é igual (legacy = regra da baseline);
 *  2. os mesmos elementos continuam a virar assets;
 *  3. a implementação legada pode ser substituída por mock;
 *  4. mock pode devolver 'allow';
 *  5. mock pode devolver 'deny';
 *  6. o contrato suporta 'undetermined';
 *  7. o contrato suporta 'error';
 *  8. a validação corre no backend;
 *  9. o frontend não é autoridade (a rejeição acontece na camada de dados);
 * 10. a aprovação humana continua separada (pedido permitido entra como 'pending');
 * 11. a disponibilidade temporal continua separada (conflitos fora do validador);
 * 12. nenhuma infraestrutura semântica foi introduzida na camada de políticas.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installFakeMySQL, fakeConnection, respond } from "../helpers/fakeDb.ts";

installFakeMySQL();

const { LegacyIfcReservabilityEvaluator } = await import("../../policies/legacyIfcReservabilityEvaluator.ts");
const { LegacyReservationRequestValidator } = await import("../../policies/legacyReservationRequestValidator.ts");
const providers = await import("../../policies/policyProvider.ts");
const { default: reservationDb } = await import("../../utils/reservationDatabase.ts");
const { persistAssetsForVersion } = await import("../../services/assetInventoryService.ts");

import type { PolicyEvaluationResult, PolicyDecision } from "../../policies/types.ts";

beforeEach(() => {
    fakeConnection.reset();
    providers.resetPolicyProviders();
});

function mockResult(decision: PolicyDecision, reasons: string[] = []): PolicyEvaluationResult {
    return {
        decision,
        reasons,
        evaluatorId: "mock-evaluator",
        evaluatedAt: new Date().toISOString(),
    };
}

// (Prompt 4) A criação de ativos passou do snapshot para o assetInventoryService,
// que continua a decidir reservabilidade EXCLUSIVAMENTE pelo provider de política.
const ASSET_INPUT = {
    linkedModelId: 10,
    modelId: 20,
    modelVersionId: 9,
    inventoryData: {
        "space-guid-1": {
            spaceGuid: "space-guid-1",
            spaceName: "Sala 101",
            elements: [
                // (Revisão P4) identidade por IfcElement.Tag (EQP-) — o preflight
                // garante a Tag; a POLÍTICA continua a decidir a reservabilidade
                { guid: "elem-guid-1", type: "IfcFurniture", name: "Mesa", tag: "EQP-MESA-1", psets: {} },
                { guid: "sensor-guid-1", type: "IfcSensor", name: "Sensor T", tag: "EQP-SEN-1", psets: {} },
            ],
        },
    },
    spaceEntityIdsByGuid: { "space-guid-1": 100 },
    elementEntityIdsByGuid: { "elem-guid-1": 101, "sensor-guid-1": 102 },
    spaceInfoByGuid: { "space-guid-1": { spaceId: 7, code: "R-101" } },
};

function assetRoutes(): [RegExp, any][] {
    return [
        [/SELECT \* FROM assets WHERE space_id/i, [[]]],
        [/FROM assets[\s\S]*asset_code = :tag/i, [[]]],
        [/FROM assets[\s\S]*serial_number = :serial/i, [[]]],
        [/INSERT INTO assets/i, (() => { let id = 300; return () => [{ insertId: id++ }]; })()],
        [/INSERT INTO asset_bindings/i, [{ insertId: 400 }]],
        [/UPDATE assets/i, [{}]],
    ];
}

/* -------------------------------------
   1) EVALUATOR LEGADO = REGRA DA BASELINE
------------------------------------- */

test("legacy evaluator: espaço → allow (igual à baseline)", async () => {
    const evaluator = new LegacyIfcReservabilityEvaluator();
    const result = await evaluator.evaluate(
        { guid: "g1", name: "Sala", ifcType: "IfcSpace", entityType: "space" }, {}
    );

    assert.equal(result.decision, "allow");
    assert.equal(result.evaluatorId, "legacy-ifc-reservability");
    assert.equal(result.rulesVersion, "baseline-2026-07");
    assert.ok(result.reasons.length > 0);
    assert.ok(!isNaN(Date.parse(result.evaluatedAt)), "evaluatedAt é uma data ISO válida");
});

test("legacy evaluator: elemento não-sensor → allow; IfcSensor → deny (igual à baseline)", async () => {
    const evaluator = new LegacyIfcReservabilityEvaluator();

    const furniture = await evaluator.evaluate(
        { guid: "g2", name: "Mesa", ifcType: "IfcFurniture", entityType: "element" }, {}
    );
    assert.equal(furniture.decision, "allow");

    const sensor = await evaluator.evaluate(
        { guid: "g3", name: "Sensor", ifcType: "IfcSensor", entityType: "element" }, {}
    );
    assert.equal(sensor.decision, "deny");
});

test("legacy evaluator: IfcDistributionControlElement (sensor IFC2X3) → allow, tal como na baseline", async () => {
    // A baseline só excluía a string exata 'IfcSensor'; preservar isto é deliberado.
    const evaluator = new LegacyIfcReservabilityEvaluator();
    const result = await evaluator.evaluate(
        { guid: "g4", ifcType: "IfcDistributionControlElement", entityType: "element" }, {}
    );
    assert.equal(result.decision, "allow");
});

/* -------------------------------------
   2) MESMOS ASSETS CRIADOS (provider default = legacy)
------------------------------------- */

// (Prompt 4) O mesmo comportamento da baseline, agora no fluxo persistente:
// com o provider default (legacy) o espaço e o não-sensor viram ativos e o
// IfcSensor continua excluído.
test("fluxo de ativos com provider default: mesmos assets da baseline (espaço + não-sensor; sensor excluído)", async () => {
    respond(assetRoutes());

    const outcome = await persistAssetsForVersion(ASSET_INPUT as any);

    const assetInserts = fakeConnection.callsMatching(/INSERT INTO assets/i);
    assert.equal(assetInserts.length, 2, "1 asset de espaço + 1 de equipamento");
    assert.deepEqual(outcome.diagnostics.policy_denied_new, ["sensor-guid-1"], "sensor excluído pela política");

    // reservable decidido pelo provider (allow → true)
    for (const insert of assetInserts) {
        assert.equal(insert.params.reservable, true);
    }
});

/* -------------------------------------
   3–7) SUBSTITUIÇÃO POR MOCK E CONTRATO
------------------------------------- */

test("mock allow-all substitui o legacy: sensor também vira asset (no fluxo persistente)", async () => {
    providers.setReservabilityEvaluator({
        evaluate: async () => mockResult("allow", ["mock: allow everything"]),
    });
    respond(assetRoutes());

    await persistAssetsForVersion(ASSET_INPUT as any);

    const assetInserts = fakeConnection.callsMatching(/INSERT INTO assets/i);
    assert.equal(assetInserts.length, 3, "espaço + elemento + sensor");
});

test("mock deny-all: nenhum asset novo criado", async () => {
    providers.setReservabilityEvaluator({
        evaluate: async () => mockResult("deny", ["mock: deny everything"]),
    });
    respond(assetRoutes());

    await persistAssetsForVersion(ASSET_INPUT as any);

    assert.equal(fakeConnection.callsMatching(/INSERT INTO assets/i).length, 0);
});

test("contrato suporta 'undetermined': candidato novo não é exposto (sem asset)", async () => {
    providers.setReservabilityEvaluator({
        evaluate: async () => mockResult("undetermined", ["mock: cannot decide"]),
    });
    respond(assetRoutes());

    const outcome = await persistAssetsForVersion(ASSET_INPUT as any);

    assert.equal(fakeConnection.callsMatching(/INSERT INTO assets/i).length, 0);
    assert.ok(outcome.diagnostics.policy_denied_new.length >= 1);
});

test("contrato suporta 'error': pedido de reserva é rejeitado com a razão do avaliador", async () => {
    providers.setReservationRequestValidator({
        validate: async () => mockResult("error", ["mock: evaluation failed"]),
    });

    const start = new Date(Date.now() + 3_600_000);
    const end = new Date(Date.now() + 7_200_000);

    await assert.rejects(
        reservationDb.createReservation(1, "actor1", start, end),
        /mock: evaluation failed/
    );
});

/* -------------------------------------
   8–9) VALIDAÇÃO CORRE NO BACKEND; FRONTEND NÃO É AUTORIDADE
------------------------------------- */

test("validação corre no backend: mock deny bloqueia ANTES de qualquer verificação de conflito (SQL)", async () => {
    providers.setReservationRequestValidator({
        validate: async () => mockResult("deny", ["mock: request not allowed"]),
    });

    const start = new Date(Date.now() + 3_600_000);
    const end = new Date(Date.now() + 7_200_000);

    await assert.rejects(
        reservationDb.createReservation(1, "actor1", start, end),
        /mock: request not allowed/
    );

    // Nenhuma query de conflito nem INSERT foi emitida — a única SQL até aqui
    // são os UPDATEs lazy de no_show/overdue. O cliente (frontend/Bruno/curl)
    // não tem como contornar: a decisão vive na camada de dados do backend.
    assert.equal(fakeConnection.callsMatching(/SELECT COUNT/i).length, 0);
    assert.equal(fakeConnection.callsMatching(/INSERT INTO res_reservations/i).length, 0);
});

test("legacy validator: mesmas mensagens e mesma ordem de validação da baseline; não emite SQL", async () => {
    const validator = new LegacyReservationRequestValidator();
    const now = Date.now();

    // fim <= início tem precedência (mesmo com início no passado)
    const bothWrong = await validator.validate(
        { assetId: 1, actorId: "a", startTime: new Date(now - 7_200_000), endTime: new Date(now - 10_800_000) }, {}
    );
    assert.equal(bothWrong.decision, "deny");
    assert.equal(bothWrong.reasons[0], "End time must be after start time");

    const past = await validator.validate(
        { assetId: 1, actorId: "a", startTime: new Date(now - 60_000), endTime: new Date(now + 3_600_000) }, {}
    );
    assert.equal(past.decision, "deny");
    assert.equal(past.reasons[0], "Cannot create reservation in the past");

    const ok = await validator.validate(
        { assetId: 1, actorId: "a", startTime: new Date(now + 3_600_000), endTime: new Date(now + 7_200_000) }, {}
    );
    assert.equal(ok.decision, "allow");

    assert.equal(fakeConnection.calls.length, 0, "o validador não toca na base de dados");
});

/* -------------------------------------
   10) APROVAÇÃO HUMANA CONTINUA SEPARADA
------------------------------------- */

test("pedido permitido entra como 'pending' — a política não aprova reservas", async () => {
    providers.setReservationRequestValidator({
        validate: async () => mockResult("allow", ["mock: allowed"]),
    });
    respond([
        [/SELECT COUNT\(\*\) as count/i, [[{ count: 0 }]]],
        [/INSERT INTO res_reservations/i, [{ insertId: 77 }]],
    ]);

    const start = new Date(Date.now() + 3_600_000);
    const end = new Date(Date.now() + 7_200_000);
    const id = await reservationDb.createReservation(1, "actor1", start, end);
    assert.equal(id, 77);

    const insert = fakeConnection.callsMatching(/INSERT INTO res_reservations/i)[0]!;
    assert.match(insert.sql, /'pending'/);
    assert.doesNotMatch(insert.sql, /'approved'/);

    // Não existe nenhuma operação de aprovação/rejeição implementada
    assert.equal((reservationDb as any).approveReservation, undefined);
    assert.equal((reservationDb as any).rejectReservation, undefined);
});

/* -------------------------------------
   11) DISPONIBILIDADE TEMPORAL CONTINUA SEPARADA
------------------------------------- */

test("mesmo com validador allow, o conflito temporal continua a bloquear (fora da política)", async () => {
    providers.setReservationRequestValidator({
        validate: async () => mockResult("allow", ["mock: allowed"]),
    });
    respond([[/status IN \('approved','in_use','no_show'\)/i, [[{ count: 1 }]]]]);

    const start = new Date(Date.now() + 3_600_000);
    const end = new Date(Date.now() + 7_200_000);

    await assert.rejects(
        reservationDb.createReservation(1, "actor1", start, end),
        /Asset already reserved for this period/
    );
});

/* -------------------------------------
   PROVIDER CONFIGURÁVEL
------------------------------------- */

test("provider default é o legacy; nome desconhecido no ambiente falha explicitamente", async () => {
    providers.resetPolicyProviders();
    const evaluator = providers.getReservabilityEvaluator();
    const result = await evaluator.evaluate(
        { guid: "g", ifcType: "IfcSpace", entityType: "space" }, {}
    );
    assert.equal(result.evaluatorId, "legacy-ifc-reservability");

    const previous = process.env.RESERVABILITY_POLICY_PROVIDER;
    process.env.RESERVABILITY_POLICY_PROVIDER = "does-not-exist";
    providers.resetPolicyProviders();
    assert.throws(() => providers.getReservabilityEvaluator(), /Unknown policy provider/);

    if (previous === undefined) delete process.env.RESERVABILITY_POLICY_PROVIDER;
    else process.env.RESERVABILITY_POLICY_PROVIDER = previous;
    providers.resetPolicyProviders();
});

/* -------------------------------------
   12) NENHUMA INFRAESTRUTURA SEMÂNTICA
------------------------------------- */

test("a camada de políticas não introduz nenhuma infraestrutura semântica", () => {
    const policiesDir = fileURLToPath(new URL("../../policies/", import.meta.url));
    const files = fs.readdirSync(policiesDir).filter((f) => f.endsWith(".ts"));

    assert.ok(files.length >= 4, "ficheiros da camada de políticas presentes");

    for (const file of files) {
        const content = fs.readFileSync(path.join(policiesDir, file), "utf-8");
        assert.doesNotMatch(
            content,
            /rdf|sparql|shacl|ontolog|triplestore/i,
            `${file} não deve referenciar infraestrutura semântica`
        );
    }
});
