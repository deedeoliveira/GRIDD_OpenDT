/**
 * Resolver de identidade dos equipamentos modelados (revisão do Prompt 4):
 * IfcElement.Tag (EQP-) como código institucional, serial como evidência
 * secundária SEPARADA, GUID apenas legado (backfill) — e registry do provider.
 *
 * Reference (Pset_*Common), ObjectType e Manufacturer NUNCA participam da
 * identidade; conflitos Tag/serial criam casos de reconciliação, sem merge.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { installFakeMySQL } from "../helpers/fakeDb.ts";

installFakeMySQL();

const { IfcTagSerialAssetIdentityResolver } = await import("../../identity/ifcTagSerialAssetIdentityResolver.ts");
const provider = await import("../../identity/assetIdentityProvider.ts");
import type { AssetIdentityLookup } from "../../identity/assetIdentityTypes.ts";

/** Lookup falso configurável por teste (sem BD). */
function makeLookup(overrides: Partial<AssetIdentityLookup> = {}): AssetIdentityLookup {
    return {
        findEquipmentByTag: async () => [],
        findEquipmentBySerial: async () => [],
        ...overrides,
    };
}

const CONTEXT = { linkedModelId: 10, modelId: 20, modelVersionId: 9 };
const CANDIDATE = {
    guid: "guid-1", name: "Betoneira 01", ifcType: "IfcBuildingElementProxy",
    tag: "EQP-000123", objectType: "Betoneira Diesel", psets: null, entityId: 101, spaceId: 7,
};

beforeEach(() => {
    provider.resetAssetIdentityResolver();
    delete process.env.ASSET_IDENTITY_PROVIDER;
});

/* -------------------------------------
   TAG: única fonte do código institucional
------------------------------------- */

test("asset_code vem EXCLUSIVAMENTE da Tag: stableCode = Tag aparada; serial vai para campo separado", async () => {
    const resolver = new IfcTagSerialAssetIdentityResolver(makeLookup());

    const result = await resolver.resolve({
        ...CANDIDATE, tag: "  EQP-000123  ",
        psets: { Pset_ManufacturerOccurrence: { SerialNumber: "SN-9" } },
    }, CONTEXT);

    assert.equal(result.status, "new");
    assert.equal(result.stableCode, "EQP-000123", "Tag aparada → asset_code");
    assert.equal(result.serialNumber, "SN-9", "serial em campo separado — nunca em asset_code");
    assert.notEqual(result.stableCode, result.serialNumber);
});

test("Reference em Pset_*Common NÃO é usado para identidade de equipamento (estratégia substituída)", async () => {
    let tagLookups = 0;
    const resolver = new IfcTagSerialAssetIdentityResolver(makeLookup({
        findEquipmentByTag: async (_lm: number, tag: string) => {
            tagLookups++;
            assert.equal(tag, "EQP-000123", "só a Tag é consultada");
            return [];
        },
    }));

    const result = await resolver.resolve({
        ...CANDIDATE,
        psets: { Pset_DistributionElementCommon: { Reference: "REF-IGNORADA" } },
    }, CONTEXT);

    assert.equal(tagLookups, 1);
    assert.equal(result.stableCode, "EQP-000123");
    assert.notEqual(result.stableCode, "REF-IGNORADA");
    assert.ok(!result.reasons.some((r) => r.includes("REF-IGNORADA")), "Reference não participa da decisão");
});

test("serial NÃO substitui Tag ausente: candidato sem Tag → unresolved (nunca identidade por serial)", async () => {
    const resolver = new IfcTagSerialAssetIdentityResolver(makeLookup({
        findEquipmentBySerial: async () => [{ id: 5, asset_code: "EQP-5", serial_number: "SN-9" }],
    }));

    const result = await resolver.resolve({
        ...CANDIDATE, tag: null,
        psets: { Pset_ManufacturerOccurrence: { SerialNumber: "SN-9" } },
    }, CONTEXT);

    assert.equal(result.status, "unresolved");
    assert.equal(result.matchedAssetId, null);
    assert.ok(result.reasons.some((r) => /preflight/.test(r)),
        "novos uploads sem Tag devem falhar no preflight — sem fallback");
});

test("GUID novo sem Tag não contorna o preflight: o resolver nunca consulta GUID em novos uploads", async () => {
    // O contrato de lookup nem sequer expõe pesquisa por GUID: a única
    // compatibilidade GUID é o backfill (legacy_ifc_guid).
    const lookup = makeLookup();
    assert.ok(!("findEquipmentByGuidInLineage" in lookup));

    const resolver = new IfcTagSerialAssetIdentityResolver(lookup);
    const result = await resolver.resolve({ ...CANDIDATE, tag: null, psets: {} }, CONTEXT);
    assert.equal(result.status, "unresolved");
});

