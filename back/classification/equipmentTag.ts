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

/** Chave de deteção de duplicações (case-insensitive, aparada). */
export function equipmentTagDuplicateKey(tag: string): string {
    return tag.trim().toUpperCase();
}

/** Descreve por que motivo uma Tag é inválida (para diagnósticos). */
export function describeInvalidTag(tag: unknown): string {
    if (tag === null || tag === undefined) return "missing_tag";
    if (typeof tag !== "string") return "tag_not_a_string";
    if (tag.trim().length === 0) return "empty_or_whitespace_tag";
    if (!tag.trim().startsWith(EQUIPMENT_TAG_PREFIX)) return "tag_without_EQP_prefix";
    return "tag_without_content_after_prefix";
}
