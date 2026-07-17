import type {
    SpaceIdentityCandidate,
    SpaceIdentityContext,
    SpaceIdentityResolver,
    SpaceIdentityResult,
} from "./types.ts";

/**
 * Resolver do perfil atual do projeto: o código de inventário de um espaço é
 * o valor de Pset_SpaceCommon.Reference (convenção do projeto, não uma
 * definição universal do IFC).
 *
 * Centraliza aqui: nome do property set, nome da propriedade, validação e
 * normalização. O Python apenas extrai os psets; a identidade resolve-se no Node.
 *
 * Normalização CONSERVADORA (documentada): apenas remoção de whitespace
 * exterior (trim). Sem alteração de caixa, sem remoção de caracteres internos,
 * sem eliminação de zeros iniciais — códigos estruturalmente diferentes nunca
 * são fundidos pela normalização.
 */
export class PsetReferenceSpaceIdentityResolver implements SpaceIdentityResolver {
    static readonly ID = "pset-space-common-reference";
    static readonly RULES_VERSION = "prompt3-2026-07";
    static readonly PROPERTY_SET = "Pset_SpaceCommon";
    static readonly PROPERTY = "Reference";
    static readonly SOURCE =
        `${PsetReferenceSpaceIdentityResolver.PROPERTY_SET}.${PsetReferenceSpaceIdentityResolver.PROPERTY}`;

    async resolve(
        candidate: SpaceIdentityCandidate,
        _context: SpaceIdentityContext
    ): Promise<SpaceIdentityResult> {
        const base = {
            source: PsetReferenceSpaceIdentityResolver.SOURCE,
            resolverId: PsetReferenceSpaceIdentityResolver.ID,
            rulesVersion: PsetReferenceSpaceIdentityResolver.RULES_VERSION,
            resolvedAt: new Date().toISOString(),
            guid: candidate.guid,
        };

        const pset = candidate.psets?.[PsetReferenceSpaceIdentityResolver.PROPERTY_SET];
        const raw = pset?.[PsetReferenceSpaceIdentityResolver.PROPERTY];

        if (raw === undefined || raw === null) {
            return {
                ...base,
                status: "missing",
                rawValue: null,
                normalizedValue: null,
                reasonCode: "missing",
                reasons: [`${base.source} is not present on this IfcSpace`],
            };
        }

        if (typeof raw !== "string") {
            return {
                ...base,
                status: "invalid",
                rawValue: String(raw),
                normalizedValue: null,
                reasonCode: "unexpected_type",
                reasons: [`${base.source} has unexpected type '${typeof raw}' (expected string)`],
            };
        }

        const normalized = raw.trim();

        if (normalized.length === 0) {
            return {
                ...base,
                status: "invalid",
                rawValue: raw,
                normalizedValue: null,
                reasonCode: "empty_or_whitespace",
                reasons: [`${base.source} is empty or whitespace-only`],
            };
        }

        return {
            ...base,
            status: "valid",
            rawValue: raw,
            normalizedValue: normalized,
            reasons: [],
        };
    }
}
