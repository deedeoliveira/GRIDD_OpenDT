/**
 * Cliente SPARQL HTTP (Prompt 5A): operações, mapeamento de erros, timeout,
 * cancelamento, guardas destrutivas e ausência de credenciais nos logs.
 * O fetch é injetado — NENHUM serviço real é contactado.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { SparqlHttpGraphClient } = await import("../../graph/sparqlHttpGraphClient.ts");
const { GraphError } = await import("../../graph/graphTypes.ts");
const { testGraphUri } = await import("../../graph/namedGraphs.ts");
import type { GraphConfig } from "../../graph/graphConfig.ts";

const PASSWORD = "credencial-de-teste-nunca-logada";
const BASE = "http://oswadt.local/id";

function makeConfig(overrides: Partial<GraphConfig> = {}): GraphConfig {
    return {
        provider: "fuseki",
        queryEndpoint: "http://localhost:3030/oswadt-test/query",
        updateEndpoint: "http://localhost:3030/oswadt-test/update",
        dataEndpoint: "http://localhost:3030/oswadt-test/data",
        username: "admin",
        password: PASSWORD,
        requestTimeoutMs: 5000,
        baseUri: BASE,
        ...overrides,
    };
}

interface RecordedCall {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | undefined;
}

function recordingFetch(respond: (call: RecordedCall) => Response | Promise<Response>) {
    const calls: RecordedCall[] = [];
    const fetchImpl = (async (url: any, init: any = {}) => {
        const call: RecordedCall = {
            url: String(url),
            method: init.method ?? "GET",
            headers: { ...(init.headers ?? {}) },
            body: init.body === undefined ? undefined : String(init.body),
        };
        calls.push(call);
        return respond(call);
    }) as typeof fetch;
    return { calls, fetchImpl };
}

function sparqlJson(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status });
}

async function captureLogs<T>(run: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
    const original = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    try {
        return { result: await run(), logs };
    } finally {
        console.log = original;
    }
}

/* ------------------ health ------------------ */

test("health bem-sucedido: ASK{} devolve boolean e o resultado tem ok=true", async () => {
    const { calls, fetchImpl } = recordingFetch(() => sparqlJson({ head: {}, boolean: true }));
    const client = new SparqlHttpGraphClient(makeConfig(), fetchImpl);

    const health = await client.healthCheck();
    assert.equal(health.ok, true);
    assert.equal(health.errorCode, null);
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.body ?? "", /query=ASK/);
});

test("serviço indisponível: fetch falha → health ok=false com graph_unavailable (sem lançar)", async () => {
    const fetchImpl = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    const client = new SparqlHttpGraphClient(makeConfig(), fetchImpl);

    const health = await client.healthCheck();
    assert.equal(health.ok, false);
    assert.equal(health.errorCode, "graph_unavailable");
});

test("timeout: pedido abortado por GRAPH_REQUEST_TIMEOUT_MS → graph_timeout", async () => {
    const fetchImpl = ((_url: any, init: any) => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () =>
            reject(new DOMException("This operation was aborted", "AbortError")));
    })) as typeof fetch;
    const client = new SparqlHttpGraphClient(makeConfig({ requestTimeoutMs: 30 }), fetchImpl);

    await assert.rejects(
        client.query("SELECT * WHERE { ?s ?p ?o } LIMIT 1"),
        (error: any) => error instanceof GraphError && error.code === "graph_timeout"
    );
});

test("cancelamento externo via AbortSignal é propagado tal e qual (não é timeout)", async () => {
    const fetchImpl = ((_url: any, init: any) => new Promise((_resolve, reject) => {
        if (init.signal.aborted) reject(init.signal.reason);
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
    })) as typeof fetch;
    const client = new SparqlHttpGraphClient(makeConfig(), fetchImpl);

    const controller = new AbortController();
    const cancelReason = new Error("cancelado pelo chamador");
    controller.abort(cancelReason);

    await assert.rejects(
        client.query("ASK {}", { signal: controller.signal }),
        (error: any) => error === cancelReason
    );
});

