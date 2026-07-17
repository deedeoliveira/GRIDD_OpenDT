import type { SpaceIdentityResolver } from "./types.ts";
import { PsetReferenceSpaceIdentityResolver } from "./psetReferenceSpaceIdentityResolver.ts";

/**
 * Ponto ÚNICO de escolha do SpaceIdentityResolver (registry + factory).
 *
 * Seleção por variável de ambiente (default: o perfil atual do projeto):
 *   SPACE_IDENTITY_PROVIDER=pset-space-common-reference
 *
 * Um provider futuro (outra propriedade IFC, classificação, identificador
 * externo, consulta a uma futura ontologia, ...) é adicionado registando uma
 * entrada aqui — nenhum outro ficheiro (upload service, spaceIdentityService,
 * tabelas, rotas, políticas, frontend) precisa de mudar.
 *
 * Deliberadamente SEPARADO de policies/policyProvider.ts: identidade não é
 * política de reserva. Não instanciar resolvers concretos fora deste módulo.
 */

const registry: Record<string, () => SpaceIdentityResolver> = {
    "pset-space-common-reference": () => new PsetReferenceSpaceIdentityResolver(),
};

const DEFAULT_PROVIDER = "pset-space-common-reference";

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
