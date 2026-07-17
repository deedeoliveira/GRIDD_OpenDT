/**
 * Testes do spatial_preflight (revisão do Prompt 3) — validação estrita dos
 * requisitos de informação espacial ANTES de qualquer persistência.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeMySQL, fakeConnection, respond } from "../helpers/fakeDb.ts";

installFakeMySQL();

const { runSpatialPreflight, SpatialPreflightError, groupDuplicateReferences } =
    await import("../../services/spatialPreflightService.ts");
const identityProvider = await import("../../identity/spaceIdentityProvider.ts");

beforeEach(() => {
    fakeConnection.reset();
    identityProvider.resetSpaceIdentityResolver();
});

const AUTHORITY_SINGLE: [RegExp, any] =
    [/spatial_authority_model_id/i, [[{ spatial_authority_model_id: null, model_count: 1, single_model_id: 20 }]]];
const AUTHORITY_UNDETERMINED: [RegExp, any] =
    [/spatial_authority_model_id/i, [[{ spatial_authority_model_id: null, model_count: 3, single_model_id: 20 }]]];
const AUTHORITY_OTHER_MODEL: [RegExp, any] =
    [/spatial_authority_model_id/i, [[{ spatial_authority_model_id: 99, model_count: 3, single_model_id: 20 }]]];

const CTX = { linkedModelId: 10, modelId: 20, modelVersionId: 30 };

function space(guid: string, code: string | null, name = "Sala", longName: string | null = "Sala Longa") {
    return {
        spaceGuid: guid, spaceName: name, spaceLongName: longName,
        psets: code === null ? {} : { Pset_SpaceCommon: { Reference: code } },
        elements: [],
    };
}

/* -------------------------------------
   MODELO SEM IfcSpace
------------------------------------- */

test("modelo espacial autoritativo (federação de um único modelo) sem IfcSpace → falha 422", async () => {
    respond([AUTHORITY_SINGLE]);

    await assert.rejects(
        runSpatialPreflight({ ...CTX, inventoryData: {} }),
        (error: any) => {
            assert.ok(error instanceof SpatialPreflightError);
            assert.equal(error.code, "no_ifcspace");
            assert.equal(error.statusCode, 422);
            assert.equal(error.failureReason, "no IfcSpace found");
            assert.match(error.message, /contains no IfcSpace elements/);
            return true;
        }
    );
});

test("modelo NÃO autoritativo sem IfcSpace → permitido (modelos disciplinares preservados)", async () => {
    respond([AUTHORITY_OTHER_MODEL]);

    const outcome = await runSpatialPreflight({ ...CTX, inventoryData: {} });
    assert.equal(outcome.isAuthoritative, false);
});

test("federação multi-modelo SEM autoridade configurada → sem validação estrita (autoridade indeterminada preservada)", async () => {
    respond([AUTHORITY_UNDETERMINED]);

    const outcome = await runSpatialPreflight({
        ...CTX,
        inventoryData: { g1: space("g1", null) },
    });
    assert.equal(outcome.isAuthoritative, false, "uploads disciplinares não ficam impossíveis");
});

test("modelo sem federação (linked NULL) → sem validação estrita", async () => {
    const outcome = await runSpatialPreflight({
        linkedModelId: null, modelId: 20, modelVersionId: 30, inventoryData: {},
    });
    assert.equal(outcome.isAuthoritative, false);
});

/* -------------------------------------
   ESPAÇOS SEM Reference VÁLIDO (validação estrita, sem aceitação parcial)
------------------------------------- */

test("um espaço sem Reference falha, mesmo entre válidos — diagnóstico agregado com contagem", async () => {
    respond([AUTHORITY_SINGLE]);

    await assert.rejects(
        runSpatialPreflight({
            ...CTX,
            inventoryData: {
                g1: space("g1", "R-101"),
                g2: space("g2", null, "Sala Sem Código", "Long Sem Código"),
                g3: space("g3", "R-103"),
            },
        }),
        (error: any) => {
            assert.equal(error.code, "invalid_references");
            assert.equal(error.statusCode, 422);
            assert.match(error.message, /do not contain a valid Pset_SpaceCommon\.Reference/);
            assert.match(error.message, /1 of 3 IfcSpace elements are missing a valid inventory reference/);
            assert.equal(error.diagnostics.length, 1);
            const d = error.diagnostics[0];
            assert.equal(d.guid, "g2");
            assert.equal(d.name, "Sala Sem Código");
            assert.equal(d.longName, "Long Sem Código");
            assert.equal(d.index, 1);
            assert.equal(d.motivo, "missing_reference");
            return true;
        }
    );
});

