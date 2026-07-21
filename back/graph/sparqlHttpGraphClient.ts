/**
 * Implementação concreta do GraphClient sobre o protocolo SPARQL 1.1
 * (Query + Update + Graph Store Protocol). Testada contra Apache Jena
 * Fuseki (ADR-0019), mas sem dependências específicas do Fuseki — o health
 * check usa `ASK {}` (portável) e não o endpoint administrativo /$/ping.
 *
 * Segurança/observabilidade:
 *  - timeout por pedido (GRAPH_REQUEST_TIMEOUT_MS) + cancelamento externo
 *    via AbortSignal;
 *  - autenticação básica quando configurada; o header Authorization e a
 *    password NUNCA aparecem em logs ou mensagens de erro;
 *  - logs estruturados `graph_operation` (sem payload RDF nem texto SPARQL);
 *  - CLEAR/DROP globais recusados; deleteGraph com guarda de namespace.
 *
 * Instanciação apenas via graphClientProvider.ts (fora de testes).
 */
import type {
    GraphClient,
    GraphHealthResult,
    GraphRequestOptions,
    RdfContentType,
    SparqlBindingValue,
    SparqlQueryResult,
} from "./graphTypes.ts";
import { GraphError } from "./graphTypes.ts";
import type { GraphConfig } from "./graphConfig.ts";
import { assertGraphDeletable, assertSparqlUpdateAllowed } from "./namedGraphs.ts";

type FetchLike = typeof fetch;

const ERROR_BODY_PREVIEW_CHARS = 200;

export class SparqlHttpGraphClient implements GraphClient {
    readonly providerId: string;
    private readonly config: GraphConfig;
    private readonly fetchImpl: FetchLike;

    constructor(config: GraphConfig, fetchImpl: FetchLike = fetch) {
        this.providerId = config.provider;
        this.config = config;
        this.fetchImpl = fetchImpl;
    }

    async healthCheck(options: GraphRequestOptions = {}): Promise<GraphHealthResult> {
        const startedAt = Date.now();
        const base = {
            provider: this.providerId,
            queryEndpoint: this.config.queryEndpoint,
        };
        try {
            const result = await this.query<Record<string, SparqlBindingValue>>("ASK {}", options);
            if (typeof result.boolean !== "boolean") {
                throw new GraphError("graph_invalid_response", "health ASK did not return a boolean result", { operation: "healthCheck" });
            }
            return { ...base, ok: true, durationMs: Date.now() - startedAt, errorCode: null, error: null };
        } catch (error) {
            const graphError = error instanceof GraphError
                ? error
                : new GraphError("graph_unavailable", String((error as Error)?.message ?? error), { operation: "healthCheck" });
            return {
                ...base,
                ok: false,
                durationMs: Date.now() - startedAt,
                errorCode: graphError.code,
                error: graphError.message,
            };
        }
    }

