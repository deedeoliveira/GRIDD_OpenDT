/**
 * Identidade dos ativos não modelados (Prompt 5B §19.2) e escrita no grafo
 * (§19.4 parcial): UUID+URI gerados, sem localização/versão na URI, código e
 * serial opcionais, regra EQP- não aplicada, ObjectType/Manufacturer ausentes.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fakeConnection } from "../helpers/fakeDb.ts";
import { FakeOperationalGraph } from "../helpers/fakeOperationalGraph.ts";
import { installNonModelledEnv, freshState, registerCommand, fixedEvaluator, BASE, OPERATIONAL_GRAPH } from "../helpers/nonModelledTestSetup.ts";

installNonModelledEnv();

const graph = new FakeOperationalGraph();
const graphProvider = await import("../../graph/graphClientProvider.ts");
const policies = await import("../../policies/policyProvider.ts");
const registration = (await import("../../services/nonModelledAssetRegistrationService.ts")).default;

const UUID_RE = /^[0-9a-f-]{36}$/;

beforeEach(() => {
    graph.reset();
    fakeConnection.reset();
    fakeConnection.handler = freshState().handler;
    graphProvider.setGraphClient(graph as any);
    policies.resetPolicyProviders();
});

test("registo gera asset_uuid e URI derivada EXCLUSIVAMENTE do UUID", async () => {
    const result = await registration.register(registerCommand());
    assert.match(result.assetUuid, UUID_RE);
    assert.equal(result.assetUri, `${BASE}/asset/${result.assetUuid}`);
});

test("URI do ativo não contém espaço, versão, binding nem coordenada", async () => {
    const result = await registration.register(registerCommand({ initialSpaceId: 1 }));
    for (const forbidden of ["space", "version", "binding", "R-101", "coord"]) {
        assert.ok(!result.assetUri.includes(forbidden), `URI contém '${forbidden}': ${result.assetUri}`);
    }
});

test("código do gestor é OPCIONAL: sem managerCode a identidade existe na mesma", async () => {
    const result = await registration.register(registerCommand({ managerCode: null }));
    assert.match(result.assetUuid, UUID_RE);
    assert.equal(result.managerCode, null);
});

test("serial é OPCIONAL e fica separado; quando fornecido é preservado", async () => {
    const semSerial = await registration.register(registerCommand());
    assert.equal(semSerial.serialNumber, null);

    const comSerial = await registration.register(registerCommand({ serialNumber: "SN-999" }));
    assert.equal(comSerial.serialNumber, "SN-999");
    assert.notEqual(comSerial.assetUri.includes("SN-999"), true, "serial nunca entra na URI");
});

test("a regra EQP- NÃO se aplica: managerCode livre é aceite (não é IfcElement.Tag)", async () => {
    const result = await registration.register(registerCommand({ managerCode: "PORT-001" }));
    assert.equal(result.managerCode, "PORT-001");
});

test("ObjectType e Manufacturer não participam: nem no candidato de política nem nos triplos", async () => {
    let received: any = null;
    policies.setReservabilityEvaluator({
        evaluate: async (candidate: any) => { received = candidate; return (await fixedEvaluator("allow").evaluate()); },
    } as any);

    const result = await registration.register(registerCommand());
    assert.ok(received, "provider foi chamado");
    assert.equal("objectType" in received, false);
    assert.equal("manufacturer" in received, false);

    const triples = graph.triplesOf(result.assetUri);
    for (const t of triples) {
        assert.doesNotMatch(t.p, /objectType|manufacturer/i);
    }
});

test("o ativo é escrito no grafo OPERACIONAL com tipo, UUID e atribuição inicial verificáveis", async () => {
    const result = await registration.register(registerCommand({ initialSpaceId: 1 }));
    const triples = graph.triplesOf(result.assetUri);

    assert.ok(triples.every((t) => t.g === OPERATIONAL_GRAPH), "tudo no named graph operacional");
    assert.ok(triples.some((t) => t.p.endsWith("22-rdf-syntax-ns#type") && t.o.includes("NonModelledAsset")), "tipo NonModelledAsset presente");
    assert.equal(graph.literalOf(result.assetUri, "assetUuid"), result.assetUuid);

    const current = graph.currentAssignments(result.assetUri);
    assert.equal(current.length, 1);
    assert.equal(current[0]!.space, `${BASE}/space/11111111-1111-4111-8111-aaaaaaaaaaaa`);
});

test("sem espaço inicial: ativo registado semanticamente mas pending_location (sem localização inventada)", async () => {
    const result = await registration.register(registerCommand({ initialSpaceId: null }));
    assert.equal(result.locationStatus, "pending_location");
    assert.equal(result.currentLocation, null);
    assert.equal(graph.currentAssignments(result.assetUri).length, 0);
});

test("espaço inicial inválido/absent é rejeitado ANTES de escrever no grafo", async () => {
    await assert.rejects(registration.register(registerCommand({ initialSpaceId: 99 })), /does not exist/);
    await assert.rejects(registration.register(registerCommand({ initialSpaceId: 3 })), /'absent'/);
    assert.equal(graph.updateCalls.length, 0, "nenhuma escrita no grafo");
});
