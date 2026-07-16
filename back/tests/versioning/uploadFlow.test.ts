/**
 * Testes do fluxo de upload por etapas (Prompt 2) — modelUploadService.
 *
 * BD falsa (fakeDb) + fetch do Flask simulado + sistema de ficheiros real
 * (storage root gitignored, ids de teste altos, limpeza garantida).
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { installFakeMySQL, fakeConnection, respond } from "../helpers/fakeDb.ts";

installFakeMySQL();
process.env.IFCOPENSHELL_FLASK_API_ROUTE ??= "http://flask.test/api";
process.env.PORT ??= "3001";

const { handleModelUpload } = await import("../../services/modelUploadService.ts");
const providers = await import("../../policies/policyProvider.ts");
const { STORAGE_ROOT, resolveStorageKey } = await import("../../utils/storage.ts");

const MODEL_ID = 999101;
const VERSION_ID = 999201;

const INVENTORY = {
    "space-g": { spaceGuid: "space-g", spaceName: "Sala", elements: [
        { guid: "elem-g", type: "IfcFurniture", name: "Mesa" },
        { guid: "sensor-g", type: "IfcSensor", name: "Sensor" },
    ]},
};

/* ---- fetch do Flask simulado ---- */
const realFetch = globalThis.fetch;
let fetchCalls: { url: string; body: string | null }[] = [];
let fetchBehavior: () => any = () => ({ ok: true, json: async () => ({ data: INVENTORY }) });

function installFakeFetch() {
    (globalThis as any).fetch = async (url: any, opts: any) => {
        fetchCalls.push({ url: String(url), body: opts?.body ?? null });
        return fetchBehavior();
    };
}

after(() => {
    (globalThis as any).fetch = realFetch;
    fs.rmSync(path.join(STORAGE_ROOT, `models/${MODEL_ID}`), { recursive: true, force: true });
});

function makeTempIfc(): string {
    const p = path.join(os.tmpdir(), `oswadt-upload-${Date.now()}-${Math.random().toString(36).slice(2)}.ifc`);
    fs.writeFileSync(p, "ISO-10303-21; conteudo de teste");
    return p;
}

/** Rotas de BD para um fluxo completo bem-sucedido (revisão de modelo existente). */
function successRoutes(overrides: Partial<Record<string, any>> = {}): [RegExp, any][] {
    let entityId = 100;
    return [
        [/SELECT\s+id,[\s\S]*FROM models[\s\S]*WHERE id = :id/i, [[{ id: MODEL_ID, name: "M", linked_parent_id: 7 }]]],
        [/SELECT id FROM models WHERE id = :modelId FOR UPDATE/i, [[{ id: MODEL_ID }]]],
        [/COALESCE\(MAX\(version_number\), 0\) \+ 1/i, [[{ next: 2 }]]],
        [/INSERT INTO model_versions/i, overrides.insertVersion ?? [{ insertId: VERSION_ID }]],
        [/UPDATE model_versions SET storage_key/i, [{}]],
        [/SELECT COUNT\(\*\) as count[\s\S]*FROM entities/i, [[{ count: 0 }]]],
        [/INSERT INTO entities/i, overrides.insertEntities ?? (() => [{ insertId: entityId++ }])],
        [/INSERT INTO assets/i, overrides.insertAssets ?? [{ insertId: 500 }]],
        [/SELECT id, status FROM model_versions WHERE id = :versionId AND model_id = :modelId FOR UPDATE/i,
            [[{ id: VERSION_ID, status: "processing" }]]],
        [/SELECT current_version_id FROM models WHERE id = :modelId FOR UPDATE/i, [[{ current_version_id: 42 }]]],
        [/UPDATE model_versions SET status = 'active'/i, overrides.activate ?? [{}]],
        [/UPDATE model_versions SET status = 'archived'/i, [{}]],
        [/UPDATE models SET current_version_id/i, overrides.setCurrent ?? [{}]],
        [/UPDATE model_versions[\s\S]*SET status = 'failed'/i, [{}]],
        [/DELETE FROM (assets|entities)/i, [{}]],
    ];
}

beforeEach(() => {
    fakeConnection.reset();
    providers.resetPolicyProviders();
    fetchCalls = [];
    fetchBehavior = () => ({ ok: true, json: async () => ({ data: INVENTORY }) });
    installFakeFetch();
    fs.rmSync(path.join(STORAGE_ROOT, `models/${MODEL_ID}`), { recursive: true, force: true });
});

