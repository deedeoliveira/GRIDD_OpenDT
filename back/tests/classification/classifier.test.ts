/**
 * Classificador de candidatos a equipamento gerido (revisão do Prompt 4) —
 * regras do perfil atual (IFC4), regra específica do IfcBuildingElementProxy
 * e substituibilidade do provider. A classificação NUNCA usa a política de
 * reservabilidade nem decide identidade.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { installFakeMySQL } from "../helpers/fakeDb.ts";

installFakeMySQL();

const { ProjectProfileEquipmentClassifier } = await import("../../classification/projectProfileEquipmentClassifier.ts");
const provider = await import("../../classification/equipmentClassifierProvider.ts");
const tagRules = await import("../../classification/equipmentTag.ts");

const CTX = { modelId: 20, modelVersionId: 9, linkedModelId: 10 };
const classifier = new ProjectProfileEquipmentClassifier();

function classify(overrides: Record<string, any>) {
    return classifier.classify({
        guid: "g-1", ifcClass: "IfcBoiler", name: "Caldeira",
        predefinedType: null, objectType: null, tag: "EQP-1", psets: null,
        ...overrides,
    } as any, CTX);
}

beforeEach(() => {
    provider.resetEquipmentClassifier();
    delete process.env.EQUIPMENT_CLASSIFIER_PROVIDER;
});

/* -------------------------------------
   CLASSIFICAÇÃO GERAL (por classe IFC4)
------------------------------------- */

test("espaço não é equipamento: IfcSpace → space", () => {
    assert.equal(classify({ ifcClass: "IfcSpace" }).classification, "space");
});

test("elemento arquitetónico não é equipamento (IfcWall, IfcDoor, IfcWindow) e não precisa de Tag", () => {
    for (const ifcClass of ["IfcWall", "IfcDoor", "IfcWindow"]) {
        const result = classify({ ifcClass, tag: null });
        assert.equal(result.classification, "architectural_element", ifcClass);
    }
});

test("elemento estrutural não é equipamento (IfcColumn, IfcBeam, IfcFooting) e não precisa de Tag", () => {
    for (const ifcClass of ["IfcColumn", "IfcBeam", "IfcFooting"]) {
        assert.equal(classify({ ifcClass, tag: null }).classification, "structural_element", ifcClass);
    }
});

test("equipamento conhecido é classificado managed_equipment (classes auditadas do perfil)", () => {
    for (const ifcClass of ["IfcBoiler", "IfcUnitaryEquipment", "IfcElectricAppliance", "IfcLightFixture", "IfcOutlet", "IfcFurniture", "IfcSensor"]) {
        assert.equal(classify({ ifcClass }).classification, "managed_equipment", ifcClass);
    }
});

test("ObjectType é irrelevante fora do proxy: mudá-lo numa classe IFC específica não altera a classificação", () => {
    const semOT = classify({ ifcClass: "IfcBoiler", objectType: null });
    const comOT = classify({ ifcClass: "IfcBoiler", objectType: "Caldeira Mural" });
    const outroOT = classify({ ifcClass: "IfcBoiler", objectType: "Outra Coisa Qualquer" });

    assert.equal(semOT.classification, "managed_equipment");
    assert.equal(comOT.classification, semOT.classification);
    assert.equal(outroOT.classification, semOT.classification);
    assert.deepEqual(comOT.metadataUsed, ["ifcClass"], "classes normais nunca consultam ObjectType");

    // e não é exigido: IfcWall/IfcColumn sem ObjectType já cobertos acima
    assert.equal(classify({ ifcClass: "IfcFurniture", objectType: null }).classification, "managed_equipment");
});

test("classe fora do perfil → undetermined, que NÃO é tratado como ignorado", () => {
    const result = classify({ ifcClass: "IfcDuctSegment" });
    assert.equal(result.classification, "undetermined");
    assert.notEqual(result.classification, "ignored_element");
    assert.ok(result.reasons.some((r) => /not silently ignored|requires human/.test(r)));
});

test("resultado é auditável: classifierId, rulesVersion, classe, metadados usados e razões", () => {
    const result = classify({});
    assert.equal(result.classifierId, "project-profile-equipment-classifier");
    assert.ok(result.rulesVersion);
    assert.equal(result.ifcClass, "IfcBoiler");
    assert.deepEqual(result.metadataUsed, ["ifcClass"], "classes normais decidem só pela classe — nunca pela presença de Tag");
    assert.ok(result.reasons.length >= 1);
});

/* -------------------------------------
   IfcBuildingElementProxy (regra do perfil)
------------------------------------- */

