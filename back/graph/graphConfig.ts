/**
 * Configuração do grafo semântico por variáveis de ambiente (Prompt 5A).
 *
 * O grafo é OPCIONAL: com as variáveis ausentes, loadGraphConfig() devolve
 * { configured: false } e a aplicação arranca e funciona normalmente. A
 * validação só lança (GraphError graph_configuration_error) quando existe
 * configuração PARCIAL ou INVÁLIDA — e apenas no momento em que uma operação
 * de grafo é explicitamente pedida (o carregamento é lazy, no provider).
 *
 * Variáveis:
 *   GRAPH_PROVIDER            (default: fuseki)
 *   GRAPH_QUERY_ENDPOINT      ex.: http://localhost:3030/oswadt-dev/query
 *   GRAPH_UPDATE_ENDPOINT     ex.: http://localhost:3030/oswadt-dev/update
 *   GRAPH_DATA_ENDPOINT       ex.: http://localhost:3030/oswadt-dev/data
 *   GRAPH_USERNAME            (opcional; par com GRAPH_PASSWORD)
 *   GRAPH_PASSWORD            (opcional; nunca aparece em logs/erros)
 *   GRAPH_REQUEST_TIMEOUT_MS  (default: 10000)
 *   GRAPH_BASE_URI            base das URIs/named graphs, ex.: http://oswadt.local/id
 */
import { GraphError } from "./graphTypes.ts";

export interface GraphConfig {
    provider: string;
    queryEndpoint: string;
    updateEndpoint: string;
    dataEndpoint: string;
    username: string | null;
    password: string | null;
    requestTimeoutMs: number;
    baseUri: string;
}

export type GraphConfigResult =
    | { configured: true; config: GraphConfig }
    | { configured: false; reason: string };

export const DEFAULT_GRAPH_PROVIDER = "fuseki";
export const DEFAULT_GRAPH_REQUEST_TIMEOUT_MS = 10_000;

const ENDPOINT_VARS = ["GRAPH_QUERY_ENDPOINT", "GRAPH_UPDATE_ENDPOINT", "GRAPH_DATA_ENDPOINT"] as const;
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function parseEndpoint(name: string, raw: string): URL {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new GraphError("graph_configuration_error", `${name} is not a valid absolute URL: '${raw}'`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new GraphError("graph_configuration_error", `${name} must use http or https (got '${url.protocol}')`);
    }
    return url;
}

/** Base URI: absoluta http(s), sem espaços, sem query/fragmento; sem '/' final. */
export function validateBaseUri(raw: string, sourceName = "GRAPH_BASE_URI"): string {
    if (typeof raw !== "string" || raw.trim() === "") {
        throw new GraphError("graph_configuration_error", `${sourceName} must be a non-empty string`);
    }
    if (/\s/.test(raw)) {
        throw new GraphError("graph_configuration_error", `${sourceName} must not contain whitespace`);
    }
    const url = parseEndpoint(sourceName, raw);
    if (url.search !== "" || url.hash !== "") {
        throw new GraphError("graph_configuration_error", `${sourceName} must not contain a query string or fragment`);
    }
    return raw.replace(/\/+$/, "");
}

/**
 * Lê e valida a configuração do ambiente.
 *
 * - Nenhuma variável GRAPH_* de endpoint/base definida → { configured: false }.
 * - Configuração parcial ou inválida → GraphError graph_configuration_error
 *   com mensagem clara (sem credenciais).
 * - NODE_ENV=test → endpoints obrigatoriamente locais (localhost/127.0.0.1):
 *   testes nunca podem apontar para um serviço de grafo remoto/produção.
 */
/**
 * Guarda de ESCRITA operacional (Prompt 5B, §17.3): antes de escrever dados
 * operacionais no grafo em produção, a configuração tem de ser explícita e
 * segura. Em NODE_ENV=production recusa: base URI de desenvolvimento
 * (*.local), ausência de credenciais e credenciais default de dev. Falha
 * ANTES de qualquer escrita.
 */
