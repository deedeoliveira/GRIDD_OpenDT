/**
 * Testes do versionamento (Prompt 2) — camada de dados modelVersionDatabase.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeMySQL, fakeConnection, respond } from "../helpers/fakeDb.ts";

installFakeMySQL();
const { default: versionDb } = await import("../../utils/modelVersionDatabase.ts");

beforeEach(() => fakeConnection.reset());

const RESERVE_INPUT = {
    modelId: 3,
    originalFilename: "ModeloA.ifc",
    fileHash: "a".repeat(64),
    fileSize: 1234,
};

/* -------------------------------------
   RESERVA DE NÚMERO DE VERSÃO
------------------------------------- */

test("reserveVersion: bloqueia a linha de models (FOR UPDATE), calcula MAX+1 e insere em 'processing' — tudo em transação", async () => {
    respond([
        [/SELECT id FROM models WHERE id = :modelId FOR UPDATE/i, [[{ id: 3 }]]],
        [/COALESCE\(MAX\(version_number\), 0\) \+ 1/i, [[{ next: 4 }]]],
        [/INSERT INTO model_versions/i, [{ insertId: 99 }]],
    ]);

    const result = await versionDb.reserveVersion(RESERVE_INPUT);

    assert.equal(result.versionId, 99);
    assert.equal(result.versionNumber, 4);

    const lock = fakeConnection.callsMatching(/FOR UPDATE/i)[0]!;
    assert.match(lock.sql, /FROM models/i);

    const insert = fakeConnection.callsMatching(/INSERT INTO model_versions/i)[0]!;
    assert.match(insert.sql, /'processing'/);
    assert.equal(insert.params.versionNumber, 4);
    assert.equal(insert.params.originalFilename, "ModeloA.ifc");
    assert.equal(insert.params.fileHash, "a".repeat(64));
    assert.equal(insert.params.fileSize, 1234);

    assert.deepEqual(fakeConnection.transactions, ["begin", "commit"]);
});

test("reserveVersion: modelo inexistente → erro e rollback", async () => {
    respond([[/SELECT id FROM models WHERE id = :modelId FOR UPDATE/i, [[]]]]);

    await assert.rejects(versionDb.reserveVersion(RESERVE_INPUT), /Model with id 3 not found/);
    assert.deepEqual(fakeConnection.transactions, ["begin", "rollback"]);
});

test("reserveVersion: colisão de concorrência no UNIQUE(model_id, version_number) → retry único com novo número", async () => {
    let insertAttempts = 0;
    let nextNumber = 4;
    respond([
        [/SELECT id FROM models WHERE id = :modelId FOR UPDATE/i, [[{ id: 3 }]]],
        [/COALESCE\(MAX\(version_number\), 0\) \+ 1/i, () => [[{ next: nextNumber++ }]]],
        [/INSERT INTO model_versions/i, () => {
            insertAttempts++;
            if (insertAttempts === 1) {
                const err: any = new Error("Duplicate entry '3-4' for key 'uq_model_version_number'");
                err.code = "ER_DUP_ENTRY";
                throw err;
            }
            return [{ insertId: 100 }];
        }],
    ]);

    const result = await versionDb.reserveVersion(RESERVE_INPUT);

    assert.equal(insertAttempts, 2, "retry único após conflito");
    assert.equal(result.versionNumber, 5, "número reatribuído no retry");
    assert.deepEqual(fakeConnection.transactions, ["begin", "rollback", "begin", "commit"]);
});

/* -------------------------------------
   ATIVAÇÃO E VERSÃO CORRENTE
------------------------------------- */

function activationRoutes(previousCurrentId: number | null, status = "processing"): [RegExp, any][] {
    return [
        [/SELECT id, status FROM model_versions WHERE id = :versionId AND model_id = :modelId FOR UPDATE/i,
            [[{ id: 99, status }]]],
        [/SELECT current_version_id FROM models WHERE id = :modelId FOR UPDATE/i,
            [[{ current_version_id: previousCurrentId }]]],
        [/UPDATE model_versions SET status = 'active'/i, [{}]],
        [/UPDATE model_versions SET status = 'archived'/i, [{}]],
        [/UPDATE models SET current_version_id/i, [{}]],
    ];
}

