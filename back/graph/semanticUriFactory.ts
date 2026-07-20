/**
 * Fábrica de URIs semânticas (Prompt 5A) — estratégia estável documentada em
 * ADR-0020.
 *
 * Princípios:
 *  - URIs determinísticas construídas EXCLUSIVAMENTE a partir de identidade
 *    persistente (space_uuid, asset_uuid, identificadores estáveis de
 *    modelo/versão) — nunca de auto-increment SQL isolado;
 *  - a URI de um ativo NUNCA contém localização (espaço, binding, coordenada)
 *    nem versão de modelo: mesmo equipamento noutro espaço = mesma URI;
 *  - entities e model versions são as ÚNICAS URIs com contexto de versão
 *    (uma entity é um snapshot de uma versão concreta);
 *  - a fábrica não consulta a base de dados, não decide domínio e não
 *    escreve nada — só constrói cadeias de caracteres;
 *  - ativos modelados/espaços continuam sem backfill semântico automático;
 *    ativos graph-originated e artefactos governados persistem URIs próprias
 *    nos seus fluxos explícitos.
 *
 * Lacuna documentada: linked_models, models, model_versions e entities ainda
 * não têm UUID próprio. Até essa migration (etapa futura), as funções de
 * modelo/versão aceitam um identificador estável fornecido pelo chamador e
 * rejeitam números puros (auto-increment) como identidade global.
 */
import { GraphError } from "./graphTypes.ts";
import { validateBaseUri } from "./graphConfig.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PURE_NUMBER_PATTERN = /^\d+$/;

export interface SemanticUriFactory {
    readonly baseUri: string;
    linkedModelUri(linkedModelStableId: string): string;
    modelUri(modelStableId: string): string;
    modelVersionUri(modelVersionStableId: string): string;
    /** Entity é snapshot de UMA versão — a URI inclui o contexto da versão. */
    entityUri(modelVersionStableId: string, entityStableToken: string): string;
    spaceUri(spaceUuid: string): string;
    assetUri(assetUuid: string): string;
    locationAssignmentUri(assignmentUuid: string): string;
    provenanceActivityUri(activityUuid: string): string;
    validationResultUri(resultUuid: string): string;
}

function stableSegment(name: string, value: string): string {
    if (typeof value !== "string" || value.trim() === "") {
        throw new GraphError("graph_configuration_error", `${name} must be a non-empty stable identifier`);
    }
    const trimmed = value.trim();
    if (PURE_NUMBER_PATTERN.test(trimmed)) {
        throw new GraphError(
            "graph_configuration_error",
            `${name} must not be a bare numeric SQL id ('${trimmed}') — use a UUID or another globally stable identifier`
        );
    }
    return encodeURIComponent(trimmed);
}

function uuidSegment(name: string, value: string): string {
    if (typeof value !== "string" || !UUID_PATTERN.test(value.trim())) {
        throw new GraphError("graph_configuration_error", `${name} must be a UUID (got '${String(value)}')`);
    }
    return value.trim().toLowerCase();
}

export function createSemanticUriFactory(rawBaseUri: string): SemanticUriFactory {
    const baseUri = validateBaseUri(rawBaseUri, "baseUri");

    return {
        baseUri,
        linkedModelUri: (id) => `${baseUri}/linked-model/${stableSegment("linkedModelStableId", id)}`,
        modelUri: (id) => `${baseUri}/model/${stableSegment("modelStableId", id)}`,
        modelVersionUri: (id) => `${baseUri}/model-version/${stableSegment("modelVersionStableId", id)}`,
        entityUri: (versionId, entityToken) =>
            `${baseUri}/entity/${stableSegment("modelVersionStableId", versionId)}/${stableSegment("entityStableToken", entityToken)}`,
        spaceUri: (spaceUuid) => `${baseUri}/space/${uuidSegment("spaceUuid", spaceUuid)}`,
        assetUri: (assetUuid) => `${baseUri}/asset/${uuidSegment("assetUuid", assetUuid)}`,
        locationAssignmentUri: (uuid) => `${baseUri}/location-assignment/${uuidSegment("assignmentUuid", uuid)}`,
        provenanceActivityUri: (uuid) => `${baseUri}/provenance-activity/${uuidSegment("activityUuid", uuid)}`,
        validationResultUri: (uuid) => `${baseUri}/validation-result/${uuidSegment("resultUuid", uuid)}`,
    };
}

/**
 * Conveniência: fábrica a partir de GRAPH_BASE_URI do ambiente. Lança
 * graph_not_configured quando a variável está ausente — nenhum fluxo atual
 * pode depender disto (URIs continuam opcionais e nunca são exigidas).
 */
export function semanticUriFactoryFromEnv(env: NodeJS.ProcessEnv = process.env): SemanticUriFactory {
    const raw = (env.GRAPH_BASE_URI ?? "").trim();
    if (raw === "") {
        throw new GraphError("graph_not_configured", "GRAPH_BASE_URI is not set — semantic URIs are unavailable");
    }
    return createSemanticUriFactory(raw);
}