/* -------------------------------------
   REGRAS TAG + SERIAL (sem merge automático)
------------------------------------- */

test("mesma Tag + mesmo serial → matched forte (tag_and_serial)", async () => {
    const resolver = new IfcTagSerialAssetIdentityResolver(makeLookup({
        findEquipmentByTag: async () => [{ id: 77, asset_code: "EQP-000123", serial_number: "SN-9" }],
    }));

    const result = await resolver.resolve({
        ...CANDIDATE, psets: { Pset_ManufacturerOccurrence: { SerialNumber: "SN-9" } },
    }, CONTEXT);

    assert.equal(result.status, "matched");
    assert.equal(result.matchedAssetId, 77);
    assert.equal(result.method, "tag_and_serial");
    assert.equal(result.confidence, "high");
});

test("mesma Tag + serial ausente → matched pela Tag do gestor, evidência reduzida documentada", async () => {
    const resolver = new IfcTagSerialAssetIdentityResolver(makeLookup({
        findEquipmentByTag: async () => [{ id: 77, asset_code: "EQP-000123", serial_number: null }],
    }));

    const result = await resolver.resolve({ ...CANDIDATE, psets: {} }, CONTEXT);

    assert.equal(result.status, "matched");
    assert.equal(result.matchedAssetId, 77);
    assert.equal(result.method, "equipment_tag");
    assert.ok(result.reasons.some((r) => /reduced.*evidence|serial number absent/i.test(r)));
});

test("mesma Tag + seriais diferentes → caso de reconciliação (substituição/erro de dados), SEM merge", async () => {
    const resolver = new IfcTagSerialAssetIdentityResolver(makeLookup({
        findEquipmentByTag: async () => [{ id: 77, asset_code: "EQP-000123", serial_number: "SN-OLD" }],
    }));

    const result = await resolver.resolve({
        ...CANDIDATE, psets: { Pset_ManufacturerOccurrence: { SerialNumber: "SN-NEW" } },
    }, CONTEXT);

    assert.equal(result.status, "ambiguous", "vira caso de reconciliação humana");
    assert.equal(result.matchedAssetId, null, "sem merge automático");
    assert.ok(result.reasons.some((r) => /serial_conflict/.test(r)));
});

test("mesmo serial + Tags diferentes → caso de reconciliação (renumeração/erro de dados), SEM merge", async () => {
    const resolver = new IfcTagSerialAssetIdentityResolver(makeLookup({
        findEquipmentByTag: async () => [],
        findEquipmentBySerial: async () => [{ id: 88, asset_code: "EQP-OUTRA", serial_number: "SN-9" }],
    }));

    const result = await resolver.resolve({
        ...CANDIDATE, psets: { Pset_ManufacturerOccurrence: { SerialNumber: "SN-9" } },
    }, CONTEXT);

    assert.equal(result.status, "ambiguous");
    assert.equal(result.matchedAssetId, null);
    assert.ok(result.reasons.some((r) => /serial_renumbering/.test(r)));
    assert.deepEqual(result.candidatesConsidered, [{ assetId: 88, via: "serial_number" }]);
});

test("Tag nova (sem conflito de serial) → identidade nova, mesmo em versão posterior", async () => {
    const resolver = new IfcTagSerialAssetIdentityResolver(makeLookup());
    const result = await resolver.resolve(CANDIDATE, CONTEXT);

    assert.equal(result.status, "new");
    assert.equal(result.method, "equipment_tag");
    assert.equal(result.confidence, "high");
});

test("Tag com >1 ativo (defensivo) → ambiguous (tag_conflict), nunca escolhe automaticamente", async () => {
    const resolver = new IfcTagSerialAssetIdentityResolver(makeLookup({
        findEquipmentByTag: async () => [
            { id: 1, asset_code: "EQP-000123", serial_number: null },
            { id: 2, asset_code: "EQP-000123", serial_number: null },
        ],
    }));

    const result = await resolver.resolve(CANDIDATE, CONTEXT);
    assert.equal(result.status, "ambiguous");
    assert.ok(result.reasons.some((r) => /tag_conflict/.test(r)));
});

/* -------------------------------------
   NÃO-IDENTIDADE: ObjectType e Manufacturer
------------------------------------- */

