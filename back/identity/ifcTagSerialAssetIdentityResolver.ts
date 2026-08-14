import type {
    AssetIdentityCandidate,
    AssetIdentityContext,
    AssetIdentityLookup,
    AssetIdentityResolver,
    AssetIdentityResult,
} from "./assetIdentityTypes.ts";
import { canonicalEquipmentTagKey, isValidEquipmentTag, normalizeEquipmentTag } from "../classification/equipmentTag.ts";

/**
 * Resolver de identidade dos equipamentos MODELADOS — perfil atual (IFC4).
 *
 * Estratégia (revisão do Prompt 4 — substitui a ordem Reference>Serial>GUID):
 *  1. IfcElement.Tag com prefixo EQP- (código institucional do gestor) —
 *     única fonte de asset_code;
 *  2. SerialNumber (Pset_ManufacturerOccurrence) como evidência SECUNDÁRIA
 *     da instância física — pode confirmar, reduzir ou pôr em causa a
 *     correspondência, nunca substitui uma Tag ausente;
 *  3. IFC GUID: identifica UMA manifestação IFC e a sua rastreabilidade
 *     (binding), além da compatibilidade histórica do backfill
 *     (legacy_ifc_guid). NUNCA é chave de identidade nem fallback de
 *     correspondência em novos uploads (equipamento sem Tag válida falha no
 *     model_requirements_preflight). Desde TAG-1 é consultado para UMA coisa
 *     só: detetar que o mesmo GlobalId reaparece com outra Tag canónica, o que
 *     é EVIDÊNCIA DE CONFLITO e só pode produzir `ambiguous` — nunca `matched`.
 *
 * TAG-1 — âmbito da identidade: a Tag CANÓNICA (aparada + maiúsculas,
 * determinada em JavaScript, nunca pela collation do MySQL) é a chave de
 * identidade em TODO O PORTEFÓLIO. `assets.linked_model_id` saiu do predicado de
 * correspondência e permanece apenas como metadado de ORIGEM — nunca é
 * reinterpretado como "modelo atual" nem atualizado ao reutilizar entre modelos.
 *
 * Regras de correspondência (sem merge automático em conflito):
 *  - mesma Tag canónica + mesmo serial   → matched (tag_and_serial, forte);
 *  - mesma Tag canónica + serial ausente → matched (equipment_tag; evidência
 *    reduzida documentada nas razões);
 *  - mesma Tag canónica, modelo diferente, GlobalId novo → matched (reutiliza a
 *    MESMA linha `assets`; nada em asset_code/asset_uuid/linked_model_id muda);
 *  - mesma Tag + seriais diferentes      → caso de reconciliação
 *    (substituição física ou erro de dados — serial_conflict);
 *  - mesmo serial + Tags diferentes DENTRO do mesmo linked_model → caso de
 *    reconciliação (renumeração ou erro de dados — serial_renumbering). NUNCA em
 *    âmbito de portefólio: um serial coincidente noutro modelo, sem ligação de
 *    Tag nem de GlobalId, não é evidência e não veta uma Tag nova (V2);
 *  - mesmo GlobalId + Tag canónica diferente → caso de reconciliação
 *    (globalid_tag_conflict), com evidência de todos os candidatos;
 *  - >1 ativo com a mesma Tag canónica   → caso de reconciliação
 *    (tag_conflict — duplicados legados; NUNCA fundidos);
 *  - correspondência já presente na versão CORRENTE de outra linha de modelo →
 *    caso de reconciliação (simultaneous_current_model_presence);
 *  - Tag canónica nova                   → identidade nova.
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

        // Valor de EXIBIÇÃO/persistência: Tag apenas aparada (inalterado).
        const tag = normalizeEquipmentTag(candidate.tag);
        // Chave CANÓNICA de identidade: só para o predicado de correspondência.
        const canonicalTag = canonicalEquipmentTagKey(candidate.tag);
        // TAG-1 §2: âmbito de PORTEFÓLIO — sem linked_model_id no predicado.
        const matches = await this.lookup.findEquipmentByTag(canonicalTag);

        /* ---- TAG-1 §4: o mesmo GlobalId já pertenceu a outra Tag canónica? ----
           O GlobalId identifica uma MANIFESTAÇÃO, nunca a identidade. Se um
           binding (corrente ou histórico) deste GlobalId aponta para um ativo
           cuja Tag canónica é DIFERENTE da que chega agora, isso é evidência de
           conflito: nunca reatribuir a manifestação em silêncio, nunca mexer no
           asset_code do ativo original. Vai para reconciliação humana com a
           evidência de TODOS os candidatos (o dono histórico E o dono da Tag). */
        const guidHistory = await this.lookup.findEquipmentByGuidHistory(candidate.guid);
        const conflictingHistory = guidHistory.filter(
            (h) => h.asset_code !== null && canonicalEquipmentTagKey(h.asset_code) !== canonicalTag);

        if (conflictingHistory.length > 0) {
            const tagOwners = matches.filter((m) => !conflictingHistory.some((h) => h.id === m.id));
            return {
                ...base, status: "ambiguous", matchedAssetId: null,
                method: "equipment_tag", identifierUsed: tag, confidence: null,
                reasons: [
                    `GlobalId '${candidate.guid}' already manifests asset(s) ${conflictingHistory.map((h) => `${h.id} (Tag '${h.asset_code}')`).join(", ")} but now carries Tag '${tag}'`,
                    ...(tagOwners.length > 0
                        ? [`canonical Tag '${canonicalTag}' currently belongs to asset(s) ${tagOwners.map((m) => m.id).join(", ")} — evidence preserved for every candidate, no merge`]
                        : []),
                    "globalid_tag_conflict: a manifestation is never silently reassigned to a different persistent identity — requires human reconciliation",
                ],
                candidatesConsidered: [
                    ...conflictingHistory.map((h) => ({ assetId: h.id, via: "globalid_history" })),
                    ...tagOwners.map((m) => ({ assetId: m.id, via: "equipment_tag" })),
                ],
                stableCode: tag,
            };
        }

        /* ---- TAG-1 §5: a Tag canónica corresponde a mais de um ativo ----
           Duplicados persistentes históricos: FALHA FECHADA na reconciliação já
           existente, preservando a evidência de TODOS os candidatos. Nunca fundir
           automaticamente, nunca escolher o mais antigo/recente/do mesmo modelo. */
        if (matches.length > 1) {
            return {
                ...base, status: "ambiguous", matchedAssetId: null,
                method: "equipment_tag", identifierUsed: tag, confidence: null,
                reasons: [
                    `canonical Tag '${canonicalTag}' matches ${matches.length} existing persistent assets ${matches.map((m) => `${m.id} (asset_code '${m.asset_code}', origin linked_model ${m.linked_model_id})`).join(", ")}`,
                    "tag_conflict: legacy duplicate persistent identities — never merged automatically; requires human reconciliation",
                ],
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

            /* ---- TAG-1 §7 (CASE E): presença simultânea em modelos CORRENTES ----
               "Corrente" vem SÓ de models.current_version_id. Se o ativo já está
               na versão corrente de OUTRA linha de modelo, aceitá-lo também aqui
               significaria o mesmo equipamento físico presente em dois modelos
               correntes ao mesmo tempo — decisão humana, não reutilização
               silenciosa. Reutilizar contra um binding HISTÓRICO/superado, ou na
               MESMA linha de modelo (a nova versão sucede a corrente), continua a
               ser reutilização normal (CASE A/B). */
            const currentPresence = await this.lookup.findCurrentModelPresence(match.id);
            const elsewhere = currentPresence.filter((p) => Number(p.model_id) !== Number(context.modelId));
            if (elsewhere.length > 0) {
                return {
                    ...base, status: "ambiguous", matchedAssetId: null,
                    method: "equipment_tag", identifierUsed: tag, confidence: null,
                    reasons: [
                        `Tag '${tag}' matches asset ${match.id}, which is already present in the CURRENT version of model line(s) ${elsewhere.map((p) => `${p.model_id} (version ${p.model_version_id})`).join(", ")}`,
                        `the incoming manifestation belongs to model line ${context.modelId}`,
                        "simultaneous_current_model_presence: the same persistent equipment cannot be current in two model lines at once — requires human reconciliation (no automatic merge)",
                    ],
                    candidatesConsidered: [{ assetId: match.id, via: "current_model_presence" }],
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
            /* TAG-1 §3 (corrigido na V2): âmbito do MESMO linked_model.
               A heurística existe para apanhar "o modelador mudou a Tag mas
               manteve o serial" — algo que acontece entre versões da MESMA linha
               de modelo. Em âmbito de portefólio (V1) o serial tornava-se uma
               restrição de identidade NEGATIVA: um ativo sem qualquer relação
               (outra Tag, outro modelo, sem GlobalId comum) vetava a criação
               limpa de uma Tag nova por mera coincidência de serial. O serial é
               evidência SECUNDÁRIA e não tem unicidade de portefólio assumida,
               logo nunca pode vetar uma decisão autoritativa pela Tag. */
            const serialMatches = await this.lookup.findEquipmentBySerial(serialNumber, context.linkedModelId);
            if (serialMatches.length > 0) {
                return {
                    ...base, status: "ambiguous", matchedAssetId: null,
                    method: "equipment_tag", identifierUsed: tag, confidence: null,
                    reasons: [
                        `serial '${serialNumber}' already belongs to asset(s) ${serialMatches.map((m) => m.id).join(", ")} with a different Tag in the same linked model ${context.linkedModelId}`,
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
            reasons: [`canonical Tag '${canonicalTag}' has no existing asset anywhere in the portfolio — new managed equipment identity`],
            candidatesConsidered: [], stableCode: tag,
        };
    }
}
