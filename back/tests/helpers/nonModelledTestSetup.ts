/**
 * Setup partilhado dos testes de ativos não modelados (Prompt 5B):
 * ambiente de grafo local + estado SQL simulado + comandos de exemplo.
 */
import crypto from "node:crypto";
import { installFakeMySQL } from "./fakeDb.ts";
import { createNonModelledSqlState, type FakeSqlState } from "./fakeNonModelledSql.ts";

export const BASE = "http://oswadt.local/id";
export const OPERATIONAL_GRAPH = `${BASE}/graph/operational`;

export function installNonModelledEnv(): void {
    installFakeMySQL();
    process.env.GRAPH_PROVIDER = "fuseki";
    process.env.GRAPH_QUERY_ENDPOINT = "http://localhost:3030/oswadt-test/query";
    process.env.GRAPH_UPDATE_ENDPOINT = "http://localhost:3030/oswadt-test/update";
    process.env.GRAPH_DATA_ENDPOINT = "http://localhost:3030/oswadt-test/data";
    process.env.GRAPH_BASE_URI = BASE;
    delete process.env.GRAPH_USERNAME;
    delete process.env.GRAPH_PASSWORD;
}

export const SPACES = [
    { id: 1, space_uuid: "11111111-1111-4111-8111-aaaaaaaaaaaa", inventory_code: "R-101", name: "Sala 101", status: "active" },
    { id: 2, space_uuid: "22222222-2222-4222-8222-bbbbbbbbbbbb", inventory_code: "R-102", name: "Sala 102", status: "active" },
    { id: 3, space_uuid: "33333333-3333-4333-8333-cccccccccccc", inventory_code: "R-103", name: "Sala 103", status: "absent" },
];

export function freshState(): FakeSqlState {
    return createNonModelledSqlState(SPACES.map((s) => ({ ...s })));
}

export function registerCommand(overrides: Record<string, unknown> = {}) {
    return {
        registrationKey: crypto.randomUUID(),
        name: "Betoneira portátil",
        assetType: "PortableEquipment",
        resourceKind: "equipment" as const,
        managerCode: null,
        serialNumber: null,
        initialSpaceId: 1,
        ...overrides,
    };
}

/** Avaliador de política fixo, para provar allow/deny/undetermined/error. */
export function fixedEvaluator(decision: "allow" | "deny" | "undetermined" | "error", id = "test-evaluator") {
    return {
        evaluate: async () => ({
            decision,
            reasons: [`fixed ${decision}`],
            evaluatorId: id,
            rulesVersion: "test",
            evaluatedAt: new Date().toISOString(),
        }),
    };
}
