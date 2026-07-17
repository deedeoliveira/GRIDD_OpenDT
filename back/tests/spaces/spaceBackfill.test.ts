/**
 * Testes do backfill de espaços (Prompt 3) — relatório vs aplicação,
 * idempotência e classificação de limitações históricas.
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { installFakeMySQL, fakeConnection, respond } from "../helpers/fakeDb.ts";

installFakeMySQL();
process.env.IFCOPENSHELL_FLASK_API_ROUTE ??= "http://flask.test/api";

const { runSpacesBackfill } = await import("../../scripts/backfillSpaces.ts");

const realFetch = globalThis.fetch;
let fetchCalls: string[] = [];
let inventoryPayload: any = {};

after(() => { (globalThis as any).fetch = realFetch; });

beforeEach(() => {
    fakeConnection.reset();
    fetchCalls = [];
    inventoryPayload = {
        "guid-1": { spaceGuid: "guid-1", spaceName: "Sala", spaceLongName: "Sala Longa", psets: { Pset_SpaceCommon: { Reference: "R-1" } }, elements: [] },
        "guid-2": { spaceGuid: "guid-2", spaceName: "SemCod", psets: {}, elements: [] },
    };
    (globalThis as any).fetch = async (url: any) => {
        fetchCalls.push(String(url));
        return { ok: true, json: async () => ({ data: inventoryPayload }) };
    };
});

function versionsRoute(rows: any[]): [RegExp, any] {
    return [/FROM model_versions v[\s\S]*INNER JOIN models m/i, [rows]];
}

const V_OK = { id: 5, model_id: 1, version_number: 1, status: "active", storage_key: "models/1/versions/5/model.ifc", linked_model_id: 10 };

test("--report não escreve nada (nem spaces nem bindings)", async () => {
    respond([
        versionsRoute([V_OK]),
        [/FROM entities/i, [[{ id: 700, guid: "guid-1", name: "Sala" }]]],
        [/SELECT id FROM space_bindings WHERE entity_id/i, [[]]],
        [/SELECT id FROM spaces/i, [[]]],
    ]);

    await runSpacesBackfill(false);

    assert.equal(fakeConnection.callsMatching(/INSERT INTO/i).length, 0);
    assert.equal(fakeConnection.callsMatching(/UPDATE /i).length, 0);
});

test("--apply cria espaço e binding apenas para códigos verificáveis; missing é diagnosticado", async () => {
    respond([
        versionsRoute([V_OK]),
        [/FROM entities/i, [[{ id: 700, guid: "guid-1" }, { id: 701, guid: "guid-2" }]]],
        [/SELECT id FROM space_bindings WHERE entity_id/i, [[]]],
        [/SELECT id FROM spaces/i, [[]]],
        [/INSERT INTO spaces/i, [{ insertId: 50 }]],
        [/INSERT INTO space_bindings/i, [{ insertId: 60 }]],
    ]);

    await runSpacesBackfill(true);

    assert.equal(fakeConnection.callsMatching(/INSERT INTO spaces/i).length, 1, "só guid-1 tem código");
    assert.equal(fakeConnection.callsMatching(/INSERT INTO space_bindings/i).length, 1);
});

test("segunda execução é no-op: binding existente → already_bound, sem INSERT", async () => {
    respond([
        versionsRoute([V_OK]),
        [/FROM entities/i, [[{ id: 700, guid: "guid-1" }]]],
        [/SELECT id FROM space_bindings WHERE entity_id/i, [[{ id: 60 }]]],
    ]);

    await runSpacesBackfill(true);

    assert.equal(fakeConnection.callsMatching(/INSERT INTO/i).length, 0);
});

test("versão failed não é reprocessada; storage_key NULL → source_file_unavailable (sem fetch)", async () => {
    respond([
        versionsRoute([
            { ...V_OK, id: 6, status: "failed" },
            { ...V_OK, id: 7, storage_key: null },
        ]),
    ]);

    await runSpacesBackfill(true);

    assert.equal(fetchCalls.length, 0, "nenhum reprocessamento");
    assert.equal(fakeConnection.callsMatching(/INSERT INTO/i).length, 0);
});

test("duplicados na mesma versão histórica: diagnóstico, sem binding, sem falhar a execução", async () => {
    inventoryPayload = {
        "g1": { spaceGuid: "g1", spaceName: "A", psets: { Pset_SpaceCommon: { Reference: "R-DUP" } }, elements: [] },
        "g2": { spaceGuid: "g2", spaceName: "B", psets: { Pset_SpaceCommon: { Reference: "R-DUP" } }, elements: [] },
    };
    respond([
        versionsRoute([V_OK]),
        [/FROM entities/i, [[{ id: 700, guid: "g1" }, { id: 701, guid: "g2" }]]],
    ]);

    await runSpacesBackfill(true);

    assert.equal(fakeConnection.callsMatching(/INSERT INTO/i).length, 0, "nenhuma escolha silenciosa");
});

test("reprocessamento usa o fluxo Node–Python existente (download da versão via path=)", async () => {
    respond([
        versionsRoute([V_OK]),
        [/FROM entities/i, [[{ id: 700, guid: "guid-1" }]]],
        [/SELECT id FROM space_bindings WHERE entity_id/i, [[]]],
        [/SELECT id FROM spaces/i, [[]]],
        [/INSERT INTO spaces/i, [{ insertId: 50 }]],
        [/INSERT INTO space_bindings/i, [{ insertId: 60 }]],
    ]);

    await runSpacesBackfill(true);

    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0]!, /\/model\/inventory\/1/, "endpoint Flask existente");
});
