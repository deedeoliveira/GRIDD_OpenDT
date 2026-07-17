/**
 * Testes do serviço de identidade espacial (Prompt 3) — regras de identidade,
 * bindings, duplicações, autoridade e reconciliação de estados.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeMySQL, fakeConnection, respond } from "../helpers/fakeDb.ts";

installFakeMySQL();

const { persistSpaceIdentities, reconcileSpaceStatusesAfterActivation, DuplicateSpaceReferenceError } =
    await import("../../services/spaceIdentityService.ts");
const identityProvider = await import("../../identity/spaceIdentityProvider.ts");
const { default: spaceDb } = await import("../../utils/spaceDatabase.ts");

beforeEach(() => {
    fakeConnection.reset();
    identityProvider.resetSpaceIdentityResolver();
});

const CTX = { linkedModelId: 10, modelId: 20, modelVersionId: 30 };

function cand(guid: string, code: string | null, entityId: number, name = "Sala", longName = "Sala Longa") {
    return {
        guid, name, longName, entityId,
        psets: code === null ? {} : { Pset_SpaceCommon: { Reference: code } },
    };
}

/** Autoridade: federação com um único model (o modelId dado) → autoritativo. */
const AUTHORITY_SINGLE: [RegExp, any] =
    [/spatial_authority_model_id/i, [[{ spatial_authority_model_id: null, model_count: 1, single_model_id: 20 }]]];

/** Autoridade indeterminada: federação multi-model sem configuração. */
const AUTHORITY_UNDETERMINED: [RegExp, any] =
    [/spatial_authority_model_id/i, [[{ spatial_authority_model_id: null, model_count: 2, single_model_id: 20 }]]];

/* -------------------------------------
   REGRAS DE IDENTIDADE
------------------------------------- */

test("mesmo código + GUID diferente → reutiliza o mesmo space_id (sem novo INSERT em spaces)", async () => {
    respond([
        AUTHORITY_SINGLE,
        [/SELECT \* FROM spaces[\s\S]*inventory_code_normalized/i, [[{ id: 55, space_uuid: "uuid-55" }]]],
        [/INSERT INTO space_bindings/i, [{ insertId: 91 }]],
    ]);

    const outcome = await persistSpaceIdentities({
        ...CTX,
        candidates: [cand("guid-NOVO-diferente", "R-101", 700)],
    });

    assert.equal(outcome.diagnostics.reused_spaces, 1);
    assert.equal(outcome.diagnostics.created_spaces, 0);
    assert.equal(fakeConnection.callsMatching(/INSERT INTO spaces/i).length, 0);

    const binding = fakeConnection.callsMatching(/INSERT INTO space_bindings/i)[0]!;
    assert.equal(binding.params.spaceId, 55, "binding aponta para o espaço persistente existente");
});

test("mesmo código + nome diferente → mesmo space_id (nome não é critério de identidade)", async () => {
    respond([
        AUTHORITY_SINGLE,
        [/SELECT \* FROM spaces[\s\S]*inventory_code_normalized/i, [[{ id: 55 }]]],
        [/INSERT INTO space_bindings/i, [{ insertId: 91 }]],
    ]);

    const outcome = await persistSpaceIdentities({
        ...CTX,
        candidates: [cand("g1", "R-101", 700, "Nome Completamente Novo", "Outro LongName")],
    });

    assert.equal(outcome.diagnostics.reused_spaces, 1);
});

test("GUID igual + código diferente → espaço persistente NOVO (GUID não é identidade nem desempate)", async () => {
    respond([
        AUTHORITY_SINGLE,
        [/SELECT \* FROM spaces[\s\S]*inventory_code_normalized/i, [[]]],
        [/INSERT INTO spaces/i, [{ insertId: 77 }]],
        [/INSERT INTO space_bindings/i, [{ insertId: 91 }]],
    ]);

    const outcome = await persistSpaceIdentities({
        ...CTX,
        candidates: [cand("guid-IGUAL-ao-antigo", "R-999", 700)],
    });

    assert.equal(outcome.diagnostics.created_spaces, 1);
    assert.deepEqual(outcome.createdSpaceIds, [77]);

    // a resolução usa apenas âmbito + código — nunca o GUID
    const lookup = fakeConnection.callsMatching(/SELECT \* FROM spaces/i)[0]!;
    assert.doesNotMatch(lookup.sql, /guid/i);
    assert.equal(lookup.params.normalizedCode, "R-999");
});

test("código novo → espaço novo com uuid e âmbito corretos", async () => {
    respond([
        AUTHORITY_SINGLE,
        [/SELECT \* FROM spaces/i, [[]]],
        [/INSERT INTO spaces/i, [{ insertId: 78 }]],
        [/INSERT INTO space_bindings/i, [{ insertId: 92 }]],
    ]);

    await persistSpaceIdentities({ ...CTX, candidates: [cand("g2", "  R-500  ", 701)] });

    const insert = fakeConnection.callsMatching(/INSERT INTO spaces/i)[0]!;
    assert.equal(insert.params.linkedModelId, 10, "unicidade aplicada no âmbito do linked_model");
    assert.equal(insert.params.inventoryCode, "  R-500  ", "valor original preservado");
    assert.equal(insert.params.inventoryCodeNormalized, "R-500");
    assert.match(insert.params.spaceUuid, /^[0-9a-f-]{36}$/, "space_uuid gerado");
});

