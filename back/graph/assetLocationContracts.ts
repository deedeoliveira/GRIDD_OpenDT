/**
 * Contratos FUTUROS de localização temporal de ativos (Prompt 5A — apenas
 * tipos; nenhuma persistência, nenhuma escrita no grafo, nenhuma ingestão).
 * Ver ADR-0023.
 *
 * Princípios que estes contratos tornam explícitos:
 *  - a identidade do ativo NUNCA muda com a localização: mudar de espaço
 *    mantém o mesmo asset_id/asset_uuid e a mesma assetUri;
 *  - localização é TEMPORAL: uma atribuição tem validFrom/validTo; mover um
 *    ativo encerra a atribuição anterior e cria uma nova (não edita a antiga);
 *  - localização tem FONTE (ifc_binding, manual, sensor_inference,
 *    external_system) e proveniência; Tag, SerialNumber, GUID e ObjectType
 *    NÃO são fontes de localização — são identidade/evidência/classificação;
 *  - OBSERVAÇÃO ≠ LOCALIZAÇÃO VALIDADA: uma observação bruta de sensor
 *    (observedAt) nunca substitui automaticamente a localização operacional;
 *    a promoção a atribuição validada exigirá regra explícita de autoridade
 *    (etapa futura);
 *  - por fonte e regra de autoridade só pode existir UMA atribuição
 *    operacional corrente; conflitos entre fontes exigirão reconciliação
 *    futura (não implementada).
 *
 * Para ativos MODELADOS a autoridade da localização continua a ser o
 * asset_binding da versão corrente (models.current_version_id) — estes
 * contratos não a substituem nesta etapa.
 */

export const ASSET_LOCATION_SOURCES = [
    "ifc_binding",
    "manual",
    "sensor_inference",
    "external_system",
] as const;

export type AssetLocationSource = (typeof ASSET_LOCATION_SOURCES)[number];

/** Afirmação (validada) de que um ativo esteve/está num espaço num intervalo. */
export interface AssetLocationAssertion {
    assertionId: string;
    /** URI persistente do ativo — independente de localização e de versão. */
    assetUri: string;
    /** URI persistente do espaço — a localização é uma RELAÇÃO, não parte da identidade. */
    spaceUri: string;
    source: AssetLocationSource;

    /** Início de validade (ISO 8601). */
    validFrom: string;
    /** Fim de validade; null/ausente = atribuição corrente. */
    validTo?: string | null;
    /** Momento da observação de origem, quando distinta da validade (sensores). */
    observedAt?: string | null;
    /** Confiança da fonte (0..1), quando aplicável. */
    confidence?: number | null;
    /** Atividade de proveniência (futura, PROV-O ou equivalente). */
    provenanceActivityUri?: string | null;
}

/**
 * Encerra uma atribuição SEM alterar identidade: devolve uma nova afirmação
 * com validTo preenchido; assertionId/assetUri/spaceUri/source preservados.
 * (Puro; a persistência é trabalho do Prompt 5B.)
 */
export function closeLocationAssertion(
    assertion: AssetLocationAssertion,
    validTo: string
): AssetLocationAssertion {
    return { ...assertion, validTo };
}

/** True quando a atribuição está corrente (sem fim de validade). */
export function isCurrentLocationAssertion(assertion: AssetLocationAssertion): boolean {
    return assertion.validTo === undefined || assertion.validTo === null;
}
