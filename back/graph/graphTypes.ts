/**
 * Contratos do cliente de grafo semântico (Prompt 5A — fundação).
 *
 * O resto da aplicação depende APENAS destes tipos + do provider
 * (graphClientProvider.ts). Nenhum detalhe específico do triplestore
 * (Fuseki ou outro) pode ser exposto fora de back/graph/.
 *
 * O grafo é OPCIONAL nesta etapa: nenhuma operação atual (upload, preflight,
 * reservas, viewer, políticas, sensores) pode depender dele. Erros do grafo
 * nunca podem alterar dados SQL nem o fluxo operacional.
 */

/** Formatos RDF aceites nas escritas via Graph Store Protocol. */
export type RdfContentType =
    | "text/turtle"
    | "application/n-triples"
    | "application/ld+json"
    | "application/rdf+xml";

/** Códigos de erro do grafo — diferenciados para diagnóstico e testes. */
export type GraphErrorCode =
    | "graph_not_configured"
    | "graph_unavailable"
    | "graph_timeout"
    | "graph_authentication_failed"
    | "graph_query_failed"
    | "graph_update_failed"
    | "graph_invalid_response"
    | "graph_configuration_error";

/**
 * Erro tipado do grafo. A mensagem NUNCA pode conter password, header
 * Authorization nem payload RDF completo.
 */
export class GraphError extends Error {
    readonly code: GraphErrorCode;
    readonly operation: string | null;
    readonly httpStatus: number | null;

    constructor(
        code: GraphErrorCode,
        message: string,
        options: { operation?: string; httpStatus?: number; cause?: unknown } = {}
    ) {
        super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = "GraphError";
        this.code = code;
        this.operation = options.operation ?? null;
        this.httpStatus = options.httpStatus ?? null;
    }
}

/** Resultado do health check — nunca lança; o estado vai no próprio objeto. */
export interface GraphHealthResult {
    ok: boolean;
    provider: string;
    queryEndpoint: string;
    durationMs: number;
    errorCode: GraphErrorCode | null;
    error: string | null;
}

/** Valor de um binding no formato SPARQL 1.1 Query Results JSON. */
export interface SparqlBindingValue {
    type: "uri" | "literal" | "bnode";
    value: string;
    datatype?: string;
    "xml:lang"?: string;
}

/** Resultado de query SPARQL (SELECT → results.bindings; ASK → boolean). */
export interface SparqlQueryResult<T = Record<string, SparqlBindingValue>> {
    head?: { vars?: string[] };
    boolean?: boolean;
    results?: { bindings: T[] };
}

/** Opções comuns; o cancelamento externo é suportado via AbortSignal. */
export interface GraphRequestOptions {
    signal?: AbortSignal;
}

/**
 * Cliente abstrato do grafo. Implementações concretas vivem em back/graph/
 * e são obtidas exclusivamente via getGraphClient() (provider central).
 */
export interface GraphClient {
    readonly providerId: string;

    healthCheck(options?: GraphRequestOptions): Promise<GraphHealthResult>;

    /** Substitui (PUT) o named graph indicado pelo payload RDF fornecido. */
    putGraph(
        graphUri: string,
        rdfPayload: string,
        contentType: RdfContentType,
        options?: GraphRequestOptions
    ): Promise<void>;

    query<T = Record<string, SparqlBindingValue>>(
        sparql: string,
        options?: GraphRequestOptions
    ): Promise<SparqlQueryResult<T>>;

    update(sparql: string, options?: GraphRequestOptions): Promise<void>;

    /** Remove APENAS o named graph indicado (nunca CLEAR ALL / DROP ALL). */
    deleteGraph(graphUri: string, options?: GraphRequestOptions): Promise<void>;
}
