import type {
    PolicyContext,
    PolicyEvaluationResult,
    ReservabilityCandidate,
    ReservabilityEvaluator,
} from "./types.ts";

/**
 * Reproduz EXATAMENTE a regra de reservabilidade da baseline, que vivia
 * inline em utils/inventoryDatabase.ts (saveInventorySnapshot):
 *
 *  - todo o espaço (IfcSpace) vira asset reservável;
 *  - todo o elemento contido num espaço vira asset reservável,
 *    EXCETO quando a classe IFC é exatamente 'IfcSensor'
 *    (comparação estrita — em modelos IFC2X3 os sensores chegam como
 *    'IfcDistributionControlElement' e, tal como na baseline, NÃO são excluídos);
 *  - 'deny' significa que o candidato não vira asset (era o caso dos sensores);
 *    não existia na baseline o conceito de "asset não reservável".
 *
 * Qualquer mudança nesta regra é uma mudança de comportamento e pertence a
 * uma etapa futura com um avaliador novo — não editar a regra aqui.
 */
export class LegacyIfcReservabilityEvaluator implements ReservabilityEvaluator {
    static readonly ID = "legacy-ifc-reservability";
    static readonly RULES_VERSION = "baseline-2026-07";

    async evaluate(
        candidate: ReservabilityCandidate,
        _context: PolicyContext
    ): Promise<PolicyEvaluationResult> {
        const base = {
            evaluatorId: LegacyIfcReservabilityEvaluator.ID,
            rulesVersion: LegacyIfcReservabilityEvaluator.RULES_VERSION,
            evaluatedAt: new Date().toISOString(),
        };

        if (candidate.entityType === "space") {
            return {
                ...base,
                decision: "allow",
                reasons: ["Legacy rule: every space becomes a reservable asset"],
            };
        }

        if (candidate.ifcType === "IfcSensor") {
            return {
                ...base,
                decision: "deny",
                reasons: ["Legacy rule: IfcSensor elements are not inventoried as assets"],
            };
        }

        return {
            ...base,
            decision: "allow",
            reasons: ["Legacy rule: every element contained in a space becomes a reservable asset"],
        };
    }
}