/* -------------------------------------
   SUCESSO — nova revisão
------------------------------------- */

test("revisão: reutiliza o model, cria versão 2 imutável, processa o ficheiro DA VERSÃO e ativa", async () => {
    respond(successRoutes());
    const temp = makeTempIfc();

    const result = await handleModelUpload({
        tempFilePath: temp, originalFilename: "ModeloA_rev2.ifc", modelId: MODEL_ID,
    });

    assert.equal(result.isNewModel, false);
    assert.equal(result.versionId, VERSION_ID);
    assert.equal(result.versionNumber, 2);
    assert.equal(result.fileHash.length, 64);

    // não cria novo model nem novo linked_model
    assert.equal(fakeConnection.callsMatching(/INSERT INTO models/i).length, 0);
    assert.equal(fakeConnection.callsMatching(/INSERT INTO linked_models/i).length, 0);

    // metadados de ficheiro na reserva
    const insert = fakeConnection.callsMatching(/INSERT INTO model_versions/i)[0]!;
    assert.equal(insert.params.originalFilename, "ModeloA_rev2.ifc");
    assert.ok(insert.params.fileHash);
    assert.ok(insert.params.fileSize > 0);

    // ficheiro promovido no caminho da versão
    const stored = resolveStorageKey(`models/${MODEL_ID}/versions/${VERSION_ID}/model.ifc`);
    assert.ok(fs.existsSync(stored), "ficheiro imutável da versão existe");

    // o Python recebeu o URL do download DA VERSÃO (não o ficheiro corrente)
    assert.equal(fetchCalls.length, 1);
    assert.ok(fetchCalls[0]!.body?.includes(encodeURIComponent(`/api/model/versions/${VERSION_ID}/download`)));

    // ativação explícita da versão corrente
    assert.equal(fakeConnection.callsMatching(/UPDATE models SET current_version_id/i).length, 1);

    // temporário limpo
    assert.ok(!fs.existsSync(temp), "temporário removido");
});

test("primeiro upload: cria linked_model + model e ativa a versão 1 como corrente", async () => {
    let routes = successRoutes();
    routes = [
        [/INSERT INTO linked_models/i, [{ insertId: 71 }]],
        [/INSERT INTO models/i, [{ insertId: MODEL_ID, affectedRows: 1 }]],
        [/COALESCE\(MAX\(version_number\), 0\) \+ 1/i, [[{ next: 1 }]]],
        [/SELECT current_version_id FROM models WHERE id = :modelId FOR UPDATE/i, [[{ current_version_id: null }]]],
        ...routes,
    ];
    respond(routes);
    const temp = makeTempIfc();

    const result = await handleModelUpload({
        tempFilePath: temp, originalFilename: "Novo.ifc", name: "Novo",
    });

    assert.equal(result.isNewModel, true);
    assert.equal(result.versionNumber, 1);
    assert.equal(fakeConnection.callsMatching(/INSERT INTO linked_models/i).length, 1, "linked_model criado (federação), não usado como versão");
    assert.equal(fakeConnection.callsMatching(/INSERT INTO models/i).length, 1);
    // primeira versão: sem arquivamento de anterior
    assert.equal(fakeConnection.callsMatching(/SET status = 'archived'/i).length, 0);
});

test("política preservada: o upload usa o provider configurado (mock deny-all → nenhum asset criado, upload conclui)", async () => {
    providers.setReservabilityEvaluator({
        evaluate: async () => ({
            decision: "deny", reasons: ["mock"], evaluatorId: "mock", evaluatedAt: new Date().toISOString(),
        }),
    });
    respond(successRoutes());
    const temp = makeTempIfc();

    await handleModelUpload({ tempFilePath: temp, originalFilename: "x.ifc", modelId: MODEL_ID });

    assert.equal(fakeConnection.callsMatching(/INSERT INTO assets/i).length, 0, "decisão veio do provider, não de regra inline");
    assert.equal(fakeConnection.callsMatching(/INSERT INTO entities/i).length, 3, "entities continuam a ser criadas");
});

/* -------------------------------------
   FALHAS — a versão anterior continua corrente
------------------------------------- */