test("erro de autenticação: HTTP 401 → graph_authentication_failed", async () => {
    const { fetchImpl } = recordingFetch(() => new Response("unauthorized", { status: 401 }));
    const client = new SparqlHttpGraphClient(makeConfig(), fetchImpl);

    await assert.rejects(
        client.query("ASK {}"),
        (error: any) => error instanceof GraphError
            && error.code === "graph_authentication_failed"
            && error.httpStatus === 401
    );
});

test("resposta inválida: 200 sem JSON ou com forma inesperada → graph_invalid_response", async () => {
    const notJson = new SparqlHttpGraphClient(makeConfig(),
        recordingFetch(() => new Response("<html>not sparql</html>", { status: 200 })).fetchImpl);
    await assert.rejects(
        notJson.query("ASK {}"),
        (error: any) => error instanceof GraphError && error.code === "graph_invalid_response"
    );

    const wrongShape = new SparqlHttpGraphClient(makeConfig(),
        recordingFetch(() => sparqlJson({ foo: "bar" })).fetchImpl);
    await assert.rejects(
        wrongShape.query("ASK {}"),
        (error: any) => error instanceof GraphError && error.code === "graph_invalid_response"
    );
});

/* ------------------ query / update ------------------ */

test("query SELECT: POST ao endpoint de query com Accept sparql-results+json e bindings devolvidos", async () => {
    const { calls, fetchImpl } = recordingFetch(() => sparqlJson({
        head: { vars: ["n"] },
        results: { bindings: [{ n: { type: "literal", value: "2" } }] },
    }));
    const client = new SparqlHttpGraphClient(makeConfig(), fetchImpl);

    const result = await client.query("SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }");
    assert.equal(result.results?.bindings[0]!.n!.value, "2");
    assert.equal(calls[0]!.url, "http://localhost:3030/oswadt-test/query");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers.Accept, "application/sparql-results+json");
    assert.ok(calls[0]!.headers.Authorization?.startsWith("Basic "), "autenticação básica enviada");
});

test("erro de query: HTTP 500 → graph_query_failed com status", async () => {
    const { fetchImpl } = recordingFetch(() => new Response("boom", { status: 500 }));
    const client = new SparqlHttpGraphClient(makeConfig(), fetchImpl);

    await assert.rejects(
        client.query("ASK {}"),
        (error: any) => error instanceof GraphError && error.code === "graph_query_failed" && error.httpStatus === 500
    );
});

test("update: POST ao endpoint de update com corpo urlencoded", async () => {
    const { calls, fetchImpl } = recordingFetch(() => new Response(null, { status: 204 }));
    const client = new SparqlHttpGraphClient(makeConfig(), fetchImpl);

    await client.update(`INSERT DATA { GRAPH <${testGraphUri(BASE, "run-1")}> { <urn:s> <urn:p> "o" } }`);
    assert.equal(calls[0]!.url, "http://localhost:3030/oswadt-test/update");
    assert.match(calls[0]!.body ?? "", /^update=INSERT/);
});

test("erro de update: HTTP 400 → graph_update_failed", async () => {
    const { fetchImpl } = recordingFetch(() => new Response("parse error", { status: 400 }));
    const client = new SparqlHttpGraphClient(makeConfig(), fetchImpl);

    await assert.rejects(
        client.update("INSERT DATA { <urn:s> <urn:p> 'o' }"),
        (error: any) => error instanceof GraphError && error.code === "graph_update_failed" && error.httpStatus === 400
    );
});

/* ------------------ graph store protocol ------------------ */