export function assertOperationalGraphWriteSafety(
    config: GraphConfig,
    env: NodeJS.ProcessEnv = process.env
): void {
    if (env.NODE_ENV !== "production") return;

    const host = new URL(config.baseUri).hostname;
    if (host.endsWith(".local") || host === "localhost" || host === "127.0.0.1") {
        throw new GraphError(
            "graph_configuration_error",
            `GRAPH_BASE_URI '${config.baseUri}' is a development base and cannot be used for operational writes in production — configure an approved production base URI`
        );
    }
    if (config.username === null || config.password === null) {
        throw new GraphError(
            "graph_configuration_error",
            "operational graph writes in production require GRAPH_USERNAME and GRAPH_PASSWORD"
        );
    }
    if (config.password === "oswadt-dev-graph") {
        throw new GraphError(
            "graph_configuration_error",
            "operational graph writes in production must not use the documented development credentials"
        );
    }
}

export function loadGraphConfig(env: NodeJS.ProcessEnv = process.env): GraphConfigResult {
    const relevant = [...ENDPOINT_VARS, "GRAPH_BASE_URI"] as const;
    const present = relevant.filter((name) => (env[name] ?? "").trim() !== "");

    if (present.length === 0) {
        return {
            configured: false,
            reason: "graph not configured (no GRAPH_* endpoint/base variables set) — graph operations are unavailable, the application keeps working without the graph",
        };
    }
    if (present.length < relevant.length) {
        const missing = relevant.filter((name) => !present.includes(name));
        throw new GraphError(
            "graph_configuration_error",
            `incomplete graph configuration: missing ${missing.join(", ")} (set all of ${relevant.join(", ")} or none)`
        );
    }

    const endpoints = {} as Record<(typeof ENDPOINT_VARS)[number], URL>;
    for (const name of ENDPOINT_VARS) {
        endpoints[name] = parseEndpoint(name, env[name]!.trim());
    }

    if (env.NODE_ENV === "test") {
        for (const name of ENDPOINT_VARS) {
            if (!LOCAL_HOSTNAMES.has(endpoints[name].hostname)) {
                throw new GraphError(
                    "graph_configuration_error",
                    `${name} must point to localhost when NODE_ENV=test (got host '${endpoints[name].hostname}') — tests must never target a remote graph service`
                );
            }
        }
    }

    const baseUri = validateBaseUri(env.GRAPH_BASE_URI!.trim());

    const rawTimeout = (env.GRAPH_REQUEST_TIMEOUT_MS ?? "").trim();
    let requestTimeoutMs = DEFAULT_GRAPH_REQUEST_TIMEOUT_MS;
    if (rawTimeout !== "") {
        requestTimeoutMs = Number(rawTimeout);
        if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0 || requestTimeoutMs > 600_000) {
            throw new GraphError(
                "graph_configuration_error",
                `GRAPH_REQUEST_TIMEOUT_MS must be a positive integer number of milliseconds (max 600000), got '${rawTimeout}'`
            );
        }
    }

    const username = (env.GRAPH_USERNAME ?? "").trim() || null;
    const password = (env.GRAPH_PASSWORD ?? "").trim() || null;
    if ((username === null) !== (password === null)) {
        throw new GraphError(
            "graph_configuration_error",
            "GRAPH_USERNAME and GRAPH_PASSWORD must be set together (or neither)"
        );
    }

    return {
        configured: true,
        config: {
            provider: (env.GRAPH_PROVIDER ?? "").trim() || DEFAULT_GRAPH_PROVIDER,
            queryEndpoint: endpoints.GRAPH_QUERY_ENDPOINT.toString(),
            updateEndpoint: endpoints.GRAPH_UPDATE_ENDPOINT.toString(),
            dataEndpoint: endpoints.GRAPH_DATA_ENDPOINT.toString(),
            username,
            password,
            requestTimeoutMs,
            baseUri,
        },
    };
}
