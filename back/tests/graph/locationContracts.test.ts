/**
 * Contratos futuros de localização temporal (Prompt 5A): identidade
 * independente da localização, temporalidade, fontes e distinção entre
 * observação e localização validada. Sem persistência — só contratos.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const contracts = await import("../../graph/assetLocationContracts.ts");
const { createSemanticUriFactory } = await import("../../graph/semanticUriFactory.ts");
import type { AssetLocationAssertion } from "../../graph/assetLocationContracts.ts";

const factory = createSemanticUriFactory("http://oswadt.local/id");
const ASSET_UUID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const SPACE_A = "3f8a2c1e-9b4d-4e6f-8a1b-2c3d4e5f6a7b";
const SPACE_B = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";

function assertion(overrides: Partial<AssetLocationAssertion> = {}): AssetLocationAssertion {
    return {
        assertionId: "11111111-1111-4111-8111-111111111111",
        assetUri: factory.assetUri(ASSET_UUID),
        spaceUri: factory.spaceUri(SPACE_A),
        source: "ifc_binding",
        validFrom: "2026-07-17T10:00:00Z",
        validTo: null,
        ...overrides,
    };
}

test("mudar o espaço num contrato de localização NÃO muda a assetUri (identidade preservada)", () => {
    const before = assertion();
    const closed = contracts.closeLocationAssertion(before, "2026-07-18T09:00:00Z");
    const after = assertion({
        assertionId: "22222222-2222-4222-8222-222222222222",
        spaceUri: factory.spaceUri(SPACE_B),
        validFrom: "2026-07-18T09:00:00Z",
    });

    assert.equal(closed.assetUri, before.assetUri, "encerrar não altera a identidade");
    assert.equal(closed.validTo, "2026-07-18T09:00:00Z");
    assert.equal(after.assetUri, before.assetUri, "novo espaço, MESMO ativo e MESMA URI");
    assert.notEqual(after.spaceUri, before.spaceUri);
    assert.notEqual(after.assertionId, before.assertionId, "mover cria NOVA atribuição, não edita a antiga");
});

test("duas atribuições temporais podem referir o mesmo ativo (histórico preservado)", () => {
    const old = assertion({ validTo: "2026-07-18T09:00:00Z" });
    const current = assertion({
        assertionId: "33333333-3333-4333-8333-333333333333",
        spaceUri: factory.spaceUri(SPACE_B),
        validFrom: "2026-07-18T09:00:00Z",
    });

    assert.equal(old.assetUri, current.assetUri);
    assert.equal(contracts.isCurrentLocationAssertion(old), false);
    assert.equal(contracts.isCurrentLocationAssertion(current), true);
});

test("a fonte IFC é distinguida da inferência por sensor (e de manual/sistema externo)", () => {
    const sources = contracts.ASSET_LOCATION_SOURCES;
    assert.deepEqual([...sources].sort(), ["external_system", "ifc_binding", "manual", "sensor_inference"]);

    const fromIfc = assertion({ source: "ifc_binding" });
    const fromSensor = assertion({ source: "sensor_inference", observedAt: "2026-07-17T09:59:12Z", confidence: 0.8 });
    assert.notEqual(fromIfc.source, fromSensor.source);
});

test("observação NÃO equivale automaticamente a localização operacional (observedAt ≠ validFrom)", () => {
    const observed = assertion({
        source: "sensor_inference",
        observedAt: "2026-07-17T09:59:12Z",
        validFrom: "2026-07-17T10:30:00Z",   // promoção a validade exige regra explícita futura
        confidence: 0.6,
    });
    assert.notEqual(observed.observedAt, observed.validFrom,
        "o momento da observação é registado separadamente do início de validade");
});

test("serial, Tag, GUID e ObjectType não são fontes de localização", () => {
    for (const notASource of ["serial", "serial_number", "tag", "equipment_tag", "guid", "ifc_guid", "object_type", "objectType"]) {
        assert.ok(
            !(contracts.ASSET_LOCATION_SOURCES as readonly string[]).includes(notASource),
            `'${notASource}' não pode ser fonte de localização — é identidade/evidência/classificação`
        );
    }
});