test("putGraph: PUT no endpoint de dados com ?graph=<uri> e Content-Type RDF", async () => {
    const { calls, fetchImpl } = recordingFetch(() => new Response(null, { status: 201 }));
    const client = new SparqlHttpGraphClient(makeConfig(), fetchImpl);
    const graphUri = testGraphUri(BASE, "run-put");

    await client.putGraph(graphUri, "<urn:s> <urn:p> \"o\" .", "text/turtle");
    const url = new URL(calls[0]!.url);
    assert.equal(`${url.origin}${url.pathname}`, "http://localhost:3030/oswadt-test/data");
    assert.equal(url.searchParams.get("graph"), graphUri);
    assert.equal(calls[0]!.method, "PUT");
    assert.equal(calls[0]!.headers["Content-Type"], "text/turtle");
});

test("deleteGraph: DELETE apenas do grafo indicado; 404 é idempotente (não é erro)", async () => {
    const { calls, fetchImpl } = recordingFetch((call) =>
        new Response(null, { status: calls.length === 1 ? 204 : 404 }));
    const client = new SparqlHttpGraphClient(makeConfig(), fetchImpl);
    const graphUri = testGraphUri(BASE, "run-del");

    await client.deleteGraph(graphUri);
    await client.deleteGraph(graphUri);
    assert.equal(calls.length, 2);
    for (const call of calls) {
        assert.equal(call.method, "DELETE");
        assert.equal(new URL(call.url).searchParams.get("graph"), graphUri);
    }
});

/* ------------------ guardas destrutivas ------------------ */

test("CLEAR ALL e DROP ALL (e variantes NAMED/DEFAULT) são recusados SEM contactar o serviço", async () => {
    const { calls, fetchImpl } = recordingFetch(() => new Response(null, { status: 204 }));
    const client = new SparqlHttpGraphClient(makeConfig(), fetchImpl);

    for (const forbidden of ["CLEAR ALL", "clear silent all", "DROP ALL", "DROP NAMED", "CLEAR DEFAULT", "  drop\n default"]) {
        await assert.rejects(
            client.update(forbidden),
            (error: any) => error instanceof GraphError && /forbidden/.test(error.message),
            `update destrutivo aceite indevidamente: '${forbidden}'`
        );
    }
    assert.equal(calls.length, 0, "nenhum pedido pode ter chegado ao fetch");

    // operações dirigidas a um grafo específico continuam permitidas
    await client.update(`CLEAR GRAPH <${testGraphUri(BASE, "run-clear")}>`);
    assert.equal(calls.length, 1);
});

test("nenhum retry implícito: uma falha resulta em exatamente um pedido", async () => {
    let attempts = 0;
    const fetchImpl = (async () => { attempts += 1; throw new TypeError("fetch failed"); }) as typeof fetch;
    const client = new SparqlHttpGraphClient(makeConfig(), fetchImpl);

    await assert.rejects(client.query("ASK {}"));
    assert.equal(attempts, 1);
});

/* ------------------ credenciais ------------------ */

test("logs estruturados e mensagens de erro nunca contêm password nem header Authorization", async () => {
    const { fetchImpl } = recordingFetch(() => new Response("denied", { status: 401 }));
    const client = new SparqlHttpGraphClient(makeConfig(), fetchImpl);

    const { logs } = await captureLogs(async () => {
        try { await client.query("ASK {}"); } catch (error: any) {
            assert.ok(!String(error.message).includes(PASSWORD));
        }
        const okFetch = recordingFetch(() => sparqlJson({ head: {}, boolean: true })).fetchImpl;
        await new SparqlHttpGraphClient(makeConfig(), okFetch).healthCheck();
    });

    const joined = logs.join("\n");
    assert.ok(joined.includes("graph_operation"), "operações produzem logs estruturados");
    assert.ok(!joined.includes(PASSWORD), "password nunca aparece nos logs");
    assert.ok(!joined.includes("Authorization"), "header de autenticação nunca aparece nos logs");
    assert.ok(!joined.includes("Basic "), "credenciais codificadas nunca aparecem nos logs");
});
