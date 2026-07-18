/**
 * Contratos da camada de políticas de reserva.
 *
 * Separa quatro preocupações que antes estavam misturadas no código:
 *  1. Reservabilidade   — um elemento do modelo pode ser um ativo reservável?
 *                          (ReservabilityEvaluator, avaliado na criação do inventário)
 *  2. Validação de pedido — um pedido de reserva pode entrar no fluxo existente?
 *                          (ReservationRequestValidator, avaliado na submissão)
 *  3. Disponibilidade temporal — continua fora desta camada
 *                          (reservationDatabase.hasApprovedConflict / assetDatabase.getAvailability)
 *  4. Aprovação humana   — não existe operação implementada; o estado 'approved'
 *                          só é atingível fora da aplicação. Esta camada NÃO aprova
 *                          reservas; apenas decide se o pedido pode ser submetido.
 */

export type PolicyDecision = "allow" | "deny" | "undetermined" | "error";

export interface PolicyEvaluationResult {
    decision: PolicyDecision;
    /** Razões legíveis que justificam a decisão (vazio apenas se não houver nada a dizer). */
    reasons: string[];
    /** Identificador estável do avaliador que produziu a decisão. */
    evaluatorId: string;
    /** Versão das regras aplicadas, quando o avaliador a define. */
    rulesVersion?: string;
    /** Momento da avaliação (ISO 8601). */
    evaluatedAt: string;
}

/** Contexto partilhado passado a qualquer avaliação de política. */
export interface PolicyContext {
    modelId?: number | string;
    modelVersionId?: number | string;
    [extra: string]: unknown;
}

/**
 * Origem do candidato (Prompt 5B). Extensão ADITIVA: ausente ⇒ "ifc_entity"
 * (comportamento pré-5B inalterado para todos os providers existentes).
 */
export type ReservabilityCandidateKind = "ifc_entity" | "non_modelled_asset" | "space";

/**
 * Candidato a ativo reservável. Historicamente um elemento/espaço do
 * inventário IFC; desde o Prompt 5B também um ativo NÃO modelado
 * (candidateKind="non_modelled_asset", sem guid/ifcType — esses campos são
 * específicos de IFC e ficam ausentes).
 */
export interface ReservabilityCandidate {
    /** GUID IFC — apenas para candidatos vindos de um modelo (opcional desde o 5B). */
    guid?: string | null;
    name?: string | null;
    /** Classe IFC tal como extraída pelo serviço Python (ex.: IfcSpace, IfcFurniture, IfcSensor). */
    ifcType?: string | null;
    entityType: "space" | "element";
    /** Ausente ⇒ ifc_entity (compatibilidade com providers pré-5B). */
    candidateKind?: ReservabilityCandidateKind;
    /** Campos do candidato não modelado (nunca payload semântico interno, nunca credenciais). */
    assetType?: string | null;
    resourceKind?: string | null;
    source?: string | null;
    managerCode?: string | null;
    serialNumber?: string | null;
    /** Há localização corrente conhecida? (condição operacional, não identidade) */
    hasCurrentLocation?: boolean;
}

/** Pedido de reserva a validar antes de entrar no fluxo existente. */
export interface ReservationValidationRequest {
    assetId: number;
    actorId: string;
    startTime: Date;
    endTime: Date;
}

export interface ReservabilityEvaluator {
    evaluate(
        candidate: ReservabilityCandidate,
        context: PolicyContext
    ): Promise<PolicyEvaluationResult>;
}

export interface ReservationRequestValidator {
    /**
     * Decide se o pedido pode ser SUBMETIDO ao fluxo de reservas existente.
     * Não aprova a reserva: um pedido permitido entra como 'pending',
     * exatamente como na baseline.
     */
    validate(
        request: ReservationValidationRequest,
        context: PolicyContext
    ): Promise<PolicyEvaluationResult>;
}
