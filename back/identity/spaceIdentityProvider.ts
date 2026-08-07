import type { SpaceIdentityResolver } from "./types.ts";
import { IfcSpaceNameInventoryCodeResolver } from "./ifcSpaceNameInventoryCodeResolver.ts";

/**
 * Ponto ÚNICO de escolha do SpaceIdentityResolver (registry + factory).
 *
 * Seleção por variável de ambiente (default: o perfil IFC4x3 atual):
 *   SPACE_IDENTITY_PROVIDER=ifcspace-name-inventory-code
 *
 * ADR-0052: o código de inventário institucional vem de IfcSpace.Name; a
 * identidade persistente permanece linked_model_id + IfcSpace.GlobalId. O antigo
 * provider baseado em Pset_SpaceCommon.Reference foi removido do runtime ativo.
 *
 * Um provider futuro (outra propriedade IFC, classificação, identificador
 * externo, ...) é adicionado registando uma entrada aqui — nenhum outro ficheiro
 * (upload service, spaceIdentityService, tabelas, rotas, políticas, frontend)
 * precisa de mudar.
 *
 * Deliberadamente SEPARADO de policies/policyProvider.ts: identidade não é
 * política de reserva. Não instanciar resolvers concretos fora deste módulo.
 */

const registry: Record<string, () => SpaceIdentityResolver> = {
    "ifcspace-name-inventory-code": () => new IfcSpaceNameInventoryCodeResolver(),
};

const DEFAULT_PROVIDER = "ifcspace-name-inventory-code";

let current: SpaceIdentityResolver | null = null;

export function getSpaceIdentityResolver(): SpaceIdentityResolver {
    if (!current) {
        const name = process.env.SPACE_IDENTITY_PROVIDER ?? DEFAULT_PROVIDER;
        const factory = registry[name];

        if (!factory) {
            throw new Error(
                `Unknown space identity provider '${name}' for SPACE_IDENTITY_PROVIDER. ` +
                `Valid providers: ${Object.keys(registry).join(", ")}`
            );
        }

        current = factory();
    }
    return current;
}

/** Substituição controlada (testes). */
export function setSpaceIdentityResolver(resolver: SpaceIdentityResolver): void {
    current = resolver;
}

/** Volta a resolver a partir do ambiente (testes). */
export function resetSpaceIdentityResolver(): void {
    current = null;
}
