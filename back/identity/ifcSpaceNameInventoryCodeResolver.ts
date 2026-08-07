import type {
    SpaceIdentityCandidate,
    SpaceIdentityContext,
    SpaceIdentityResolver,
    SpaceIdentityResult,
} from "./types.ts";

/**
 * IFC4x3 space inventory-code resolver (ADR-0052 §C).
 *
 * The institutional UMinho inventory code of a space comes EXCLUSIVELY from
 * `IfcSpace.Name`. This resolver reads that attribute, validates it, and produces
 * the normalized inventory code used for scope uniqueness. It is DELIBERATELY not
 * the persistent identity: identity remains `linked_model_id + IfcSpace.GlobalId`
 * (ADR-0052 §B) and is resolved elsewhere.
 *
 * `Pset_SpaceCommon.Reference` is NEVER read here (ADR-0052 §E). A space may carry
 * a Reference property; it is ignored, not interpreted. There is no fallback
 * Name → Reference, LongName → Name, or Reference → Name.
 *
 * Normalization is CONSERVATIVE and identical to the previous policy: outer
 * whitespace trim only — no case folding, no interior change, no leading-zero
 * removal — so structurally distinct codes are never merged.
 */
export class IfcSpaceNameInventoryCodeResolver implements SpaceIdentityResolver {
    static readonly ID = "ifcspace-name-inventory-code";
    static readonly RULES_VERSION = "adr0052-2026-08";
    static readonly SOURCE = "IfcSpace.Name";

    async resolve(
        candidate: SpaceIdentityCandidate,
        _context: SpaceIdentityContext,
    ): Promise<SpaceIdentityResult> {
        const base = {
            source: IfcSpaceNameInventoryCodeResolver.SOURCE,
            resolverId: IfcSpaceNameInventoryCodeResolver.ID,
            rulesVersion: IfcSpaceNameInventoryCodeResolver.RULES_VERSION,
            resolvedAt: new Date().toISOString(),
            guid: candidate.guid,
        };

        const raw = candidate.name;

        // IfcSpace.Name is institutionally required (ADR-0052 §C): absent → blocking.
        if (raw === undefined || raw === null) {
            return {
                ...base,
                status: "missing",
                rawValue: null,
                normalizedValue: null,
                reasonCode: "missing",
                reasons: [`${base.source} is not present on this IfcSpace (a blank institutional inventory code blocks intake)`],
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