    async query<T = Record<string, SparqlBindingValue>>(
        sparql: string,
        options: GraphRequestOptions = {}
    ): Promise<SparqlQueryResult<T>> {
        if (typeof sparql !== "string" || sparql.trim() === "") {
            throw new GraphError("graph_query_failed", "SPARQL query must be a non-empty string", { operation: "query" });
        }
        const response = await this.request("query", this.config.queryEndpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Accept: "application/sparql-results+json",
            },
            body: new URLSearchParams({ query: sparql }).toString(),
        }, options);

        if (!response.ok) {
            throw await this.httpError("query", "graph_query_failed", response);
        }

        let parsed: SparqlQueryResult<T>;
        try {
            parsed = (await response.json()) as SparqlQueryResult<T>;
        } catch {
            this.log("query", false, { errorCode: "graph_invalid_response" });
            throw new GraphError("graph_invalid_response", "graph query endpoint returned a non-JSON response", { operation: "query" });
        }
        if (typeof parsed !== "object" || parsed === null || (typeof parsed.boolean !== "boolean" && parsed.results === undefined)) {
            this.log("query", false, { errorCode: "graph_invalid_response" });
            throw new GraphError("graph_invalid_response", "graph query endpoint returned an unexpected result shape", { operation: "query" });
        }
        this.log("query", true, {});
        return parsed;
    }

    async update(sparql: string, options: GraphRequestOptions = {}): Promise<void> {
        assertSparqlUpdateAllowed(sparql);
        const response = await this.request("update", this.config.updateEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ update: sparql }).toString(),
        }, options);

        if (!response.ok) {
            throw await this.httpError("update", "graph_update_failed", response);
        }
        this.log("update", true, {});
    }

    async putGraph(
        graphUri: string,
        rdfPayload: string,
        contentType: RdfContentType,
        options: GraphRequestOptions = {}
    ): Promise<void> {
        this.assertAbsoluteGraphUri("putGraph", graphUri);
        const response = await this.request("putGraph", this.gspUrl(graphUri), {
            method: "PUT",
            headers: { "Content-Type": contentType },
            body: rdfPayload,
        }, options);

        if (!response.ok) {
            throw await this.httpError("putGraph", "graph_update_failed", response, graphUri);
        }
        this.log("putGraph", true, { graphUri });
    }

    async getGraph(graphUri: string, options: GraphRequestOptions = {}): Promise<string> {
        this.assertAbsoluteGraphUri("getGraph", graphUri);
        const response = await this.request("getGraph", this.gspUrl(graphUri), {
            method: "GET", headers: { Accept: "text/turtle" },
        }, options);
        if (!response.ok) throw await this.httpError("getGraph", "graph_query_failed", response, graphUri);
        const turtle = await response.text();
        this.log("getGraph", true, { graphUri });
        return turtle;
    }

    async deleteGraph(graphUri: string, options: GraphRequestOptions = {}): Promise<void> {
        assertGraphDeletable(graphUri);
        const response = await this.request("deleteGraph", this.gspUrl(graphUri), { method: "DELETE" }, options);

        // 404 = grafo já não existe → remoção idempotente, não é erro
        if (!response.ok && response.status !== 404) {
            throw await this.httpError("deleteGraph", "graph_update_failed", response, graphUri);
        }
        this.log("deleteGraph", true, { graphUri });
    }

    /* ------------------------------------------------------------------ */

    private gspUrl(graphUri: string): string {
        const url = new URL(this.config.dataEndpoint);
        url.searchParams.set("graph", graphUri);
        return url.toString();
    }

    private assertAbsoluteGraphUri(operation: string, graphUri: string): void {
        try {
            new URL(graphUri);
        } catch {
            throw new GraphError("graph_update_failed", `${operation} requires an absolute graph URI (got '${graphUri}')`, { operation });
        }
    }

    private async request(
        operation: string,
        url: string,
        init: RequestInit & { headers?: Record<string, string> },
        options: GraphRequestOptions
    ): Promise<Response> {
        const headers: Record<string, string> = { ...(init.headers ?? {}) };
        if (this.config.username !== null && this.config.password !== null) {
            headers.Authorization =
                "Basic " + Buffer.from(`${this.config.username}:${this.config.password}`).toString("base64");
        }

        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, this.config.requestTimeoutMs);

        const externalSignal = options.signal;
        const forwardAbort = () => controller.abort(externalSignal?.reason);
        if (externalSignal !== undefined) {
            if (externalSignal.aborted) forwardAbort();
            else externalSignal.addEventListener("abort", forwardAbort, { once: true });
        }

        try {
            const response = await this.fetchImpl(url, { ...init, headers, signal: controller.signal });
            if (response.status === 401 || response.status === 403) {
                this.log(operation, false, { httpStatus: response.status, errorCode: "graph_authentication_failed" });
                throw new GraphError(
                    "graph_authentication_failed",
                    `graph service rejected the configured credentials (HTTP ${response.status})`,
                    { operation, httpStatus: response.status }
                );
            }
            return response;
        } catch (error) {
            if (error instanceof GraphError) throw error;
            if (timedOut) {
                this.log(operation, false, { errorCode: "graph_timeout" });
                throw new GraphError(
                    "graph_timeout",
                    `graph request exceeded GRAPH_REQUEST_TIMEOUT_MS (${this.config.requestTimeoutMs} ms)`,
                    { operation, cause: error }
                );
            }
            if (externalSignal?.aborted) {
                // cancelamento pedido pelo chamador — propaga tal e qual
                throw error;
            }
            this.log(operation, false, { errorCode: "graph_unavailable" });
            throw new GraphError(
                "graph_unavailable",
                `graph service unreachable at ${url.split("?")[0]}`,
                { operation, cause: error }
            );
        } finally {
            clearTimeout(timer);
            externalSignal?.removeEventListener("abort", forwardAbort);
        }
    }

    private async httpError(
        operation: string,
        code: "graph_query_failed" | "graph_update_failed",
        response: Response,
        graphUri?: string
    ): Promise<GraphError> {
        let preview = "";
        try {
            preview = (await response.text()).slice(0, ERROR_BODY_PREVIEW_CHARS);
        } catch {
            /* corpo ilegível — segue sem preview */
        }
        this.log(operation, false, { httpStatus: response.status, errorCode: code, ...(graphUri !== undefined ? { graphUri } : {}) });
        return new GraphError(
            code,
            `graph ${operation} failed with HTTP ${response.status}${preview ? `: ${preview}` : ""}`,
            { operation, httpStatus: response.status }
        );
    }

    /** Log estruturado sem credenciais, sem SPARQL e sem payload RDF. */
    private log(
        operation: string,
        ok: boolean,
        extra: { httpStatus?: number; errorCode?: string; graphUri?: string }
    ): void {
        console.log(JSON.stringify({
            type: "graph_operation",
            provider: this.providerId,
            operation,
            ok,
            ...extra,
            at: new Date().toISOString(),
        }));
    }
}
