/**
 * model_requirements_preflight (revisão do Prompt 4): perfil atual de
 * requisitos de informação (SPACE-/EQUIPMENT-/PROXY-), validadores modulares,
 * provider substituível e preparação para IDS (sem implementar IDS).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { installFakeMySQL, fakeConnection, respond } from "../helpers/fakeDb.ts";

installFakeMySQL();

const requirementsProvider = await import("../../requirements/modelRequirementsProvider.ts");
const { ProjectProfileRequirementsValidator, PROJECT_PROFILE_ID } =
    await import("../../requirements/projectProfileRequirementsValidator.ts");
const { validateProxyRequirements } = await import("../../requirements/proxyRequirementsValidator.ts");
const { validateEquipmentRequirements } = await import("../../requirements/equipmentRequirementsValidator.ts");
const classifierProvider = await import("../../classification/equipmentClassifierProvider.ts");

const CTX = { linkedModelId: 10, modelId: 20, modelVersionId: 9 };

/** Modelo extraído mínimo: 1 espaço com elementos configuráveis. */
function extracted(elements: any[], uncontainedProxies: any[] = []) {
    return {
        inventoryData: {
            "space-A": { spaceGuid: "space-A", spaceName: "Sala A", psets: { Pset_SpaceCommon: { Reference: "R-A" } }, elements },
        },
        uncontainedProxies,
        schema: "IFC4",
    };
}

const equipment = (overrides: Record<string, any> = {}) => ({
    guid: "g-eq", type: "IfcBoiler", name: "Caldeira", tag: "EQP-1",
    objectType: null, predefinedType: null, psets: {}, ...overrides,
});

const proxyEl = (overrides: Record<string, any> = {}) => ({
    guid: "g-px", type: "IfcBuildingElementProxy", name: "Betoneira",
    tag: "EQP-9", objectType: "Betoneira Diesel", predefinedType: null, psets: {}, ...overrides,
});

beforeEach(() => {
    fakeConnection.reset();
    requirementsProvider.resetModelRequirementsValidator();
    classifierProvider.resetEquipmentClassifier();
    delete process.env.MODEL_REQUIREMENTS_PROVIDER;
    delete process.env.EQUIPMENT_CLASSIFIER_PROVIDER;
});

/* -------------------------------------
   EQUIPMENT-001/002/003
------------------------------------- */

test("modelo sem equipamentos passa (sem exigir Tags EQP-)", () => {
    const findings = validateEquipmentRequirements(extracted([]) as any, CTX);
    assert.deepEqual(findings, []);
});

test("equipamento com Tag EQP- válida passa", () => {
    assert.deepEqual(validateEquipmentRequirements(extracted([equipment()]) as any, CTX), []);
});

test("equipamento gerido sem Tag → EQUIPMENT-001", () => {
    const findings = validateEquipmentRequirements(extracted([equipment({ tag: null })]) as any, CTX);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.requirementId, "EQUIPMENT-001");
    assert.equal(findings[0]!.entityGuid, "g-eq");
});

test("Tag vazia, whitespace, prefixo errado e 'EQP-' sem sufixo → EQUIPMENT-002 com motivo distinto", () => {
    const cases: [string, string][] = [
        ["", "empty_or_whitespace_tag"],
        ["   ", "empty_or_whitespace_tag"],
        ["ABC-1", "tag_without_EQP_prefix"],
        ["EQP-", "tag_without_content_after_prefix"],
    ];
    for (const [tag, motivo] of cases) {
        const findings = validateEquipmentRequirements(extracted([equipment({ tag })]) as any, CTX);
        assert.equal(findings.length, 1, `tag=${JSON.stringify(tag)}`);
        assert.equal(findings[0]!.requirementId, "EQUIPMENT-002");
        assert.equal((findings[0]!.details as any).motivo, motivo);
    }
});

test("duplicação de Tag normalizada na mesma versão → EQUIPMENT-003 (o prefixo é sempre exato: 'eqp-' minúsculo é inválido)", () => {
    const findings = validateEquipmentRequirements(extracted([
        equipment({ guid: "g-1", tag: "EQP-1" }),
        equipment({ guid: "g-2", tag: "  EQP-1 " }),
    ]) as any, CTX);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.requirementId, "EQUIPMENT-003");
});