const proxy = (overrides: Record<string, any> = {}) =>
    classify({ ifcClass: "IfcBuildingElementProxy", objectType: "Betoneira Diesel", tag: "EQP-000123", ...overrides });

test("proxy sem ObjectType → invalid_proxy", () => {
    assert.equal(proxy({ objectType: null }).classification, "invalid_proxy");
});

test("proxy com ObjectType vazio ou whitespace → invalid_proxy", () => {
    assert.equal(proxy({ objectType: "" }).classification, "invalid_proxy");
    assert.equal(proxy({ objectType: "   " }).classification, "invalid_proxy");
});

test("proxy com ObjectType mas sem Tag → invalid_proxy", () => {
    assert.equal(proxy({ tag: null }).classification, "invalid_proxy");
});

test("proxy com ObjectType e Tag sem prefixo EQP- (ou EQP- vazio) → invalid_proxy", () => {
    assert.equal(proxy({ tag: "ABC-1" }).classification, "invalid_proxy");
    assert.equal(proxy({ tag: "EQP-" }).classification, "invalid_proxy");
    assert.equal(proxy({ tag: "   " }).classification, "invalid_proxy");
});

test("proxy com ObjectType válido e Tag EQP- válida → managed_equipment", () => {
    const result = proxy({});
    assert.equal(result.classification, "managed_equipment");
    assert.equal(result.objectType, "Betoneira Diesel", "ObjectType preservado como metadado do resultado");
});

test("PredefinedType e Name NÃO substituem ObjectType", () => {
    assert.equal(proxy({ objectType: null, predefinedType: "USERDEFINED" }).classification, "invalid_proxy");
    assert.equal(proxy({ objectType: null, name: "Betoneira Bem Nomeada" }).classification, "invalid_proxy");
});

test("proxy nunca é classificado automaticamente como arquitetónico/estrutural/ignorado", () => {
    for (const result of [proxy({ objectType: null }), proxy({ tag: null }), proxy({})]) {
        assert.ok(["invalid_proxy", "managed_equipment"].includes(result.classification));
    }
});

/* -------------------------------------
   REGRAS DA TAG (fonte única partilhada)
------------------------------------- */

test("validação da Tag: presença, string, não-vazia, prefixo exato EQP-, conteúdo após o prefixo", () => {
    assert.equal(tagRules.isValidEquipmentTag("EQP-000123"), true);
    assert.equal(tagRules.isValidEquipmentTag(undefined), false);
    assert.equal(tagRules.isValidEquipmentTag(123 as any), false);
    assert.equal(tagRules.isValidEquipmentTag(""), false);
    assert.equal(tagRules.isValidEquipmentTag("   "), false);
    assert.equal(tagRules.isValidEquipmentTag("QEP-1"), false);
    assert.equal(tagRules.isValidEquipmentTag("EQP-"), false);
});

/* -------------------------------------
   PROVIDER (substituível; central)
------------------------------------- */

test("classificador é substituível via provider sem alterar o pipeline", () => {
    provider.setEquipmentClassifier({
        classify: () => ({
            classification: "managed_equipment", classifierId: "mock", rulesVersion: "t",
            ifcClass: "IfcAnything", predefinedType: null, objectType: null, tag: null,
            metadataUsed: [], reasons: [], classifiedAt: new Date().toISOString(),
        }),
    } as any);

    const result = provider.getEquipmentClassifier().classify({ guid: "g", ifcClass: "IfcAnything" } as any, CTX);
    assert.equal(result.classifierId, "mock");
});

test("provider desconhecido falha de forma controlada", () => {
    process.env.EQUIPMENT_CLASSIFIER_PROVIDER = "nao-existe";
    assert.throws(() => provider.getEquipmentClassifier(), /Unknown equipment classifier provider/);
});

test("guarda: listas de classes só existem no módulo de classificação (não espalhadas)", () => {
    const backDir = path.join(import.meta.dirname, "../..");
    const offenders: string[] = [];

    const scan = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (["node_modules", "tests", "cdn_resources", "python", "bruno_collection", "classification", ".git"].includes(entry.name)) continue;
                scan(full);
                continue;
            }
            if (!entry.name.endsWith(".ts")) continue;
            const source = fs.readFileSync(full, "utf-8");
            // classes arquitetónicas/estruturais só podem ser referidas no classificador
            if (/IfcWallStandardCase|IfcCurtainWall|IfcReinforcingBar/.test(source)) offenders.push(full);
        }
    };
    scan(backDir);

    assert.deepEqual(offenders, []);
});
