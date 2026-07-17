import type { AssetIdentityResolver } from "./assetIdentityTypes.ts";
import { IfcTagSerialAssetIdentityResolver } from "./ifcTagSerialAssetIdentityResolver.ts";
import persistentAssetDb from "../utils/persistentAssetDatabase.ts";

/**
 * Ponto ÚNICO de escolha do AssetIdentityResolver (registry + factory).
 *
 * Seleção por variável de ambiente (default: perfil atual do projeto):
 *   ASSET_IDENTITY_PROVIDER=ifc-tag-serial-guid
 *
 * "ifc-asset-code-serial-guid" (nome da primeira implementação do Prompt 4)
 * é mantido como ALIAS de compatibilidade de configuração e aponta para a
 * mesma implementação Tag/serial — a estratégia antiga (Reference em
 * Pset_*Common > SerialNumber > GUID) foi substituída pela revisão (ver
 * ADR-0011).
 *
 * Separado das políticas de reserva, do provider de identidade dos ESPAÇOS,
 * do classificador de equipamentos e do provider de requisitos.
 * Não instanciar resolvers concretos fora deste módulo.
 */

const registry: Record<string, () => AssetIdentityResolver> = {
    "ifc-tag-serial-guid": () => new IfcTagSerialAssetIdentityResolver(persistentAssetDb),
    // alias de compatibilidade (nome anterior; mesma implementação atual)
    "ifc-asset-code-serial-guid": () => new IfcTagSerialAssetIdentityResolver(persistentAssetDb),
};

const DEFAULT_PROVIDER = "ifc-tag-serial-guid";

let current: AssetIdentityResolver | null = null;

export function getAssetIdentityResolver(): AssetIdentityResolver {
    if (!current) {
        const name = process.env.ASSET_IDENTITY_PROVIDER ?? DEFAULT_PROVIDER;
        const factory = registry[name];

        if (!factory) {
            throw new Error(
                `Unknown asset identity provider '${name}' for ASSET_IDENTITY_PROVIDER. ` +
                `Valid providers: ${Object.keys(registry).join(", ")}`
            );
        }

        current = factory();
    }
    return current;
}

/** Substituição controlada (testes). */
export function setAssetIdentityResolver(resolver: AssetIdentityResolver): void {
    current = resolver;
}

export function resetAssetIdentityResolver(): void {
    current = null;
}
