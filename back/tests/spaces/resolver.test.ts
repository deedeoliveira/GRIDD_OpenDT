/**
 * Testes do SpaceIdentityResolver (Prompt 3) — leitura de
 * Pset_SpaceCommon.Reference, validação e normalização conservadora.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PsetReferenceSpaceIdentityResolver } from "../../identity/psetReferenceSpaceIdentityResolver.ts";

const resolver = new PsetReferenceSpaceIdentityResolver();
const ctx = { linkedModelId: 1, modelId: 1, modelVersionId: 1 };

function candidate(psets: any) {
    return { guid: "guid-1", name: "Sala", longName: "Sala Longa", psets };
}

test("nome do property set e da propriedade estão centralizados no resolver", () => {
    assert.equal(PsetReferenceSpaceIdentityResolver.PROPERTY_SET, "Pset_SpaceCommon");
    assert.equal(PsetReferenceSpaceIdentityResolver.PROPERTY, "Reference");
    assert.equal(PsetReferenceSpaceIdentityResolver.SOURCE, "Pset_SpaceCommon.Reference");
});

test("valor válido → valid, com raw e normalizado, origem e rastreabilidade", async () => {
    const r = await resolver.resolve(candidate({ Pset_SpaceCommon: { Reference: "R-101" } }), ctx);

    assert.equal(r.status, "valid");
    assert.equal(r.rawValue, "R-101");
    assert.equal(r.normalizedValue, "R-101");
    assert.equal(r.source, "Pset_SpaceCommon.Reference");
    assert.equal(r.resolverId, "pset-space-common-reference");
    assert.ok(!isNaN(Date.parse(r.resolvedAt)));
    assert.equal(r.guid, "guid-1");
});

test("pset ausente → missing (sem valor)", async () => {
    const r1 = await resolver.resolve(candidate(null), ctx);
    const r2 = await resolver.resolve(candidate({}), ctx);
    const r3 = await resolver.resolve(candidate({ Pset_SpaceCommon: {} }), ctx);

    for (const r of [r1, r2, r3]) {
        assert.equal(r.status, "missing");
        assert.equal(r.rawValue, null);
        assert.equal(r.normalizedValue, null);
        assert.ok(r.reasons.length > 0);
    }
});

test("valor vazio → invalid", async () => {
    const r = await resolver.resolve(candidate({ Pset_SpaceCommon: { Reference: "" } }), ctx);
    assert.equal(r.status, "invalid");
    assert.match(r.reasons[0]!, /empty or whitespace-only/);
});

test("apenas whitespace → invalid", async () => {
    const r = await resolver.resolve(candidate({ Pset_SpaceCommon: { Reference: "   " } }), ctx);
    assert.equal(r.status, "invalid");
});

test("tipo inesperado (número, booleano, objeto) → invalid com razão", async () => {
    for (const value of [101, true, { a: 1 }]) {
        const r = await resolver.resolve(candidate({ Pset_SpaceCommon: { Reference: value } }), ctx);
        assert.equal(r.status, "invalid");
        assert.match(r.reasons[0]!, /unexpected type/);
    }
});

test("normalização conservadora: só trim — caixa, zeros iniciais e interior preservados", async () => {
    const r = await resolver.resolve(candidate({ Pset_SpaceCommon: { Reference: "  r-007 A  " } }), ctx);

    assert.equal(r.status, "valid");
    assert.equal(r.rawValue, "  r-007 A  ", "valor original preservado");
    assert.equal(r.normalizedValue, "r-007 A", "apenas whitespace exterior removido");

    // caixa NÃO é alterada: R-101 e r-101 são códigos distintos
    const upper = await resolver.resolve(candidate({ Pset_SpaceCommon: { Reference: "R-101" } }), ctx);
    const lower = await resolver.resolve(candidate({ Pset_SpaceCommon: { Reference: "r-101" } }), ctx);
    assert.notEqual(upper.normalizedValue, lower.normalizedValue);

    // zeros iniciais NÃO são removidos
    const zeros = await resolver.resolve(candidate({ Pset_SpaceCommon: { Reference: "007" } }), ctx);
    assert.equal(zeros.normalizedValue, "007");
});
