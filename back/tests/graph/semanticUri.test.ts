/**
 * Estratégia de URIs (Prompt 5A): identidade persistente, determinismo,
 * codificação segura e — sobretudo — NENHUMA localização/versão na URI de
 * um ativo persistente.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { createSemanticUriFactory, semanticUriFactoryFromEnv } = await import("../../graph/semanticUriFactory.ts");
const { GraphError } = await import("../../graph/graphTypes.ts");

const BASE = "http://oswadt.local/id";
const SPACE_UUID = "3f8a2c1e-9b4d-4e6f-8a1b-2c3d4e5f6a7b";
const ASSET_UUID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";

const factory = createSemanticUriFactory(BASE);

test("URI de espaço usa a identidade persistente (space_uuid)", () => {
    assert.equal(factory.spaceUri(SPACE_UUID), `${BASE}/space/${SPACE_UUID}`);
});

test("URI de ativo usa a identidade persistente (asset_uuid) e nada mais", () => {
    assert.equal(factory.assetUri(ASSET_UUID), `${BASE}/asset/${ASSET_UUID}`);
});

test("URI de ativo NÃO contém localização nem versão de modelo (mudança de espaço preserva a URI)", () => {
    const uri = factory.assetUri(ASSET_UUID);
    // a URI é EXATAMENTE base + /asset/ + uuid — sem espaço, binding, versão ou coordenada
    assert.equal(uri, `${BASE}/asset/${ASSET_UUID}`);
    for (const fragment of ["space", "binding", "version", "coord", SPACE_UUID]) {
        assert.ok(!uri.includes(fragment), `URI de ativo não pode conter '${fragment}'`);
    }
    // e não existe forma de lhe passar localização: a assinatura só aceita o asset_uuid
    assert.equal(factory.assetUri.length, 1);
});

test("URI de entity contém o contexto da versão (entity é snapshot de UMA model_version)", () => {
    const uri = factory.entityUri("mv-abc", "2O2Fr$t4X7Zf8NOew3FLOH");
    assert.match(uri, /\/entity\/mv-abc\//);
});

test("URIs são determinísticas (mesma entrada → mesma URI, chamadas independentes)", () => {
    const again = createSemanticUriFactory(`${BASE}/`);
    assert.equal(factory.assetUri(ASSET_UUID), again.assetUri(ASSET_UUID));
    assert.equal(factory.spaceUri(SPACE_UUID), again.spaceUri(SPACE_UUID));
    assert.equal(factory.entityUri("mv-abc", "tok"), again.entityUri("mv-abc", "tok"));
});

test("caracteres perigosos são codificados de forma segura", () => {
    const uri = factory.entityUri("mv-abc", "tok en/estranho#1?");
    assert.ok(!/[ #?]/.test(uri.slice(BASE.length)), "sem espaços, '#' ou '?' por codificar");
    assert.doesNotThrow(() => new URL(uri));
});

test("um id SQL auto-increment isolado NÃO é aceite como identidade global", () => {
    for (const call of [
        () => factory.modelUri("42"),
        () => factory.modelVersionUri("7"),
        () => factory.linkedModelUri("1"),
        () => factory.entityUri("9", "token"),
    ]) {
        assert.throws(call, (error: any) => error instanceof GraphError && /numeric SQL id/.test(error.message));
    }
});

test("space/asset exigem UUID verdadeiro (números ou strings soltas são rejeitados)", () => {
    for (const bad of ["42", "abc", "", "EQP-000123", "SN-111"]) {
        assert.throws(() => factory.assetUri(bad), GraphError, `assetUri aceitou '${bad}'`);
        assert.throws(() => factory.spaceUri(bad), GraphError, `spaceUri aceitou '${bad}'`);
    }
});

test("base URI inválida é rejeitada; GRAPH_BASE_URI ausente → graph_not_configured", () => {
    assert.throws(() => createSemanticUriFactory("ftp://x"), GraphError);
    assert.throws(() => createSemanticUriFactory("http://x/base?q=1"), GraphError);
    assert.throws(
        () => semanticUriFactoryFromEnv({} as NodeJS.ProcessEnv),
        (error: any) => error instanceof GraphError && error.code === "graph_not_configured"
    );
});