test("Reference vazio → empty_reference; whitespace → empty_reference; tipo inválido → invalid_reference_type", async () => {
    respond([AUTHORITY_SINGLE]);

    await assert.rejects(
        runSpatialPreflight({
            ...CTX,
            inventoryData: {
                g1: { ...space("g1", null), psets: { Pset_SpaceCommon: { Reference: "" } } },
                g2: { ...space("g2", null), psets: { Pset_SpaceCommon: { Reference: "   " } } },
                g3: { ...space("g3", null), psets: { Pset_SpaceCommon: { Reference: 101 } } },
            },
        }),
        (error: any) => {
            assert.equal(error.code, "invalid_references");
            const motivos = error.diagnostics.map((d: any) => d.motivo);
            assert.deepEqual(motivos, ["empty_reference", "empty_reference", "invalid_reference_type"]);
            assert.match(error.message, /3 of 3/);
            return true;
        }
    );
});

test("todos os espaços válidos → preflight passa e devolve isAuthoritative", async () => {
    respond([AUTHORITY_SINGLE]);

    const outcome = await runSpatialPreflight({
        ...CTX,
        inventoryData: { g1: space("g1", "R-101"), g2: space("g2", "R-102") },
    });

    assert.equal(outcome.isAuthoritative, true);
    assert.equal(outcome.spaceCount, 2);
});

/* -------------------------------------
   DUPLICADOS (movidos para antes da persistência)
------------------------------------- */

test("códigos duplicados no autoritativo → falha no preflight, antes de qualquer INSERT", async () => {
    respond([AUTHORITY_SINGLE]);

    await assert.rejects(
        runSpatialPreflight({
            ...CTX,
            inventoryData: { g1: space("g1", "R-DUP"), g2: space("g2", " R-DUP "), g3: space("g3", "R-OK") },
        }),
        (error: any) => {
            assert.equal(error.code, "duplicate_references");
            assert.match(error.message, /Duplicate space inventory code\(s\) in authoritative spatial model: R-DUP/);
            assert.deepEqual(error.diagnostics[0].entities.map((e: any) => e.guid), ["g1", "g2"]);
            return true;
        }
    );

    assert.equal(fakeConnection.callsMatching(/INSERT INTO/i).length, 0, "nenhuma persistência");
});

test("groupDuplicateReferences é a lógica única partilhada (preflight + persistência defensiva)", () => {
    const mk = (guid: string, code: string | null) => ({
        result: {
            status: code ? "valid" : "missing", normalizedValue: code,
            rawValue: code, source: "s", reasons: [], resolverId: "r",
            resolvedAt: new Date().toISOString(), guid,
        } as any,
    });

    const dups = groupDuplicateReferences([mk("a", "X"), mk("b", "X"), mk("c", "Y"), mk("d", null)]);
    assert.deepEqual([...dups.keys()], ["X"]);
    assert.equal(dups.get("X")!.length, 2);
});

/* -------------------------------------
   SEPARAÇÃO DE RESPONSABILIDADES
------------------------------------- */

test("o preflight é falha de requisitos de informação — não é PolicyEvaluationResult nem passa pela política", async () => {
    respond([AUTHORITY_SINGLE]);

    try {
        await runSpatialPreflight({ ...CTX, inventoryData: {} });
        assert.fail("devia rejeitar");
    } catch (error: any) {
        assert.equal(error.name, "SpatialPreflightError");
        assert.equal((error as any).decision, undefined, "não tem 'decision' de política");
        assert.equal((error as any).evaluatorId, undefined, "não tem evaluatorId de política");
    }
});

test("a mensagem usa a origem do provider dinamicamente (sem Pset_SpaceCommon hardcoded no serviço)", async () => {
    identityProvider.setSpaceIdentityResolver({
        resolve: async (c) => ({
            status: "missing", rawValue: null, normalizedValue: null,
            source: "ClassificationRef.Code", reasons: ["mock"], reasonCode: "missing",
            resolverId: "mock", resolvedAt: new Date().toISOString(), guid: c.guid,
        }),
    });
    respond([AUTHORITY_SINGLE]);

    await assert.rejects(
        runSpatialPreflight({ ...CTX, inventoryData: { g1: space("g1", "qualquer") } }),
        /do not contain a valid ClassificationRef\.Code/
    );
});
