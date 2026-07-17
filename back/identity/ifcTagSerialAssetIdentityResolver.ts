import type {
    AssetIdentityCandidate,
    AssetIdentityContext,
    AssetIdentityLookup,
    AssetIdentityResolver,
    AssetIdentityResult,
} from "./assetIdentityTypes.ts";
import { isValidEquipmentTag, normalizeEquipmentTag } from "../classification/equipmentTag.ts";

/**
 * Resolver de identidade dos equipamentos MODELADOS — perfil atual (IFC4).
 *
 * Estratégia (revisão do Prompt 4 — substitui a ordem Reference>Serial>GUID):
 *  1. IfcElement.Tag com prefixo EQP- (código institucional do gestor) —
 *     única fonte de asset_code;
 *  2. SerialNumber (Pset_ManufacturerOccurrence) como evidência SECUNDÁRIA
 *     da instância física — pode confirmar, reduzir ou pôr em causa a
 *     correspondência, nunca substitui uma Tag ausente;
 *  3. IFC GUID: apenas rastreabilidade (binding) e compatibilidade histórica
 *     no backfill (legacy_ifc_guid) — NUNCA consultado em novos uploads
 *     (equipamento sem Tag válida falha no model_requirements_preflight).
 *
 * Regras de correspondência (sem merge automático em conflito):
 *  - mesma Tag + mesmo serial            → matched (tag_and_serial, forte);
 *  - mesma Tag + serial ausente          → matched (equipment_tag; evidência
 *    reduzida documentada nas razões);
 *  - mesma Tag + seriais diferentes      → caso de reconciliação
 *    (substituição física ou erro de dados — serial_conflict);
 *  - mesmo serial + Tags diferentes      → caso de reconciliação
 *    (renumeração ou erro de dados — serial_renumbering);
 *  - Tag nova                            → identidade nova.
 *
 * ObjectType e informação de fabricante (Manufacturer/marca/modelo comercial)
 * NÃO participam da identidade, da confiança nem da reconciliação automática.
 */
export class IfcTagSerialAssetIdentityResolver implements AssetIdentityResolver {
    static readonly ID = "ifc-tag-serial-guid";
    static readonly RULES_VERSION = "prompt4rev-2026-07";
    static readonly SERIAL_PSET = "Pset_ManufacturerOccurrence";
    static readonly SERIAL_PROPERTY = "SerialNumber";

    constructor(private readonly lookup: AssetIdentityLookup) {}

    /** Serial number (evidência da instância física; campo separado). */
    static extractSerialNumber(psets: Record<string, Record<string, unknown>> | null | undefined): string | null {
        const raw = psets?.[IfcTagSerialAssetIdentityResolver.SERIAL_PSET]?.[IfcTagSerialAssetIdentityResolver.SERIAL_PROPERTY];
        if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
        return null;
    }

    async resolve(candidate: AssetIdentityCandidate, context: AssetIdentityContext): Promise<AssetIdentityResult> {
        const serialNumber = IfcTagSerialAssetIdentityResolver.extractSerialNumber(candidate.psets);

        const base = {
            resolverId: IfcTagSerialAssetIdentityResolver.ID,
            rulesVersion: IfcTagSerialAssetIdentityResolver.RULES_VERSION,
            resolvedAt: new Date().toISOString(),
            guid: candidate.guid,
            serialNumber,
        };

        /* ---- defensivo: o preflight garante Tag válida nos candidatos ---- */
        if (!isValidEquipmentTag(candidate.tag)) {
            return {
                ...base, status: "unresolved", matchedAssetId: null,
                method: null, identifierUsed: null, confidence: null,
                reasons: [
                    "managed equipment candidate without a valid EQP- Tag reached the resolver",
                    "new uploads without a valid Tag must fail in model_requirements_preflight; no GUID fallback exists for new uploads",
                ],
                candidatesConsidered: [], stableCode: null,
            };
        }

        const tag = normalizeEquipmentTag(candidate.tag);
        const matches = await this.lookup.findEquipmentByTag(context.linkedModelId, tag);

        /* ---- Tag corresponde a mais de um ativo (defensivo) ---- */
        if (matches.length > 1) {
            return {
                ...base, status: "ambiguous", matchedAssetId: null,
                method: "equipment_tag", identifierUsed: tag, confidence: null,
                reasons: [`Tag '${tag}' matches ${matches.length} existing assets (tag_conflict — inventory data quality)`],
                candidatesConsidered: matches.map((m) => ({ assetId: m.id, via: "equipment_tag" })),
                stableCode: tag,
            };
        }

        /* ---- Tag corresponde a exatamente um ativo ---- */
        if (matches.length === 1) {
            const match = matches[0]!;

            if (serialNumber && match.serial_number && serialNumber !== match.serial_number) {
                return {
                    ...base, status: "ambiguous", matchedAssetId: null,
                    method: "equipment_tag", identifierUsed: tag, confidence: null,
                    reasons: [
                        `Tag '${tag}' matches asset ${match.id} but serial numbers differ ('${serialNumber}' vs '${match.serial_number}')`,
                        "serial_conflict: physical replacement or data-quality issue — requires human reconciliation (no automatic merge)",
                    ],
                    candidatesConsidered: [{ assetId: match.id, via: "equipment_tag" }],
                    stableCode: tag,
                };
            }

            if (serialNumber && match.serial_number && serialNumber === match.serial_number) {
                return {
                    ...base, status: "matched", matchedAssetId: match.id,
                    method: "tag_and_serial", identifierUsed: tag, confidence: "high",
                    reasons: [`Tag '${tag}' and serial '${serialNumber}' both match asset ${match.id} (strong evidence of same physical asset)`],
                    candidatesConsidered: [{ assetId: match.id, via: "tag_and_serial" }],
                    stableCode: tag,
                };
            }

            return {
                ...base, status: "matched", matchedAssetId: match.id,
                method: "equipment_tag", identifierUsed: tag, confidence: "high",
                reasons: [
                    `manager-controlled Tag '${tag}' matches asset ${match.id}`,
                    "serial number absent in one or both versions — reduced physical-instance evidence (documented)",
                ],
                candidatesConsidered: [{ assetId: match.id, via: "equipment_tag" }],
                stableCode: tag,
            };
        }

        /* ---- Tag nova; verificar renumeração pelo serial ---- */
        if (serialNumber) {
            const serialMatches = await this.lookup.findEquipmentBySerial(context.linkedModelId, serialNumber);
            if (serialMatches.length > 0) {
                return {
                    ...base, status: "ambiguous", matchedAssetId: null,
                    method: "equipment_tag", identifierUsed: tag, confidence: null,
                    reasons: [
                        `serial '${serialNumber}' already belongs to asset(s) ${serialMatches.map((m) => m.id).join(", ")} with a different Tag`,
                        "serial_renumbering: renumbering or data-quality issue — requires human reconciliation (no automatic merge)",
                    ],
                    candidatesConsidered: serialMatches.map((m) => ({ assetId: m.id, via: "serial_number" })),
                    stableCode: tag,
                };
            }
        }

        /* ---- identidade nova (Tag do gestor ainda não inventariada) ---- */
        return {
            ...base, status: "new", matchedAssetId: null,
            method: "equipment_tag", identifierUsed: tag, confidence: "high",
            reasons: [`Tag '${tag}' has no existing asset in this scope — new managed equipment identity`],
            candidatesConsidered: [], stableCode: tag,
        };
    }
}
