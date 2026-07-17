/**
 * Identidade persistente dos ATIVOS modelados (Prompt 4 + revisão Tag/serial).
 *
 * Responsabilidades distintas (nunca fundir):
 *  - Identidade:      "qual recurso real este registo representa?"
 *  - Binding:         "como esse recurso aparece nesta model_version?"
 *  - Localização:     "em que espaço persistente está nesta representação?"
 *  - Reservabilidade: "pode participar do fluxo de reservas?" (política).
 *
 * Para equipamentos modelados, a identidade institucional é IfcElement.Tag
 * (perfil EQP-, controlada pelo gestor); o serial number é evidência SEPARADA
 * da instância física; o IFC GUID é apenas rastreabilidade/compatibilidade
 * histórica (backfill — método legacy_ifc_guid). ObjectType e informação de
 * fabricante NUNCA participam da identidade. Ativos não modelados terão um
 * perfil de identidade próprio numa etapa futura — estas regras não se
 * aplicam a eles.
 */

export type AssetIdentityStatus = "matched" | "new" | "ambiguous" | "unresolved";

export interface AssetIdentityCandidate {
    guid: string;
    name?: string | null;
    ifcType?: string | null;
    /** IfcElement.Tag (código institucional; o preflight garante a validade). */
    tag?: string | null;
    /** ObjectType do proxy (classificação informativa — NUNCA identidade). */
    objectType?: string | null;
    psets?: Record<string, Record<string, unknown>> | null;
    entityId: number;
    /** Espaço persistente onde o candidato está contido (se resolvido). */
    spaceId?: number | null;
}

export interface AssetIdentityContext {
    linkedModelId: number;
    modelId: number;
    modelVersionId: number;
}

export interface AssetIdentityCandidateConsidered {
    assetId: number;
    via: string;
}

export interface AssetIdentityResult {
    status: AssetIdentityStatus;
    matchedAssetId: number | null;
    /** equipment_tag | tag_and_serial | (backfill: legacy_ifc_guid) | null. */
    method: string | null;
    identifierUsed: string | null;
    confidence: "high" | "medium" | "low" | null;
    reasons: string[];
    candidatesConsidered: AssetIdentityCandidateConsidered[];
    resolverId: string;
    rulesVersion: string;
    resolvedAt: string;
    guid: string;
    /** Código institucional (Tag aparada) a persistir em asset_code — nada mais. */
    stableCode: string | null;
    /** Serial observado (campo separado; NUNCA vai para asset_code). */
    serialNumber: string | null;
}

export interface AssetIdentityLookup {
    findEquipmentByTag(linkedModelId: number, tag: string): Promise<{ id: number; asset_code: string | null; serial_number: string | null }[]>;
    findEquipmentBySerial(linkedModelId: number, serial: string): Promise<{ id: number; asset_code: string | null; serial_number: string | null }[]>;
}

export interface AssetIdentityResolver {
    resolve(candidate: AssetIdentityCandidate, context: AssetIdentityContext): Promise<AssetIdentityResult>;
}