test("Reference ausente → sem espaço persistente, sem binding, diagnóstico ignored_missing_inventory_code", async () => {
    respond([AUTHORITY_SINGLE]);

    const outcome = await persistSpaceIdentities({ ...CTX, candidates: [cand("g3", null, 702)] });

    assert.deepEqual(outcome.diagnostics.ignored_missing_inventory_code, ["g3"]);
    assert.equal(outcome.bindingsCreated, 0);
    assert.equal(fakeConnection.callsMatching(/INSERT INTO spaces/i).length, 0);
    assert.equal(fakeConnection.callsMatching(/INSERT INTO space_bindings/i).length, 0);
});

test("Reference inválido (vazio) → diagnóstico invalid_reference, sem persistência", async () => {
    respond([AUTHORITY_SINGLE]);

    const outcome = await persistSpaceIdentities({ ...CTX, candidates: [cand("g4", "   ", 703)] });

    assert.equal(outcome.diagnostics.invalid_reference.length, 1);
    assert.equal(outcome.diagnostics.invalid_reference[0]!.guid, "g4");
    assert.equal(outcome.bindingsCreated, 0);
});

test("códigos iguais em linked_models diferentes não colidem (âmbito local)", async () => {
    respond([
        AUTHORITY_SINGLE,
        [/SELECT \* FROM spaces/i, [[]]],
        [/INSERT INTO spaces/i, [{ insertId: 80 }]],
        [/INSERT INTO space_bindings/i, [{ insertId: 95 }]],
    ]);

    await persistSpaceIdentities({ linkedModelId: 10, modelId: 20, modelVersionId: 30, candidates: [cand("gA", "R-1", 710)] });
    const first = fakeConnection.callsMatching(/INSERT INTO spaces/i)[0]!;

    fakeConnection.reset();
    respond([
        [/spatial_authority_model_id/i, [[{ spatial_authority_model_id: null, model_count: 1, single_model_id: 21 }]]],
        [/SELECT \* FROM spaces/i, [[]]],
        [/INSERT INTO spaces/i, [{ insertId: 81 }]],
        [/INSERT INTO space_bindings/i, [{ insertId: 96 }]],
    ]);
    await persistSpaceIdentities({ linkedModelId: 11, modelId: 21, modelVersionId: 31, candidates: [cand("gB", "R-1", 711)] });
    const second = fakeConnection.callsMatching(/INSERT INTO spaces/i)[0]!;

    assert.equal(first.params.linkedModelId, 10);
    assert.equal(second.params.linkedModelId, 11);
});

/* -------------------------------------
   BINDINGS
------------------------------------- */

test("binding regista versão explícita, entity coerente e snapshots (código/name/longName)", async () => {
    respond([
        AUTHORITY_SINGLE,
        [/SELECT \* FROM spaces/i, [[{ id: 55 }]]],
        [/INSERT INTO space_bindings/i, [{ insertId: 91 }]],
    ]);

    await persistSpaceIdentities({
        ...CTX,
        candidates: [cand("g5", " R-101 ", 704, "Sala 101", "Sala Grande 101")],
    });

    const binding = fakeConnection.callsMatching(/INSERT INTO space_bindings/i)[0]!;
    assert.equal(binding.params.modelVersionId, 30, "versão identificada explicitamente");
    assert.equal(binding.params.entityId, 704);
    assert.equal(binding.params.ifcGuid, "g5");
    assert.equal(binding.params.inventoryCodeSnapshot, " R-101 ", "snapshot preserva o valor usado na resolução");
    assert.equal(binding.params.nameSnapshot, "Sala 101");
    assert.equal(binding.params.longNameSnapshot, "Sala Grande 101");
    assert.doesNotMatch(binding.sql, /ORDER BY id DESC/i);
});

/* -------------------------------------
   DUPLICAÇÕES
------------------------------------- */

test("duplicação no modelo espacial autoritativo → DuplicateSpaceReferenceError com diagnóstico completo, nada persistido", async () => {
    respond([AUTHORITY_SINGLE]);

    await assert.rejects(
        persistSpaceIdentities({
            ...CTX,
            candidates: [cand("gX", "R-101", 705, "Sala A"), cand("gY", " R-101 ", 706, "Sala B")],
        }),
        (error: any) => {
            assert.ok(error instanceof DuplicateSpaceReferenceError);
            assert.match(error.message, /R-101/);
            const diag = error.diagnostics[0];
            assert.equal(diag.code, "R-101");
            assert.equal(diag.modelVersionId, 30);
            assert.equal(diag.linkedModelId, 10);
            assert.deepEqual(diag.entities.map((e: any) => e.guid), ["gX", "gY"]);
            return true;
        }
    );

    assert.equal(fakeConnection.callsMatching(/INSERT INTO spaces/i).length, 0);
    assert.equal(fakeConnection.callsMatching(/INSERT INTO space_bindings/i).length, 0);
});

