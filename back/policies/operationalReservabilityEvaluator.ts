import type {
    PolicyContext,
    PolicyEvaluationResult,
    ReservabilityCandidate,
    ReservabilityEvaluator,
} from "./types.ts";
import { LegacyIfcReservabilityEvaluator } from "./legacyIfcReservabilityEvaluator.ts";

/**
 * Política operacional de reservabilidade.
 *
 * Mantém a baseline IFC sem alterações e acrescenta um perfil explícito para
 * recursos não modelados. A política recebe apenas factos já verificados pelos
 * serviços; ela não consulta nem altera autoridades externas diretamente.
 */
export class OperationalReservabilityEvaluator implements ReservabilityEvaluator {
    static readonly ID = "operational-asset-reservability";
    static readonly RULES_VERSION = "operational-2026-07";

    private readonly legacy = new LegacyIfcReservabilityEvaluator();

    async evaluate(candidate: ReservabilityCandidate, context: PolicyContext): Promise<PolicyEvaluationResult> {
        if (candidate.candidateKind !== "non_modelled_asset") {
            return this.legacy.evaluate(candidate, context);
        }

        const base = {
            evaluatorId: OperationalReservabilityEvaluator.ID,
            rulesVersion: OperationalReservabilityEvaluator.RULES_VERSION,
            evaluatedAt: new Date().toISOString(),
        };
        const deny = (reason: string): PolicyEvaluationResult => ({ ...base, decision: "deny", reasons: [reason] });
        const undetermined = (reason: string): PolicyEvaluationResult => ({ ...base, decision: "undetermined", reasons: [reason] });

        if (candidate.isOperationalSource !== true) {
            return deny("Non-modelled reservability requires operational-source identity");
        }
        if (candidate.resourceKind !== "equipment" && candidate.resourceKind !== "tool") {
            return deny("Non-modelled resource kind is not compatible with reservation");
        }
        if (candidate.persistentIdentityStatus === "missing") {
            return deny("Non-modelled asset has no persistent identity");
        }
        if (candidate.persistentIdentityStatus !== "valid") {
            return undetermined("Persistent identity evidence is unavailable");
        }
        if (candidate.lifecycleStatus === "inactive" || candidate.lifecycleStatus === "retired") {
            return deny(`Non-modelled asset lifecycle is ${candidate.lifecycleStatus}`);
        }
        if (candidate.lifecycleStatus !== "active") {
            return undetermined("Lifecycle evidence is unavailable");
        }
        if (candidate.operationalEvidenceStatus === "unavailable" || candidate.operationalEvidenceStatus === "unknown") {
            return undetermined("Operational authority evidence is unavailable");
        }
        if (candidate.operationalEvidenceStatus !== "verified") {
            return deny("Operational authority evidence is missing or inconsistent");
        }
        if (candidate.hasCurrentLocation === false) {
            return deny("Non-modelled asset has no valid current operational location");
        }
        if (candidate.hasCurrentLocation !== true) {
            return undetermined("Current operational location evidence is unavailable");
        }

        if (context.evaluationPhase === "operational") {
            if (candidate.semanticOperationStatus === "failed" || candidate.semanticOperationStatus === "incomplete") {
                return deny("Non-modelled semantic synchronization is not completed");
            }
            if (candidate.semanticOperationStatus !== "completed") {
                return undetermined("Semantic synchronization evidence is unavailable");
            }
            if (candidate.sqlProjectionStatus === "inconsistent") {
                return deny("Operational SQL projection is inconsistent with its authoritative evidence");
            }
            if (candidate.sqlProjectionStatus !== "coherent") {
                return undetermined("Operational SQL projection evidence is unavailable");
            }
        }

        return {
            ...base,
            decision: "allow",
            reasons: ["Non-modelled operational profile: persistent operational identity, active lifecycle, verified authority and one current valid location"],
        };
    }
}
