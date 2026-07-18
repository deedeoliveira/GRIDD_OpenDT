/**
 * Convenção de named graphs do OSWADT (Prompt 5A) + guardas de segurança.
 *
 * Convenção (relativa a GRAPH_BASE_URI):
 *   {base}/graph/model-version/{modelVersionStableId} — dados derivados de UMA
 *       versão IFC (nunca misturar versões; nunca usar apenas model_id);
 *   {base}/graph/operational   — futuro: ativos não modelados, localização
 *       operacional, afirmações e proveniência (Prompt 5B; vazio nesta etapa);
 *   {base}/graph/vocabularies  — futuro: ontologias/vocabulários (nenhuma
 *       ontologia é carregada nesta etapa);
 *   {base}/graph/validation    — futuro: resultados de validação (reservado;
 *       resultados atuais de policy/preflight NÃO são gravados em RDF);
 *   {base}/graph/test/{testRunUuid} — grafos de teste, um por execução; a
 *       limpeza apaga APENAS o próprio grafo do teste.
 *
 * Guardas (pós-incidente de storage — ver fix(test-safety)):
 *   - CLEAR/DROP ALL|NAMED|DEFAULT são SEMPRE recusados pelo cliente;
 *   - com NODE_ENV=test só grafos {base}/graph/test/ podem ser apagados;
 *   - o grafo default nunca é apagável via deleteGraph.
 */
import { randomUUID } from "node:crypto";
import { GraphError } from "./graphTypes.ts";
import { validateBaseUri } from "./graphConfig.ts";

function segment(name: string, value: string): string {
    if (typeof value !== "string" || value.trim() === "") {
        throw new GraphError("graph_configuration_error", `${name} must be a non-empty string`);
    }
    return encodeURIComponent(value.trim());
}

/** Grafo com os dados derivados de UMA model_version (identidade explícita da versão). */
export function modelVersionGraphUri(baseUri: string, modelVersionStableId: string): string {
    return `${validateBaseUri(baseUri, "baseUri")}/graph/model-version/${segment("modelVersionStableId", modelVersionStableId)}`;
}

/** Grafo operacional (futuro — Prompt 5B). Nenhum dado é escrito nesta etapa. */
export function operationalGraphUri(baseUri: string): string {
    return `${validateBaseUri(baseUri, "baseUri")}/graph/operational`;
}

/** Grafo de ontologias/vocabulários (futuro). */
export function vocabulariesGraphUri(baseUri: string): string {
    return `${validateBaseUri(baseUri, "baseUri")}/graph/vocabularies`;
}

/** Grafo de resultados de validação (futuro — convenção apenas reservada). */
export function validationGraphUri(baseUri: string): string {
    return `${validateBaseUri(baseUri, "baseUri")}/graph/validation`;
}

/** Grafo de teste identificado por um UUID de execução. */
export function testGraphUri(baseUri: string, testRunUuid: string): string {
    return `${validateBaseUri(baseUri, "baseUri")}/graph/test/${segment("testRunUuid", testRunUuid)}`;
}

/** Grafo de teste novo e único (um por execução de teste/smoke). */
export function newTestGraphUri(baseUri: string): string {
    return testGraphUri(baseUri, randomUUID());
}

/** True quando a URI pertence ao namespace de grafos de teste. */
export function isTestGraphUri(graphUri: string): boolean {
    return typeof graphUri === "string" && graphUri.includes("/graph/test/");
}

/**
 * Uma model_version só pode materializar grafo "de produção" quando o seu
 * processamento terminou com sucesso: estados `active` e `archived`.
 * `processing` (incompleta) e `failed` (rejeitada) NUNCA recebem grafo.
 * (Nenhum grafo de versão é efetivamente escrito nesta etapa — Prompt 5B.)
 */
export function canMaterializeModelVersionGraph(status: string): boolean {
    return status === "active" || status === "archived";
}

const FORBIDDEN_UPDATE = /(^|[^A-Za-z])(clear|drop)\s+(silent\s+)?(all|named|default)\b/i;

/** Recusa operações SPARQL destrutivas de âmbito global (CLEAR/DROP ALL...). */
export function assertSparqlUpdateAllowed(sparql: string): void {
    if (typeof sparql !== "string" || sparql.trim() === "") {
        throw new GraphError("graph_update_failed", "SPARQL update must be a non-empty string", { operation: "update" });
    }
    if (FORBIDDEN_UPDATE.test(sparql)) {
        throw new GraphError(
            "graph_update_failed",
            "destructive global SPARQL operations (CLEAR/DROP ALL, NAMED or DEFAULT) are forbidden — delete only specific graphs via deleteGraph",
            { operation: "update" }
        );
    }
}

/**
 * Guarda de remoção: valida a URI e, em NODE_ENV=test, só permite apagar
 * grafos do namespace de teste (nunca o grafo de outro domínio, nunca o default).
 */
export function assertGraphDeletable(graphUri: string, env: NodeJS.ProcessEnv = process.env): void {
    if (typeof graphUri !== "string" || graphUri.trim() === "") {
        throw new GraphError("graph_update_failed", "deleteGraph requires a non-empty graph URI", { operation: "deleteGraph" });
    }
    try {
        new URL(graphUri);
    } catch {
        throw new GraphError("graph_update_failed", `deleteGraph requires an absolute graph URI (got '${graphUri}')`, { operation: "deleteGraph" });
    }
    if (env.NODE_ENV === "test" && !isTestGraphUri(graphUri)) {
        throw new GraphError(
            "graph_update_failed",
            "tests may only delete graphs under the test namespace ({base}/graph/test/...) — refusing to delete a non-test graph",
            { operation: "deleteGraph" }
        );
    }
}
