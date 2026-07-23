import type {
    PolicyEvaluationResult,
    ReservabilityEvaluator,
    ReservationRequestValidator,
} from "./types.ts";
import { LegacyIfcReservabilityEvaluator } from "./legacyIfcReservabilityEvaluator.ts";
import { OperationalReservabilityEvaluator } from "./operationalReservabilityEvaluator.ts";
import { LegacyReservationRequestValidator } from "./legacyReservationRequestValidator.ts";

/**
 * Ponto ÚNICO de escolha dos providers de política.
 *
 * A escolha é feita por variáveis de ambiente (default: legacy):
 *   RESERVABILITY_POLICY_PROVIDER=legacy
 *   RESERVATION_VALIDATION_PROVIDER=legacy
 *
 * Para acrescentar um provider futuro, regista-se aqui uma nova entrada —
 * nenhum outro ficheiro deve fazer condicionais sobre o nome do provider.
 * Os setters existem para substituição controlada (testes ou wiring futuro).
 */

const reservabilityRegistry: Record<string, () => ReservabilityEvaluator> = {
    legacy: () => new LegacyIfcReservabilityEvaluator(),
    operational: () => new OperationalReservabilityEvaluator(),
};

const validationRegistry: Record<string, () => ReservationRequestValidator> = {
    legacy: () => new LegacyReservationRequestValidator(),
};

let currentEvaluator: ReservabilityEvaluator | null = null;
let currentValidator: ReservationRequestValidator | null = null;

function resolve<T>(
    registry: Record<string, () => T>,
    envVar: string
): T {
    const name = process.env[envVar] ?? (envVar === "RESERVABILITY_POLICY_PROVIDER" ? "operational" : "legacy");
    const factory = registry[name];

    if (!factory) {
        throw new Error(
            `Unknown policy provider '${name}' for ${envVar}. ` +
            `Valid providers: ${Object.keys(registry).join(", ")}`
        );
    }

    return factory();
}

export function getReservabilityEvaluator(): ReservabilityEvaluator {
    if (!currentEvaluator) {
        currentEvaluator = resolve(reservabilityRegistry, "RESERVABILITY_POLICY_PROVIDER");
    }
    return currentEvaluator;
}

export function getReservationRequestValidator(): ReservationRequestValidator {
    if (!currentValidator) {
        currentValidator = resolve(validationRegistry, "RESERVATION_VALIDATION_PROVIDER");
    }
    return currentValidator;
}

/** Substitui o avaliador de reservabilidade (testes / wiring futuro). */
export function setReservabilityEvaluator(evaluator: ReservabilityEvaluator): void {
    currentEvaluator = evaluator;
}

/** Substitui o validador de pedidos (testes / wiring futuro). */
export function setReservationRequestValidator(validator: ReservationRequestValidator): void {
    currentValidator = validator;
}

/** Volta a resolver os providers a partir do ambiente (usado em testes). */
export function resetPolicyProviders(): void {
    currentEvaluator = null;
    currentValidator = null;
}

/**
 * Log estruturado (uma linha JSON) de uma decisão de política.
 * Usado na validação de pedidos; a reservabilidade não é logada por omissão
 * para não gerar uma linha por elemento em cada snapshot de inventário.
 */
export function logPolicyDecision(
    stage: string,
    result: PolicyEvaluationResult,
    extra: Record<string, unknown> = {}
): void {
    console.log(JSON.stringify({
        type: "policy_evaluation",
        stage,
        evaluatorId: result.evaluatorId,
        rulesVersion: result.rulesVersion ?? null,
        decision: result.decision,
        reasons: result.reasons,
        evaluatedAt: result.evaluatedAt,
        ...extra,
    }));
}
