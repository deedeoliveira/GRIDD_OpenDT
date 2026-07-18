/**
 * Convenção de named graphs (Prompt 5A): unicidade dos grafos de teste,
 * identidade da versão no grafo de versão, estados que não recebem grafo e
 * guardas de remoção.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const graphs = await import("../../graph/namedGraphs.ts");
const { GraphError } = await import("../../graph/graphTypes.ts");

const BASE = "http://oswadt.local/id";

test("grafo de teste é único por execução (dois pedidos → URIs diferentes no namespace de teste)", () => {
    const first = graphs.newTestGraphUri(BASE);
    const second = graphs.newTestGraphUri(BASE);
    assert.notEqual(first, second);
    assert.ok(graphs.isTestGraphUri(first));
    assert.ok(graphs.isTestGraphUri(second));
    assert.match(first, /^http:\/\/oswadt\.local\/id\/graph\/test\/[0-9a-f-]{36}$/);
});

test("dois testes não partilham dados: apagar um grafo não afeta o outro (fake em memória)", async () => {
    // fake mínimo do armazenamento por named graph — simula o comportamento GSP
    const store = new Map<string, string>();
    const graphA = graphs.testGraphUri(BASE, "11111111-1111-4111-8111-111111111111");
    const graphB = graphs.testGraphUri(BASE, "22222222-2222-4222-8222-222222222222");

    store.set(graphA, "<urn:a> <urn:p> \"a\" .");
    store.set(graphB, "<urn:b> <urn:p> \"b\" .");

    graphs.assertGraphDeletable(graphA, { NODE_ENV: "test" });
    store.delete(graphA);

    assert.equal(store.has(graphA), false);
    assert.equal(store.get(graphB), "<urn:b> <urn:p> \"b\" .", "o grafo do outro teste permanece intacto");
});

test("grafo de versão inclui a identidade da model version (nunca só o model_id)", () => {
    const uri = graphs.modelVersionGraphUri(BASE, "mv-2026-07-17-abc");
    assert.equal(uri, `${BASE}/graph/model-version/mv-2026-07-17-abc`);
    assert.throws(() => graphs.modelVersionGraphUri(BASE, ""), GraphError);
});

test("versões failed e processing não recebem grafo de produção; active e archived sim", () => {
    assert.equal(graphs.canMaterializeModelVersionGraph("failed"), false);
    assert.equal(graphs.canMaterializeModelVersionGraph("processing"), false);
    assert.equal(graphs.canMaterializeModelVersionGraph("active"), true);
    assert.equal(graphs.canMaterializeModelVersionGraph("archived"), true);
});

test("convenções reservadas: operational, vocabularies e validation derivam da base configurada", () => {
    assert.equal(graphs.operationalGraphUri(BASE), `${BASE}/graph/operational`);
    assert.equal(graphs.vocabulariesGraphUri(BASE), `${BASE}/graph/vocabularies`);
    assert.equal(graphs.validationGraphUri(BASE), `${BASE}/graph/validation`);
});

test("CLEAR ALL e DROP ALL são proibidos pela guarda central; updates dirigidos passam", () => {
    for (const forbidden of ["CLEAR ALL", "DROP ALL", "DROP SILENT ALL", "CLEAR NAMED", "DROP DEFAULT"]) {
        assert.throws(() => graphs.assertSparqlUpdateAllowed(forbidden), GraphError, forbidden);
    }
    graphs.assertSparqlUpdateAllowed(`INSERT DATA { GRAPH <${BASE}/graph/test/x> { <urn:s> <urn:p> "o" } }`);
    graphs.assertSparqlUpdateAllowed(`CLEAR GRAPH <${BASE}/graph/test/x>`);
});

test("em NODE_ENV=test só grafos do namespace de teste podem ser apagados", () => {
    const testEnv = { NODE_ENV: "test" } as NodeJS.ProcessEnv;
    graphs.assertGraphDeletable(graphs.testGraphUri(BASE, "run-ok"), testEnv);

    for (const protectedGraph of [
        graphs.operationalGraphUri(BASE),
        graphs.vocabulariesGraphUri(BASE),
        graphs.modelVersionGraphUri(BASE, "mv-1"),
    ]) {
        assert.throws(
            () => graphs.assertGraphDeletable(protectedGraph, testEnv),
            (error: any) => error instanceof GraphError && /test namespace/.test(error.message),
            protectedGraph
        );
    }

    // fora de testes, a remoção de grafos não-teste é permitida (fluxos futuros do 5B)
    graphs.assertGraphDeletable(graphs.modelVersionGraphUri(BASE, "mv-1"), { NODE_ENV: "development" } as NodeJS.ProcessEnv);
});

test("URIs de grafo exigem base válida e a remoção exige URI absoluta", () => {
    assert.throws(() => graphs.testGraphUri("nao-e-uri", "x"), GraphError);
    assert.throws(() => graphs.assertGraphDeletable("relativo/sem/esquema", {} as NodeJS.ProcessEnv), GraphError);
    assert.throws(() => graphs.assertGraphDeletable("", {} as NodeJS.ProcessEnv), GraphError);
});
