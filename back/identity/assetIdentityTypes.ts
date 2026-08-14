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

/**
 * Linha de um ativo persistente devolvida pelos lookups de identidade.
 *
 * `linked_model_id` é METADADO DE ORIGEM (o linked_model onde o ativo foi criado)
 * — é devolvido como EVIDÊNCIA para diagnóstico/reconciliação e NUNCA participa
 * do predicado de correspondência (TAG-1 §4). Nunca é reinterpretado como
 * "último modelo tocado" nem atualizado em reutilização entre modelos.
 */
export interface AssetIdentityRow {
    id: number;
    asset_code: string | null;
    serial_number: string | null;
    linked_model_id: number | null;
}

/**
 * Presença de um ativo persistente na versão CORRENTE de uma linha de modelo
 * (TAG-1 CASE E). "Corrente" vem EXCLUSIVAMENTE de `models.current_version_id`
 * — nunca de timestamps, do maior id nem da ordem de upload.
 */
export interface AssetCurrentModelPresence {
    model_id: number;
    model_version_id: number;
}

export interface AssetIdentityLookup {
    /**
     * TAG-1 §2 — correspondência de identidade em TODO o portefólio: o predicado
     * é `canonical(asset_code) = canonical(:tag)`, SEM `linked_model_id`. Pode
     * devolver MAIS DO QUE UMA linha (duplicados históricos → ambiguidade).
     *
     * A implementação tem de devolver um SUPERCONJUNTO garantido do que
     * `canonicalEquipmentTagKey` considera equivalente — nunca um pré-filtro que
     * imite a canonicalização noutro motor (falso negativo de identidade).
     */
    findEquipmentByTag(canonicalTag: string): Promise<AssetIdentityRow[]>;
    /**
     * TAG-1 §3 (V2) — evidência secundária, restrita ao MESMO `linked_model_id`
     * (heurística "mudou a Tag, manteve o serial" entre versões da mesma linha de
     * modelo). NUNCA cria nem reutiliza identidade por si só e NUNCA pode vetar
     * uma decisão autoritativa pela Tag com base num ativo não relacionado noutro
     * ponto do portefólio.
     */
    findEquipmentBySerial(serial: string, linkedModelId: number): Promise<AssetIdentityRow[]>;
    /**
     * TAG-1 §4 — ativos persistentes com um binding (corrente OU histórico) para
     * este IFC GlobalId. O GlobalId identifica uma MANIFESTAÇÃO, nunca a
     * identidade; serve só como evidência de conflito.
     */
    findEquipmentByGuidHistory(ifcGuid: string): Promise<AssetIdentityRow[]>;
    /** TAG-1 §7 — linhas de modelo onde este ativo está na versão CORRENTE. */
    findCurrentModelPresence(assetId: number): Promise<AssetCurrentModelPresence[]>;
}

export interface AssetIdentityResolver {
    resolve(candidate: AssetIdentityCandidate, context: AssetIdentityContext): Promise<AssetIdentityResult>;
}