test("ObjectType não é regra fora do proxy: o validador de equipamentos produz o MESMO resultado com ou sem ObjectType", () => {
    // classe específica sem Tag: falha EQUIPMENT-001 independentemente do ObjectType
    for (const objectType of [null, "Caldeira Mural"]) {
        const findings = validateEquipmentRequirements(
            extracted([equipment({ tag: null, objectType })]) as any, CTX);
        assert.equal(findings.length, 1, `objectType=${JSON.stringify(objectType)}`);
        assert.equal(findings[0]!.requirementId, "EQUIPMENT-001");
    }
    // classe específica com Tag válida: passa mesmo SEM ObjectType (não exigido)
    assert.deepEqual(validateEquipmentRequirements(
        extracted([equipment({ objectType: null })]) as any, CTX), []);
});

test("elementos arquitetónicos e estruturais sem Tag passam (não são candidatos)", () => {
    const findings = validateEquipmentRequirements(extracted([
        equipment({ guid: "g-w", type: "IfcWall", tag: null }),
        equipment({ guid: "g-c", type: "IfcColumn", tag: null }),
    ]) as any, CTX);
    assert.deepEqual(findings, []);
});

/* -------------------------------------
   PROXY-001/002 (qualquer proxy do modelo)
------------------------------------- */

test("proxy sem/com ObjectType vazio ou whitespace → PROXY-001 com mensagem própria", () => {
    for (const objectType of [null, "", "   "]) {
        const findings = validateProxyRequirements(extracted([proxyEl({ objectType })]) as any, CTX);
        assert.equal(findings.length, 1);
        assert.equal(findings[0]!.requirementId, "PROXY-001");
        assert.match(findings[0]!.message, /IfcBuildingElementProxy without a valid ObjectType/);
    }
});

test("proxy com ObjectType mas Tag ausente/inválida/EQP- vazia → PROXY-002 com mensagem própria", () => {
    for (const tag of [null, "", "ABC-1", "EQP-"]) {
        const findings = validateProxyRequirements(extracted([proxyEl({ tag })]) as any, CTX);
        assert.equal(findings.length, 1, `tag=${JSON.stringify(tag)}`);
        assert.equal(findings[0]!.requirementId, "PROXY-002");
        assert.match(findings[0]!.message, /without a valid equipment Tag starting with EQP-/);
    }
});

test("proxy com ObjectType e Tag válida passa e é managed_equipment (PROXY-003 via classificador central)", () => {
    assert.deepEqual(validateProxyRequirements(extracted([proxyEl()]) as any, CTX), []);
});

test("proxies FORA de espaços também são validados (regra vale para qualquer proxy do modelo)", () => {
    const findings = validateProxyRequirements(
        extracted([], [proxyEl({ guid: "g-solto", objectType: null })]) as any, CTX);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.entityGuid, "g-solto");
});

test("proxies duplicados entram na verificação de duplicação de Tags (EQUIPMENT-003)", () => {
    const findings = validateEquipmentRequirements(extracted([
        proxyEl({ guid: "g-p1", tag: "EQP-9" }),
        proxyEl({ guid: "g-p2", tag: "EQP-9" }),
    ]) as any, CTX);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.requirementId, "EQUIPMENT-003");
});

/* -------------------------------------
   ORQUESTRADOR + PROVIDER (preparação IDS)
------------------------------------- */

test("provider atual é project-profile-v1 e o resultado declara o perfil (não é IDS)", async () => {
    const validator = requirementsProvider.getModelRequirementsValidator();
    assert.ok(validator instanceof ProjectProfileRequirementsValidator);

    respond([[/spatial_authority_model_id/i, [[{ spatial_authority_model_id: null, model_count: 2, single_model_id: 99 }]]]]);
    const result = await validator.validate(extracted([equipment()]) as any, CTX);

    assert.equal(result.status, "conforms");
    assert.equal(result.profileId, PROJECT_PROFILE_ID);
    assert.ok(result.profileVersion);
    assert.ok(result.evaluatedAt);
    assert.doesNotMatch(JSON.stringify(result), /\bIDS\b/, "resultados não se descrevem como IDS");
});