test("duplicação em modelo NÃO autoritativo → não lança; ignora os duplicados e persiste os restantes", async () => {
    respond([
        AUTHORITY_UNDETERMINED,
        [/SELECT \* FROM spaces/i, [[]]],
        [/INSERT INTO spaces/i, [{ insertId: 88 }]],
        [/INSERT INTO space_bindings/i, [{ insertId: 99 }]],
    ]);

    const outcome = await persistSpaceIdentities({
        ...CTX,
        candidates: [
            cand("gX", "R-200", 705),
            cand("gY", "R-200", 706),
            cand("gZ", "R-300", 707),
        ],
    });

    assert.equal(outcome.diagnostics.duplicate_reference.length, 1);
    assert.equal(outcome.bindingsCreated, 1, "só o código não duplicado é persistido");
    assert.equal(outcome.diagnostics.isAuthoritative, false);
});

/* -------------------------------------
   RECONCILIAÇÃO DE ESTADOS (ausência / divisão / fusão)
------------------------------------- */

test("ausência em versão autoritativa: códigos ausentes ficam 'absent', presentes voltam a 'active' — nunca DELETE", async () => {
    respond([
        AUTHORITY_SINGLE,
        [/UPDATE spaces SET status/i, [{}]],
    ]);

    await reconcileSpaceStatusesAfterActivation({
        linkedModelId: 10, modelId: 20, presentNormalizedCodes: ["R-101B", "R-101C"],
    });

    const updates = fakeConnection.callsMatching(/UPDATE spaces SET status/i);
    assert.equal(updates.length, 2);
    assert.match(updates[0]!.sql, /'absent'/);
    assert.match(updates[0]!.sql, /NOT IN/);
    assert.match(updates[1]!.sql, /'active'/);
    assert.equal(updates[0]!.params.code0, "R-101B");
    assert.equal(fakeConnection.callsMatching(/DELETE FROM spaces/i).length, 0);
    // nenhuma inferência por GUID ou geometria
    for (const u of updates) assert.doesNotMatch(u.sql, /guid|geometr/i);
});

test("ausência em modelo NÃO autoritativo → nenhum UPDATE de estado (espaços não são retirados)", async () => {
    respond([
        [/spatial_authority_model_id/i, [[{ spatial_authority_model_id: 99, model_count: 3, single_model_id: 20 }]]],
    ]);

    await reconcileSpaceStatusesAfterActivation({
        linkedModelId: 10, modelId: 20, presentNormalizedCodes: [],
    });

    assert.equal(fakeConnection.callsMatching(/UPDATE spaces/i).length, 0);
});

test("divisão: código antigo desaparece, dois novos aparecem → dois espaços novos; o antigo apenas fica 'absent'", async () => {
    respond([
        AUTHORITY_SINGLE,
        [/SELECT \* FROM spaces/i, [[]]],
        [/INSERT INTO spaces/i, (() => { let id = 100; return () => [{ insertId: id++ }]; })()],
        [/INSERT INTO space_bindings/i, [{ insertId: 200 }]],
        [/UPDATE spaces SET status/i, [{}]],
    ]);

    const outcome = await persistSpaceIdentities({
        ...CTX,
        candidates: [cand("gN1", "R-101A", 720), cand("gN2", "R-101B", 721)],
    });

    assert.equal(outcome.diagnostics.created_spaces, 2, "divisão cria dois espaços novos");

    await reconcileSpaceStatusesAfterActivation({
        linkedModelId: 10, modelId: 20, presentNormalizedCodes: outcome.presentNormalizedCodes,
    });

    // sem sucessor automático: nenhuma escrita liga o antigo aos novos
    assert.equal(fakeConnection.callsMatching(/DELETE FROM spaces/i).length, 0);
});

test("fusão: dois códigos desaparecem, um novo aparece → um espaço novo; anteriores preservados", async () => {
    respond([
        AUTHORITY_SINGLE,
        [/SELECT \* FROM spaces/i, [[]]],
        [/INSERT INTO spaces/i, [{ insertId: 130 }]],
        [/INSERT INTO space_bindings/i, [{ insertId: 230 }]],
    ]);

    const outcome = await persistSpaceIdentities({
        ...CTX,
        candidates: [cand("gF", "R-FUNDIDO", 730)],
    });

    assert.equal(outcome.diagnostics.created_spaces, 1);
    assert.equal(fakeConnection.callsMatching(/DELETE FROM spaces/i).length, 0, "os dois anteriores não são tocados");
});

/* -------------------------------------
   COMPENSAÇÃO
------------------------------------- */

test("deleteSpacesWithoutBindings: só remove espaços SEM nenhum binding (guarda NOT EXISTS)", async () => {
    respond([[/DELETE FROM spaces/i, [{}]]]);

    await spaceDb.deleteSpacesWithoutBindings([101, 102]);

    const deletes = fakeConnection.callsMatching(/DELETE FROM spaces/i);
    assert.equal(deletes.length, 2);
    for (const d of deletes) assert.match(d.sql, /NOT EXISTS/i);
});