test("ObjectType não participa da identidade: mudá-lo não altera a correspondência pela Tag", async () => {
    const resolver = new IfcTagSerialAssetIdentityResolver(makeLookup({
        findEquipmentByTag: async () => [{ id: 77, asset_code: "EQP-000123", serial_number: null }],
    }));

    const a = await resolver.resolve({ ...CANDIDATE, objectType: "Betoneira Diesel" }, CONTEXT);
    const b = await resolver.resolve({ ...CANDIDATE, objectType: "Classificação Totalmente Nova" }, CONTEXT);

    assert.equal(a.status, "matched");
    assert.equal(b.status, "matched");
    assert.equal(a.matchedAssetId, b.matchedAssetId, "mesma Tag → mesmo ativo, seja qual for o ObjectType");
});

test("Manufacturer não participa: pset de fabricante diferente não cria novo ativo nem muda a decisão", async () => {
    const resolver = new IfcTagSerialAssetIdentityResolver(makeLookup({
        findEquipmentByTag: async () => [{ id: 77, asset_code: "EQP-000123", serial_number: null }],
    }));

    const result = await resolver.resolve({
        ...CANDIDATE,
        psets: { Pset_ManufacturerTypeInformation: { Manufacturer: "Fabricante Distinto Lda" } },
    }, CONTEXT);

    assert.equal(result.status, "matched");
    assert.equal(result.matchedAssetId, 77);
    assert.ok(!result.reasons.some((r) => /Fabricante Distinto/.test(r)));
});

/* -------------------------------------
   GUARDAS DE CÓDIGO (fonte auditada)
------------------------------------- */

const RESOLVER_SOURCE = fs.readFileSync(
    path.join(import.meta.dirname, "../../identity/ifcTagSerialAssetIdentityResolver.ts"), "utf-8");

test("guarda: Manufacturer não pode ser introduzido como chave de identidade sem decisão explícita", () => {
    const codeLines = RESOLVER_SOURCE.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l));
    // Pset_ManufacturerOccurrence.SerialNumber é o pset do SERIAL (permitido);
    // qualquer outra referência a fabricante em código é proibida.
    assert.ok(!codeLines.some((l) => /Manufacturer(?!Occurrence)/.test(l)),
        "nenhuma linha de CÓDIGO do resolver consulta informação de fabricante como identidade");
});

test("guarda: o resolver não consulta GUID (sem fallback em novos uploads)", () => {
    const codeLines = RESOLVER_SOURCE.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l));
    assert.ok(!codeLines.some((l) => /ByGuid|ifc_guid|guidMatches/i.test(l)));
});

/* -------------------------------------
   PROVIDER (registry + factory)
------------------------------------- */

test("provider default: ifc-tag-serial-guid", () => {
    const resolver = provider.getAssetIdentityResolver();
    assert.ok(resolver instanceof IfcTagSerialAssetIdentityResolver);
});

test("alias de compatibilidade: o nome anterior ifc-asset-code-serial-guid resolve para a implementação atual", () => {
    process.env.ASSET_IDENTITY_PROVIDER = "ifc-asset-code-serial-guid";
    const resolver = provider.getAssetIdentityResolver();
    assert.ok(resolver instanceof IfcTagSerialAssetIdentityResolver);
});

test("provider desconhecido → erro claro com opções válidas", () => {
    process.env.ASSET_IDENTITY_PROVIDER = "nao-existe";
    assert.throws(() => provider.getAssetIdentityResolver(), /Unknown asset identity provider 'nao-existe'/);
});

test("guarda: nenhuma instanciação do resolver fora da registry (código de produção)", () => {
    const backDir = path.join(import.meta.dirname, "../..");
    const offenders: string[] = [];

    const scan = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (["node_modules", "tests", "cdn_resources", "python", "bruno_collection", ".git"].includes(entry.name)) continue;
                scan(full);
                continue;
            }
            if (!entry.name.endsWith(".ts")) continue;
            if (full.endsWith(path.join("identity", "assetIdentityProvider.ts"))) continue;
            const source = fs.readFileSync(full, "utf-8");
            if (/new IfcTagSerialAssetIdentityResolver/.test(source)) offenders.push(full);
        }
    };
    scan(backDir);

    assert.deepEqual(offenders, [], "instanciar o resolver fora do provider é proibido");
});

test("resolver substituível em testes sem alterar o pipeline", async () => {
    provider.setAssetIdentityResolver({
        resolve: async () => ({
            status: "matched", matchedAssetId: 999, method: "external", identifierUsed: "X",
            confidence: "high", reasons: [], candidatesConsidered: [], resolverId: "mock",
            rulesVersion: "t", resolvedAt: new Date().toISOString(), guid: "g",
            stableCode: null, serialNumber: null,
        }),
    } as any);

    const result = await provider.getAssetIdentityResolver().resolve(CANDIDATE as any, CONTEXT as any);
    assert.equal(result.matchedAssetId, 999);
});
