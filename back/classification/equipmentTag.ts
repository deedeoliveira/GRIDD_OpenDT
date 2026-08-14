/**
 * Código institucional de inventário dos equipamentos MODELADOS (revisão do
 * Prompt 4): IfcElement.Tag com prefixo EQP-, controlada deliberadamente pelo
 * gestor/modelador (o Revit não a preenche automaticamente).
 *
 * Fonte ÚNICA das regras de validação/normalização da Tag — partilhada pelo
 * preflight de requisitos, pelo classificador e pelo resolver de identidade.
 * Ativos NÃO modelados não usam estas regras (perfil próprio, etapa futura).
 */

export const EQUIPMENT_TAG_PREFIX = "EQP-";

/** Tag válida: string, não vazia, começa por EQP- e tem conteúdo depois. */
export function isValidEquipmentTag(tag: unknown): tag is string {
    if (typeof tag !== "string") return false;
    const trimmed = tag.trim();
    return trimmed.startsWith(EQUIPMENT_TAG_PREFIX)
        && trimmed.length > EQUIPMENT_TAG_PREFIX.length;
}

/** Valor persistido em asset_code (Tag institucional, aparada). */
export function normalizeEquipmentTag(tag: string): string {
    return tag.trim();
}

/**
 * TAG-1 (V2) — ÚNICA autoridade de canonicalização da Tag institucional.
 *
 * Esta é a definição; tudo o resto (deteção de duplicados no preflight,
 * correspondência de identidade no resolver, nome do lock consultivo, pré-visão
 * do intake) DELEGA aqui. Não pode existir uma segunda regra: se o preflight e o
 * resolver discordassem, o preflight aceitaria duas Tags que o resolver depois
 * trataria como a mesma identidade (ou o inverso).
 *
 * Determinística e independente do motor: a decisão de correspondência é tomada
 * SEMPRE em JavaScript, NUNCA pela collation do MySQL. Desde a V2 o SQL já nem
 * sequer tenta reproduzir esta regra — `UPPER()` do MySQL e `.toUpperCase()` do
 * JavaScript NÃO são equivalentes em todo o Unicode (ex.: 'ß' → 'SS' é uma
 * expansão que o JavaScript faz e o `UPPER()` do MySQL não; o 'ı' turco e outros
 * mapeamentos sensíveis à locale também divergem), pelo que um pré-filtro SQL que
 * imitasse esta função poderia EXCLUIR uma linha que esta função considera
 * equivalente (falso negativo de identidade — inaceitável). Ver
 * `findEquipmentByTag` em `back/utils/persistentAssetDatabase.ts`.
 *
 * NÃO é o valor persistido: `asset_code`/snapshots continuam a receber a Tag
 * apenas APARADA ({@link normalizeEquipmentTag}), preservando as maiúsculas/
 * minúsculas escolhidas pelo gestor para exibição.
 */
export function canonicalEquipmentTagKey(tag: string): string {
    return tag.trim().toUpperCase();
}

/**
 * Chave de deteção de duplicações (preflight). É POR DEFINIÇÃO a chave canónica
 * de identidade — alias nomeado para o papel, nunca uma regra concorrente.
 */
export function equipmentTagDuplicateKey(tag: string): string {
    return canonicalEquipmentTagKey(tag);
}

/** Descreve por que motivo uma Tag é inválida (para diagnósticos). */
export function describeInvalidTag(tag: unknown): string {
    if (tag === null || tag === undefined) return "missing_tag";
    if (typeof tag !== "string") return "tag_not_a_string";
    if (tag.trim().length === 0) return "empty_or_whitespace_tag";
    if (!tag.trim().startsWith(EQUIPMENT_TAG_PREFIX)) return "tag_without_EQP_prefix";
    return "tag_without_content_after_prefix";
}