test("orquestrador agrega findings dos 3 validadores modulares (espacial + proxy + equipamento)", async () => {
    // não autoritativo (regra espacial estrita não dispara) + proxy inválido + equipamento sem Tag
    respond([[/spatial_authority_model_id/i, [[{ spatial_authority_model_id: null, model_count: 2, single_model_id: 99 }]]]]);

    const result = await requirementsProvider.getModelRequirementsValidator().validate(
        extracted([equipment({ tag: null }), proxyEl({ objectType: null })]) as any, CTX);

    assert.equal(result.status, "does_not_conform");
    const ids = result.findings.map((f) => f.requirementId).sort();
    assert.deepEqual(ids, ["EQUIPMENT-001", "PROXY-001"]);
});

test("validador espacial modular integrado: modelo autoritativo sem espaços → SPACE-001 (mensagem preservada)", async () => {
    respond([[/spatial_authority_model_id/i, [[{ spatial_authority_model_id: null, model_count: 1, single_model_id: CTX.modelId }]]]]);

    const result = await requirementsProvider.getModelRequirementsValidator().validate(
        { inventoryData: {}, uncontainedProxies: [], schema: "IFC4" } as any, CTX);

    assert.equal(result.status, "does_not_conform");
    assert.equal(result.findings[0]!.requirementId, "SPACE-001");
    assert.match(result.findings[0]!.message, /contains no IfcSpace elements/);
});

test("provider desconhecido falha de forma controlada", () => {
    process.env.MODEL_REQUIREMENTS_PROVIDER = "ids-ainda-nao-existe";
    assert.throws(() => requirementsProvider.getModelRequirementsValidator(), /Unknown model requirements provider/);
});

test("provider substituível: contrato geral permite um futuro IdsModelRequirementsValidator sem tocar no upload", async () => {
    requirementsProvider.setModelRequirementsValidator({
        validate: async () => ({
            status: "conforms", profileId: "mock-profile", profileVersion: "1",
            validatorId: "mock", findings: [], evaluatedAt: new Date().toISOString(),
        }),
    } as any);

    const result = await requirementsProvider.getModelRequirementsValidator().validate(extracted([]) as any, CTX);
    assert.equal(result.profileId, "mock-profile");
});

/* -------------------------------------
   PERFIL IFC4 (decisão fixada)
------------------------------------- */

const backDir = path.join(import.meta.dirname, "../..");

test("fixtures usam IFC4 (gerador declara IFC4; sem IFC4x3)", () => {
    const generator = fs.readFileSync(path.join(backDir, "python/make_space_fixture.py"), "utf-8");
    assert.match(generator, /version="IFC4"/);
    assert.doesNotMatch(generator, /IFC4x3|IFC4\.3/i);
});

test("nenhum código ou teste do backend depende de IFC4x3", () => {
    const offenders: string[] = [];
    const scan = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (["node_modules", "cdn_resources", "venv", ".git"].includes(entry.name)) continue;
                scan(full);
                continue;
            }
            if (!/\.(ts|py)$/.test(entry.name)) continue;
            const source = fs.readFileSync(full, "utf-8");
            // este próprio teste menciona o termo para o proibir
            if (full.includes("requirementsPreflight.test.ts")) continue;
            if (/IFC4x3|IFC4\.3/i.test(source)) offenders.push(full);
        }
    };
    scan(backDir);
    assert.deepEqual(offenders, []);
});

test("documentação declara IFC4 como perfil suportado e testado", () => {
    const doc = fs.readFileSync(path.join(backDir, "../documentation/audit/PROMPT4_ASSETS.md"), "utf-8");
    assert.match(doc, /IFC4/);
});

test("nenhuma dependência IDS foi introduzida (apenas preparação arquitetural)", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(backDir, "package.json"), "utf-8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    assert.ok(!Object.keys(deps).some((d) => /ids/i.test(d) && d !== "tsx"), "sem parser/validador IDS");
    assert.ok(!fs.existsSync(path.join(backDir, "requirements/idsModelRequirementsValidator.ts")),
        "IdsModelRequirementsValidator é futuro — não implementado nesta etapa");
});
