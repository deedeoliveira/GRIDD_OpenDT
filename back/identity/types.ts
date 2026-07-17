/**
 * Identidade persistente dos espaços (Prompt 3).
 *
 * Responsabilidade DIFERENTE das políticas de reserva:
 *  - SpaceIdentityResolver responde: "qual espaço persistente esta entidade
 *    IFC representa?" (identidade);
 *  - ReservabilityEvaluator responde: "este candidato pode participar do
 *    fluxo de reservas?" (política).
 * Esta camada NÃO pertence ao policyProvider e não altera reservabilidade.
 *
 * Convenção/perfil de informação DESTE projeto (não é uma regra universal do
 * IFC): o código de inventário do espaço vem de Pset_SpaceCommon.Reference.
 */

export type SpaceIdentityStatus = "valid" | "missing" | "invalid" | "duplicate";

/** Código-máquina do motivo (para diagnósticos agregados sem parsing de texto). */
export type SpaceIdentityReasonCode = "missing" | "empty_or_whitespace" | "unexpected_type";

export interface SpaceIdentityCandidate {
    guid: string;
    name?: string | null;
    longName?: string | null;
    /** Property sets extraídos pelo Python (extração bruta, sem decisões). */
    psets?: Record<string, Record<string, unknown>> | null;
}

export interface SpaceIdentityContext {
    linkedModelId: number;
    modelId: number;
    modelVersionId: number;
    [extra: string]: unknown;
}

export interface SpaceIdentityResult {
    status: SpaceIdentityStatus;
    /** Valor original tal como estava no IFC (sem normalização). */
    rawValue: string | null;
    /** Valor normalizado usado para unicidade (normalização conservadora). */
    normalizedValue: string | null;
    /** Origem do valor, ex.: "Pset_SpaceCommon.Reference". */
    source: string;
    reasons: string[];
    reasonCode?: SpaceIdentityReasonCode | undefined;
    /** Rastreabilidade mínima. */
    resolverId: string;
    rulesVersion?: string | undefined;
    resolvedAt: string;
    guid: string;
}

export interface SpaceIdentityResolver {
    resolve(
        candidate: SpaceIdentityCandidate,
        context: SpaceIdentityContext
    ): Promise<SpaceIdentityResult>;
}