async function expectFailure(temp: string, expected: RegExp, opts: { setCurrentAttempted?: boolean } = {}) {
    await assert.rejects(
        handleModelUpload({ tempFilePath: temp, originalFilename: "x.ifc", modelId: MODEL_ID }),
        expected
    );

    // a versão corrente NUNCA foi efetivamente trocada: ou a troca nunca foi
    // tentada, ou foi tentada dentro da transação de ativação que fez rollback
    if (opts.setCurrentAttempted) {
        assert.ok(fakeConnection.transactions.includes("rollback"), "transação de ativação revertida");
    } else {
        assert.equal(fakeConnection.callsMatching(/UPDATE models SET current_version_id/i).length, 0);
    }
    // compensações: inventário removido + versão marcada failed
    assert.ok(fakeConnection.callsMatching(/DELETE FROM assets/i).length >= 1);
    assert.ok(fakeConnection.callsMatching(/DELETE FROM entities/i).length >= 1);
    const failed = fakeConnection.callsMatching(/SET status = 'failed'/i)[0]!;
    assert.ok(failed, "versão marcada como failed com razão");
    assert.match(String(failed.params.reason), expected);
    // ficheiro promovido removido; temporário limpo
    assert.ok(!fs.existsSync(path.join(STORAGE_ROOT, `models/${MODEL_ID}/versions/${VERSION_ID}`)), "diretório da versão falhada removido");
    assert.ok(!fs.existsSync(temp), "temporário removido");
}

test("falha do Python: versão failed, sem troca de corrente, sem parciais, sem temporários", async () => {
    fetchBehavior = () => ({ ok: false, json: async () => ({}) });
    respond(successRoutes());
    const temp = makeTempIfc();

    await expectFailure(temp, /Error extracting inventory/);
});

test("falha na criação de entidades: snapshot transacional reverte e a compensação limpa tudo", async () => {
    respond(successRoutes({
        insertEntities: () => { throw new Error("entities insert failed"); },
    }));
    const temp = makeTempIfc();

    await expectFailure(temp, /entities insert failed/);
    assert.deepEqual(
        fakeConnection.transactions.filter((t) => t === "rollback").length >= 1, true,
        "snapshot fez rollback"
    );
});

test("falha na criação de ativos: mesmas garantias", async () => {
    respond(successRoutes({
        insertAssets: () => { throw new Error("assets insert failed"); },
    }));
    const temp = makeTempIfc();

    await expectFailure(temp, /assets insert failed/);
});

test("falha na ativação/troca de corrente: inventário completo é removido e a versão fica failed", async () => {
    respond(successRoutes({
        setCurrent: () => { throw new Error("activation failed"); },
    }));
    const temp = makeTempIfc();

    await expectFailure(temp, /activation failed/, { setCurrentAttempted: true });
});

test("falha antes de criar a versão (modelo inexistente): nada é criado", async () => {
    respond([[/SELECT\s+id,[\s\S]*FROM models[\s\S]*WHERE id = :id/i, [[]]]]);
    const temp = makeTempIfc();

    await assert.rejects(
        handleModelUpload({ tempFilePath: temp, originalFilename: "x.ifc", modelId: MODEL_ID }),
        /not found/
    );

    assert.equal(fakeConnection.callsMatching(/INSERT INTO model_versions/i).length, 0);
    assert.equal(fakeConnection.callsMatching(/SET status = 'failed'/i).length, 0);
    assert.ok(!fs.existsSync(temp), "temporário removido mesmo em falha precoce");
});

/* -------------------------------------
   POLÍTICA DE REENVIO DO MESMO FICHEIRO
------------------------------------- */

test("mesmo ficheiro reenviado: cria nova versão (política documentada — sem deduplicação silenciosa)", async () => {
    respond(successRoutes());
    const temp1 = makeTempIfc();
    const r1 = await handleModelUpload({ tempFilePath: temp1, originalFilename: "same.ifc", modelId: MODEL_ID });

    fs.rmSync(path.join(STORAGE_ROOT, `models/${MODEL_ID}`), { recursive: true, force: true });
    fakeConnection.reset();
    respond(successRoutes());

    const temp2 = makeTempIfc();
    const r2 = await handleModelUpload({ tempFilePath: temp2, originalFilename: "same.ifc", modelId: MODEL_ID });

    assert.equal(r1.fileHash, r2.fileHash, "hash idêntico");
    assert.equal(fakeConnection.callsMatching(/INSERT INTO model_versions/i).length, 1, "nova versão criada na 2.ª submissão");
});
