import type {
    PolicyContext,
    PolicyEvaluationResult,
    ReservationValidationRequest,
    ReservationRequestValidator,
} from "./types.ts";

/**
 * Reproduz EXATAMENTE as validações técnicas de submissão da baseline,
 * que viviam inline em utils/reservationDatabase.ts (createReservation):
 *
 *  1. fim tem de ser depois do início (verificado primeiro — decisão 2026-07-15);
 *  2. o início não pode estar no passado (nem ser igual a "agora").
 *
 * Fora do âmbito deste validador (preservado onde sempre esteve):
 *  - conflitos temporais com outras reservas (hasApprovedConflict / hasActorConflict);
 *  - disponibilidade (assetDatabase.getAvailability);
 *  - aprovação humana (não existe operação implementada).
 *
 * Não existem hoje regras de elegibilidade do ator (aluno, supervisor, etc.);
 * quando as validações acima passam, o pedido é permitido — entra como 'pending'.
 * As mensagens são as MESMAS strings da baseline: os handlers HTTP devolvem-nas
 * tal e qual, portanto alterá-las é uma mudança de comportamento visível.
 */
export class LegacyReservationRequestValidator implements ReservationRequestValidator {
    static readonly ID = "legacy-reservation-request-validator";
    static readonly RULES_VERSION = "baseline-2026-07";

    async validate(
        request: ReservationValidationRequest,
        _context: PolicyContext
    ): Promise<PolicyEvaluationResult> {
        const base = {
            evaluatorId: LegacyReservationRequestValidator.ID,
            rulesVersion: LegacyReservationRequestValidator.RULES_VERSION,
            evaluatedAt: new Date().toISOString(),
        };

        if (request.endTime <= request.startTime) {
            return {
                ...base,
                decision: "deny",
                reasons: ["End time must be after start time"],
            };
        }

        if (request.startTime <= new Date()) {
            return {
                ...base,
                decision: "deny",
                reasons: ["Cannot create reservation in the past"],
            };
        }

        return {
            ...base,
            decision: "allow",
            reasons: ["Request satisfies the legacy technical validations"],
        };
    }
}
