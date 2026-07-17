import type { ManagedEquipmentCandidateClassifier } from "./equipmentClassifierTypes.ts";
import { ProjectProfileEquipmentClassifier } from "./projectProfileEquipmentClassifier.ts";

/**
 * Ponto ÚNICO de escolha do classificador de equipamentos (registry+factory),
 * preparado para substituição/configuração futura sem ontologia.
 *
 *   EQUIPMENT_CLASSIFIER_PROVIDER=project-profile
 *
 * Não instanciar classificadores concretos fora deste módulo.
 */

const registry: Record<string, () => ManagedEquipmentCandidateClassifier> = {
    "project-profile": () => new ProjectProfileEquipmentClassifier(),
};

const DEFAULT_PROVIDER = "project-profile";

let current: ManagedEquipmentCandidateClassifier | null = null;

export function getEquipmentClassifier(): ManagedEquipmentCandidateClassifier {
    if (!current) {
        const name = process.env.EQUIPMENT_CLASSIFIER_PROVIDER ?? DEFAULT_PROVIDER;
        const factory = registry[name];

        if (!factory) {
            throw new Error(
                `Unknown equipment classifier provider '${name}' for EQUIPMENT_CLASSIFIER_PROVIDER. ` +
                `Valid providers: ${Object.keys(registry).join(", ")}`
            );
        }

        current = factory();
    }
    return current;
}

/** Substituição controlada (testes). */
export function setEquipmentClassifier(classifier: ManagedEquipmentCandidateClassifier): void {
    current = classifier;
}

export function resetEquipmentClassifier(): void {
    current = null;
}
