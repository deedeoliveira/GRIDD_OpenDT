/**
 * Revisão do Prompt 3 — provider configurável da identidade
 * (SPACE_IDENTITY_PROVIDER) e guardas de arquitetura (Pset_SpaceCommon fora
 * do módulo; instanciação concreta fora da factory; IfcSensor).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installFakeMySQL, fakeConnection, respond } from "../helpers/fakeDb.ts";

installFakeMySQL();

const identityProvider = await import("../../identity/spaceIdentityProvider.ts");

const backDir = fileURLToPath(new URL("../../", import.meta.url));

beforeEach(() => {
    fakeConnection.reset();
    identityProvider.resetSpaceIdentityResolver();
});

/* -------------------------------------
   PROVIDER CONFIGURÁVEL
------------------------------------- */

test("SPACE_IDENTITY_PROVIDER default seleciona o resolver do perfil atual", async () => {
    delete process.env.SPACE_IDENTITY_PROVIDER;
    identityProvider.resetSpaceIdentityResolver();

    const resolver = identityProvider.getSpaceIdentityResolver();
    const result = await resolver.resolve({ guid: "g", psets: { Pset_SpaceCommon: { Reference: "R-1" } } }, {} as any);

    assert.equal(result.resolverId, "pset-space-common-reference");
    assert.equal(result.source, "Pset_SpaceCommon.Reference");
    assert.equal(result.rulesVersion, "prompt3-2026-07");
});

test("SPACE_IDENTITY_PROVIDER explícito funciona; provider desconhecido falha de forma controlada", async () => {
    process.env.SPACE_IDENTITY_PROVIDER = "pset-space-common-reference";
    identityProvider.resetSpaceIdentityResolver();
    assert.ok(identityProvider.getSpaceIdentityResolver());

    process.env.SPACE_IDENTITY_PROVIDER = "nao-existe";
    identityProvider.resetSpaceIdentityResolver();
    assert.throws(() => identityProvider.getSpaceIdentityResolver(), /Unknown space identity provider 'nao-existe'/);

    delete process.env.SPACE_IDENTITY_PROVIDER;
    identityProvider.resetSpaceIdentityResolver();
});

/* -------------------------------------
   GUARDAS DE ARQUITETURA
------------------------------------- */

function walkTs(dir: string): { file: string; content: string }[] {
    const out: { file: string; content: string }[] = [];
    const full = path.join(backDir, dir);
    if (!fs.existsSync(full)) return out;

    const walk = (d: string) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, entry.name);
            if (entry.isDirectory()) { walk(p); continue; }
            if (entry.name.endsWith(".ts") || entry.name.endsWith(".py")) {
                out.push({ file: path.relative(backDir, p), content: fs.readFileSync(p, "utf-8") });
            }
        }
    };
    walk(full);
    return out;
}

test("guarda: 'Pset_SpaceCommon' não aparece como regra funcional fora de identity/ (testes/fixtures/docs permitidos)", () => {
    const offenders: string[] = [];
    for (const dir of ["routes", "services", "utils", "policies", "scripts"]) {
        for (const { file, content } of walkTs(dir)) {
            if (file.endsWith("make_space_fixture.py")) continue; // fixture fonte permitida
            if (/Pset_SpaceCommon/.test(content)) offenders.push(file);
        }
    }
    // ifcopenshell_utils.py extrai TODOS os psets sem nomear nenhum — verificação direta
    const pyUtils = fs.readFileSync(path.join(backDir, "python/ifcopenshell_utils.py"), "utf-8");
    assert.doesNotMatch(pyUtils, /Pset_SpaceCommon/, "o Python não conhece o property set");

    assert.deepEqual(offenders, [], "a fonte da identidade vive apenas em back/identity/");
});

test("guarda: nenhuma instanciação concreta do resolver fora da factory (spaceIdentityProvider)", () => {
    const offenders: string[] = [];
    for (const dir of ["routes", "services", "utils", "policies", "scripts", "identity"]) {
        for (const { file, content } of walkTs(dir)) {
            if (file.replace(/\\/g, "/") === "identity/spaceIdentityProvider.ts") continue;
            if (/new\s+PsetReferenceSpaceIdentityResolver/.test(content)) offenders.push(file);
        }
    }
    assert.deepEqual(offenders, []);
});

test("guarda: exclusão exata de IfcSensor continua apenas na camada de políticas", () => {
    const evaluator = fs.readFileSync(path.join(backDir, "policies/legacyIfcReservabilityEvaluator.ts"), "utf-8");
    assert.match(evaluator, /candidate\.ifcType === "IfcSensor"/, "regra intacta na política");

    const preflight = fs.readFileSync(path.join(backDir, "services/spatialPreflightService.ts"), "utf-8");
    assert.doesNotMatch(preflight, /IfcSensor|Reservability|PolicyEvaluationResult/,
        "o preflight não conhece política de reservas");
});
