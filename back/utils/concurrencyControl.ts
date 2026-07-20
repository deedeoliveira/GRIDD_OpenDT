/**
 * Controlo de concorrência (Prompt 6; CONCURRENCY_AUDIT.md §6/§7).
 *
 * - logConcurrencyEvent: logs ESTRUTURADOS de concorrência (JSON numa linha),
 *   sem passwords, sem texto completo de queries, sem payloads integrais;
 * - ConcurrencyError: erro controlado com código estável — nunca expõe
 *   números de erro nem detalhes internos do MySQL ao cliente;
 * - withDeadlockRetry: retry LIMITADO e com backoff pequeno APENAS para
 *   deadlocks InnoDB (ER_LOCK_DEADLOCK 1213). Lock wait timeout (1205),
 *   erros de validação, conflitos de negócio, payload divergente,
 *   configuração insegura e erros terminais NUNCA são repetidos.
 *
 * Ordem GLOBAL de locks (deadlock prevention — ver CONCURRENCY_AUDIT §6):
 *   GET_LOCK nm_asset → GET_LOCK sync_op →
 *     (transação SQL: assets → res_reservations / asset_location_assignments /
 *      semantic_sync_operations)
 * Nunca adquirir um lock de nível anterior depois de um posterior.
 */
import crypto from "node:crypto";

export type ConcurrencyEventType =
    | "reservation_transaction_started"
    | "reservation_conflict_detected"
    | "reservation_created"
    | "reservation_transition_conflict"
    | "concurrency_retry"
    | "concurrency_retry_exhausted"
    | "deadlock_detected"
    | "lock_timeout"
    | "model_upload_concurrency"
    | "reconciliation_conflict"
    | "semantic_sync_concurrency"
    | "location_movement_conflict";

export function logConcurrencyEvent(type: ConcurrencyEventType, extra: Record<string, unknown> = {}): void {
    console.log(JSON.stringify({
        type,
        at: new Date().toISOString(),
        ...extra,
    }));
}

/** ID de correlação para seguir uma operação através dos logs. */
export function newCorrelationId(): string {
    return crypto.randomUUID();
}

export class ConcurrencyError extends Error {
    constructor(public readonly code: "lock_timeout" | "deadlock_retry_exhausted" | "transition_conflict", message: string) {
        super(message);
        this.name = "ConcurrencyError";
    }
}

function isDeadlock(error: any): boolean {
    return error?.errno === 1213 || error?.code === "ER_LOCK_DEADLOCK";
}

const MAX_DEADLOCK_RETRIES = 2;   // tentativas EXTRA além da primeira
const BACKOFF_BASE_MS = 25;

/**
 * Executa `fn`; em deadlock InnoDB repete até MAX_DEADLOCK_RETRIES vezes com
 * backoff pequeno. Qualquer outro erro propaga imediatamente (sem retry).
 */
export async function withDeadlockRetry<T>(operation: string, fn: () => Promise<T>, correlationId?: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await fn();
        } catch (error: any) {
            if (!isDeadlock(error)) throw error;

            logConcurrencyEvent("deadlock_detected", { operation, attempt: attempt + 1, correlationId });
            if (attempt >= MAX_DEADLOCK_RETRIES) {
                logConcurrencyEvent("concurrency_retry_exhausted", { operation, attempts: attempt + 1, correlationId });
                throw new ConcurrencyError(
                    "deadlock_retry_exhausted",
                    "the operation kept conflicting with concurrent activity — try again"
                );
            }
            logConcurrencyEvent("concurrency_retry", { operation, nextAttempt: attempt + 2, correlationId });
            await new Promise((r) => setTimeout(r, BACKOFF_BASE_MS * (attempt + 1)));
        }
    }
}

/** Erro de chave duplicada do MySQL (usado para convergência/409 — nunca retry cego). */
export function isDuplicateKeyError(error: any): boolean {
    return error?.errno === 1062 || error?.code === "ER_DUP_ENTRY" || /Duplicate entry/i.test(error?.message ?? "");
}
