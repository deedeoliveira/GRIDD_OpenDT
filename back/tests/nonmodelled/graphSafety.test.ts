/**
 * Segurança da escrita no grafo (Prompt 5B §19.4/§17.2): escrita dirigida
 * (não substitui outros ativos), escaping de literais, IRIs validadas,
 * SPARQL injection neutralizada, delete amplo do grafo operacional proibido.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fakeConnection } from "../helpers/fakeDb.ts";
import { FakeOperationalGraph } from "../helpers/fakeOperationalGraph.ts";
import { installNonModelledEnv, freshState, registerCommand, OPERATIONAL_GRAPH } from "../helpers/nonModelledTestSetup.ts";

installNonModelledEnv();

const graph = new FakeOperationalGraph();
const graphProvider = await import("../../graph/graphClientProvider.ts");
const policies = await import("../../policies/policyProvider.ts");
const registration = (await import("../../services/nonModelledAssetRegistrationService.ts")).default;
const { assertGraphDeletable } = await import("../../graph/namedGraphs.ts");
const { GraphError } = await import("../../graph/graphTypes.ts");

beforeEach(() => {
    graph.reset();
    fakeConnection.reset();
    fakeConnection.handler = freshState().handler;
    graphProvider.setGraphClient(graph as any);
    policies.resetPolicyProviders();
});

test("a escrita é dirigida: registar um segundo ativo NÃO substitui nem toca no primeiro", async () => {
    const first = await registration.register(registerCommand());
    const firstTriples = JSON.stringify(graph.triplesOf(first.assetUri));

    const second = await registration.register(registerCommand({ name: "Outro equipamento" }));
    assert.notEqual(second.assetUri, first.assetUri);
    assert.equal(JSON.stringify(graph.triplesOf(first.assetUri)), firstTriples, "primeiro ativo intacto");
});

test("nunca é usado putGraph para o grafo operacional (só INSERT DATA dirigido)", async () => {
    await registration.register(registerCommand());
    assert.ok(graph.updateCalls.every((u) => u.startsWith("INSERT DATA")), "apenas INSERT DATA");
});

test("literais com aspas, quebras de linha e sintaxe SPARQL são escapados — injection vira texto", async () => {
    const malicious = `Nome"} } ; DROP ALL ; INSERT DATA { GRAPH <${OPERATIONAL_GRAPH}> { <urn:pwned> <urn:p> "x"`;
    const result = await registration.register(registerCommand({ name: malicious }));

    // o nome malicioso ficou como LITERAL do próprio ativo…
    assert.equal(graph.literalOf(result.assetUri, "displayName"), malicious);
    // …e NENHUM recurso injetado existe
    assert.equal(graph.triplesOf("urn:pwned").length, 0);
    assert.ok(graph.updateCalls.every((u) => !/DROP ALL\s*;/.test(u) || u.includes('\\"')), "DROP ALL só aparece escapado dentro de literal");
});

test("IRIs inválidas são rejeitadas na construção (nunca chegam ao serviço de grafo)", async () => {
    const { iri } = await import("../../graph/sparqlText.ts");
    for (const bad of ["relativo/x", "http://x/<>", "http://x/ espaco", ""]) {
        assert.throws(() => iri(bad), GraphError, `IRI aceite indevidamente: '${bad}'`);
    }
});

test("delete amplo do grafo operacional é proibido em QUALQUER ambiente", () => {
    assert.throws(
        () => assertGraphDeletable(OPERATIONAL_GRAPH, { NODE_ENV: "development" } as NodeJS.ProcessEnv),
        /never be deleted wholesale/
    );
    assert.throws(
        () => assertGraphDeletable(OPERATIONAL_GRAPH, {} as NodeJS.ProcessEnv),
        /never be deleted wholesale/
    );
});

test("CLEAR/DROP NAMED e ALL continuam proibidos pela guarda central", async () => {
    const { assertSparqlUpdateAllowed } = await import("../../graph/namedGraphs.ts");
    for (const forbidden of ["CLEAR ALL", "DROP ALL", "CLEAR NAMED", "DROP NAMED"]) {
        assert.throws(() => assertSparqlUpdateAllowed(forbidden), GraphError, forbidden);
    }
});

test("guarda de produção: base .local e credenciais default são recusadas em NODE_ENV=production", async () => {
    const { assertOperationalGraphWriteSafety } = await import("../../graph/graphConfig.ts");
    const config = {
        provider: "fuseki",
        queryEndpoint: "https://graph.example.org/ds/query",
        updateEndpoint: "https://graph.example.org/ds/update",
        dataEndpoint: "https://graph.example.org/ds/data",
        username: "admin", password: "prod-secret", requestTimeoutMs: 10000,
        baseUri: "https://data.example.org/id",
    };

    // fora de produção: nada é exigido
    assertOperationalGraphWriteSafety({ ...config, baseUri: "http://oswadt.local/id" }, { NODE_ENV: "development" } as any);

    const prod = { NODE_ENV: "production" } as NodeJS.ProcessEnv;
    assert.throws(() => assertOperationalGraphWriteSafety({ ...config, baseUri: "http://oswadt.local/id" }, prod), /development base/);
    assert.throws(() => assertOperationalGraphWriteSafety({ ...config, username: null, password: null }, prod), /require GRAPH_USERNAME/);
    assert.throws(() => assertOperationalGraphWriteSafety({ ...config, password: "oswadt-dev-graph" }, prod), /development credentials/);
    assertOperationalGraphWriteSafety(config, prod);
});
