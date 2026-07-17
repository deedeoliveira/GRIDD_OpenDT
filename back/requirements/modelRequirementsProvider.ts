import type { ModelInformationRequirementsValidator } from "./modelRequirementsTypes.ts";
import { ProjectProfileRequirementsValidator } from "./projectProfileRequirementsValidator.ts";

/**
 * Ponto ÚNICO de escolha do validador de requisitos de informação do modelo:
 *
 *   MODEL_REQUIREMENTS_PROVIDER=project-profile-v1
 *
 * O provider atual executa as regras implementadas diretamente pela aplicação
 * (current project information-requirement profile). Um futuro
 * IdsModelRequirementsValidator (IDS registado por gestor, associado a
 * linked_model/model/tipo de modelo/upload) entra por AQUI, sem alterar o
 * modelUploadService, a identidade ou as reservas.
 */

const registry: Record<string, () => ModelInformationRequirementsValidator> = {
    "project-profile-v1": () => new ProjectProfileRequirementsValidator(),
};

const DEFAULT_PROVIDER = "project-profile-v1";

let current: ModelInformationRequirementsValidator | null = null;

export function getModelRequirementsValidator(): ModelInformationRequirementsValidator {
    if (!current) {
        const name = process.env.MODEL_REQUIREMENTS_PROVIDER ?? DEFAULT_PROVIDER;
        const factory = registry[name];

        if (!factory) {
            throw new Error(
                `Unknown model requirements provider '${name}' for MODEL_REQUIREMENTS_PROVIDER. ` +
                `Valid providers: ${Object.keys(registry).join(", ")}`
            );
        }

        current = factory();
    }
    return current;
}

/** Substituição controlada (testes). */
export function setModelRequirementsValidator(validator: ModelInformationRequirementsValidator): void {
    current = validator;
}

export function resetModelRequirementsValidator(): void {
    current = null;
}