test("activateVersion: ativa a nova, arquiva a anterior corrente e atualiza models.current_version_id numa transação", async () => {
    respond(activationRoutes(42));

    await versionDb.activateVersion(3, 99);

    const activate = fakeConnection.callsMatching(/SET status = 'active'/i)[0]!;
    assert.match(activate.sql, /activated_at = NOW\(\)/);
    assert.equal(activate.params.versionId, 99);

    const archive = fakeConnection.callsMatching(/SET status = 'archived'/i)[0]!;
    assert.equal(archive.params.previousId, 42);

    const setCurrent = fakeConnection.callsMatching(/UPDATE models SET current_version_id/i)[0]!;
    assert.equal(setCurrent.params.versionId, 99);

    assert.deepEqual(fakeConnection.transactions, ["begin", "commit"]);
});

test("activateVersion: primeira versão de um modelo (sem corrente anterior) não emite UPDATE de arquivo", async () => {
    respond(activationRoutes(null));

    await versionDb.activateVersion(3, 99);

    assert.equal(fakeConnection.callsMatching(/SET status = 'archived'/i).length, 0);
    assert.equal(fakeConnection.callsMatching(/UPDATE models SET current_version_id/i).length, 1);
});

test("activateVersion: versão 'failed' NUNCA pode tornar-se corrente", async () => {
    respond(activationRoutes(null, "failed"));

    await assert.rejects(
        versionDb.activateVersion(3, 99),
        /Only a version in 'processing' state can be activated/
    );

    assert.equal(fakeConnection.callsMatching(/UPDATE models SET current_version_id/i).length, 0);
    assert.deepEqual(fakeConnection.transactions, ["begin", "rollback"]);
});

test("activateVersion: versão já 'active' não é reativada (proteção contra dupla ativação)", async () => {
    respond(activationRoutes(null, "active"));

    await assert.rejects(versionDb.activateVersion(3, 99), /Only a version in 'processing' state/);
});

test("markFailed: marca failed com razão e limpa storage_key; não toca na versão corrente", async () => {
    respond([[/UPDATE model_versions/i, [{}]]]);

    await versionDb.markFailed(99, "processing: boom");

    const update = fakeConnection.callsMatching(/SET status = 'failed'/i)[0]!;
    assert.match(update.sql, /failure_reason = :reason/);
    assert.match(update.sql, /storage_key = NULL/);
    assert.equal(update.params.reason, "processing: boom");

    assert.equal(fakeConnection.callsMatching(/current_version_id/i).length, 0);
});

/* -------------------------------------
   CONSULTAS
------------------------------------- */

test("getCurrentVersion: resolve via models.current_version_id — nunca por ORDER BY id DESC", async () => {
    respond([[/INNER JOIN model_versions v ON v\.id = m\.current_version_id/i,
        [[{ id: 8, model_id: 3, version_number: 4, status: "active" }]]]]);

    const current = await versionDb.getCurrentVersion(3);
    assert.equal(current.id, 8);

    const query = fakeConnection.calls[0]!;
    assert.match(query.sql, /current_version_id/);
    assert.doesNotMatch(query.sql, /ORDER BY id DESC/i);
});

test("getVersionsByModel: lista ordenada por version_number com flag is_current", async () => {
    respond([[/FROM model_versions v[\s\S]*WHERE v\.model_id = :modelId/i,
        [[{ id: 5, version_number: 1, is_current: 0 }, { id: 8, version_number: 4, is_current: 1 }]]]]);

    const versions = await versionDb.getVersionsByModel(3);
    assert.equal(versions.length, 2);

    const query = fakeConnection.calls[0]!;
    assert.match(query.sql, /ORDER BY v\.version_number ASC/);
    assert.match(query.sql, /v\.id = m\.current_version_id/);
});

test("getVersionById: devolve null quando não existe", async () => {
    respond([[/WHERE v\.id = :versionId/i, [[]]]]);
    assert.equal(await versionDb.getVersionById(12345), null);
});
