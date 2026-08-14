/**
 * TAG-1 V2 — CORREÇÃO C: a PRÉ-VISÃO usa exatamente as mesmas semânticas de
 * identidade de PORTEFÓLIO que a persistência autoritativa.
 *
 * O defeito da V1: a pré-visão do model intake resolvia a identidade com
 * `findAssetIdentity(linked_model_id, tag)` — âmbito de MODELO e comparação de
 * `asset_code` feita no MySQL. Consequência: anunciava "candidato novo" para
 * equipamento que o upload autoritativo iria REUTILIZAR a partir de outro
 * modelo. Pré-visão e persistência a discordar sobre a mesma pergunta.
 *
 * Coberto aqui:
 *  K. a pré-visão VÊ o ativo persistente do portefólio para uma Tag
 *     canonicamente equivalente vinda de OUTRO modelo (já não diz "novo");
 *  L. com MAIS DO QUE UM ativo para a mesma Tag canónica a pré-visão fica
 *     `ambiguous` e NÃO escolhe um arbitrariamente;
 *     — a resolução é de LEITURA pura: sem criação de ativo e sem lock.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { installFakeMySQL, fakeConnection, respond } from "../helpers/fakeDb.ts";

installFakeMySQL();

const { ModelIntakeDatabase } = await import("../../utils/modelIntakeDatabase.ts");
const { canonicalEquipmentTagKey } = await import("../../classification/equipmentTag.ts");
const { classifyPreviewAssetIdentity } = await import("../../modelIntake/modelIntakeService.ts");

const intakeSource = fs.readFileSync("modelIntake/modelIntakeService.ts", "utf8");
const dbSource = fs.readFileSync("utils/modelIntakeDatabase.ts", "utf8");

const db = new ModelIntakeDatabase();

/** Domínio de equipamentos persistentes do portefólio (o que o SQL largo devolve). */
const PORTFOLIO = [
    // criado no linked_model 99 (modelo M1), com a Tag em minúsculas e espaços
    { id: 1, asset_uuid: "uuid-A", asset_code: "  eqp-abc123 ", serial_number: "SN-1", name: "Mesa A" },
    { id: 2, asset_uuid: "uuid-B", asset_code: "EQP-OUTRA", serial_number: null, name: "Outra" },
    { id: 3, asset_uuid: "uuid-C", asset_code: null, serial_number: null, name: "Sem código" },
];

function respondWithPortfolio(rows: any[]) {
    respond([
        [/SELECT DATABASE\(\)/i, [[{ db: "test-db" }]]],
        [/FROM assets[\s\S]*asset_code IS NOT NULL/i, [rows]],
    ]);
}

/* ============ K. a pré-visão vê o portefólio, não só o próprio modelo ============ */

test("K: a resolução da pré-visão encontra o ativo do portefólio por Tag canonicamente equivalente", async () => {
    respondWithPortfolio(PORTFOLIO);

    // O upload vem de OUTRO modelo e a Tag chega com caixa/espaços diferentes.
    const matches = await db.findAssetIdentitiesByCanonicalTag(canonicalEquipmentTagKey(" EQP-ABC123 "));

    assert.deepEqual(matches.map((m: any) => m.asset_uuid), ["uuid-A"],
        "a pré-visão resolve o MESMO ativo que o caminho autoritativo reutilizaria");
});

test("K: a consulta da pré-visão NÃO tem âmbito de linked_model nem canonicaliza no motor", async () => {
    respondWithPortfolio([]);

    await db.findAssetIdentitiesByCanonicalTag("EQP-QUALQUER");

    const query = fakeConnection.callsMatching(/FROM assets[\s\S]*asset_code IS NOT NULL/i)[0]!;
    assert.ok(!/linked_model_id/i.test(query.sql),
        "o predicado de identidade da pré-visão é de PORTEFÓLIO — sem linked_model_id");
    assert.ok(!/UPPER\s*\(/i.test(query.sql), "sem UPPER(): a canonicalização é só do JavaScript");
    assert.ok(!/LIMIT\s+1/i.test(query.sql), "sem LIMIT 1: a ambiguidade tem de ser observável");
});

/* ============ L. ambiguidade: nunca escolher um arbitrariamente ============ */

test("L: >1 ativo com a mesma Tag canónica → a pré-visão devolve TODOS (não escolhe um)", async () => {
    respondWithPortfolio([
        { id: 10, asset_uuid: "uuid-DUP-1", asset_code: "EQP-DUP", serial_number: null, name: "Dup 1" },
        { id: 11, asset_uuid: "uuid-DUP-2", asset_code: "  eqp-dup ", serial_number: null, name: "Dup 2" },
        { id: 12, asset_uuid: "uuid-OUTRO", asset_code: "EQP-OUTRA", serial_number: null, name: "Outra" },
    ]);

    const matches = await db.findAssetIdentitiesByCanonicalTag("EQP-DUP");

    assert.deepEqual(matches.map((m: any) => m.asset_uuid), ["uuid-DUP-1", "uuid-DUP-2"],
        "os DOIS duplicados legados são devolvidos — a camada de dados nunca decide por si");
});

test("L: a pré-visão mapeia >1 correspondência para 'ambiguous' e NÃO resolve um asset_uuid", () => {
    const r = classifyPreviewAssetIdentity([{ asset_uuid: "uuid-DUP-1" }, { asset_uuid: "uuid-DUP-2" }]);

    assert.equal(r.persistentAssetStatus, "ambiguous");
    // Nenhum dos duplicados é eleito como se fosse "o" ativo, tal como o resolver
    // autoritativo devolve `ambiguous` e abre um caso de reconciliação.
    assert.equal(r.current, null);
    // A evidência dos candidatos em conflito é preservada, sem eleger um.
    assert.deepEqual(r.ambiguousAssetUuids, ["uuid-DUP-1", "uuid-DUP-2"]);
    // O construtor do DTO consome ESTA decisão única (não três expressões soltas).
    const preview = intakeSource.slice(intakeSource.indexOf("findAssetIdentitiesByCanonicalTag"));
    assert.match(preview, /const identity = classifyPreviewAssetIdentity\(/);
    assert.match(preview, /persistentUuid: identity\.persistentUuid/);
    assert.match(preview, /persistentAssetStatus: identity\.persistentAssetStatus/);
    assert.match(preview, /ambiguousAssetUuids: identity\.ambiguousAssetUuids/);
});

/* ===== V3. o sentinela "candidate" tem UM só significado: novo recurso persistente =====
 *
 * Defeito corrigido: `ambiguous` e `new` serializavam AMBOS `persistentUuid: "candidate"`,
 * strings idênticas — indistinguíveis para quem consome o JSON e, no ecrã, o mesmo texto
 * literal. "candidate" NUNCA pode significar "por resolver"; a ausência de UUID resolvido
 * é `null`, e não um segundo sentinela textual.
 */

test("V3 EXISTING: status 'existing', UUID real (nem null nem 'candidate'), sem lista de conflito", () => {
    const r = classifyPreviewAssetIdentity([{ asset_uuid: "uuid-A" }]);

    assert.equal(r.persistentAssetStatus, "existing");
    assert.equal(r.persistentUuid, "uuid-A");
    assert.notEqual(r.persistentUuid, null);
    assert.notEqual(r.persistentUuid, "candidate");
    assert.equal(r.ambiguousAssetUuids, null);
});

test("V3 NEW: status 'new', UUID exatamente 'candidate', sem lista de conflito", () => {
    const r = classifyPreviewAssetIdentity([]);

    assert.equal(r.persistentAssetStatus, "new");
    assert.equal(r.persistentUuid, "candidate");
    assert.equal(r.ambiguousAssetUuids, null);
    assert.equal(r.current, null);
});

test("V3 AMBIGUOUS: status 'ambiguous', UUID null, e TODOS os UUID em conflito preservados", () => {
    const conflicting = ["uuid-DUP-1", "uuid-DUP-2", "uuid-DUP-3"];
    const r = classifyPreviewAssetIdentity(conflicting.map((asset_uuid) => ({ asset_uuid })));

    assert.equal(r.persistentAssetStatus, "ambiguous");
    assert.equal(r.persistentUuid, null, "ambíguo não tem UUID persistente resolvido");
    assert.deepEqual(r.ambiguousAssetUuids, conflicting, "nenhuma evidência de conflito é descartada");
});

test("V3 INVARIANTE: 'ambiguous' e persistentUuid === 'candidate' NUNCA podem coocorrer", () => {
    // Prova exaustiva sobre a cardinalidade que decide o estado (0, 1, 2, ... duplicados):
    // a única fonte de `"candidate"` é o ramo `new`, que é mutuamente exclusivo de `ambiguous`.
    for (let n = 0; n <= 6; n++) {
        const r = classifyPreviewAssetIdentity(
            Array.from({ length: n }, (_, i) => ({ asset_uuid: `uuid-${i}` })));

        assert.ok(!(r.persistentAssetStatus === "ambiguous" && r.persistentUuid === "candidate"),
            `combinação proibida observada com ${n} correspondências`);
        // e a correlação completa status ↔ uuid ↔ lista, em todos os casos:
        if (r.persistentAssetStatus === "ambiguous") {
            assert.equal(r.persistentUuid, null);
            assert.equal(r.ambiguousAssetUuids?.length, n);
        } else {
            assert.equal(r.ambiguousAssetUuids, null);
            assert.equal(r.persistentUuid === "candidate", r.persistentAssetStatus === "new");
            assert.notEqual(r.persistentUuid, null);
        }
    }
});

test("V3: o tipo declara persistentAssetStatus OBRIGATÓRIO e persistentUuid anulável", () => {
    const types = fs.readFileSync("modelIntake/modelIntakeTypes.ts", "utf8");
    const asset = types.slice(types.indexOf("export interface PreviewAsset"), types.indexOf("export interface RdfPreview"));

    assert.match(asset, /persistentAssetStatus: "existing" \| "new" \| "ambiguous";/);
    assert.ok(!/persistentAssetStatus\?:/.test(asset), "já não é opcional: o consumidor decide SEMPRE pelo estado");
    assert.match(asset, /ambiguousAssetUuids: string\[\] \| null;/);
    assert.match(asset, /persistentUuid: string \| "candidate" \| null;/);
    // PreviewSpace é um contrato DIFERENTE e deliberadamente binário — intocado.
    const space = types.slice(types.indexOf("export interface PreviewSpace"), types.indexOf("export interface PreviewAsset"));
    assert.match(space, /persistentUuid: string \| "candidate";/);
    assert.ok(!/persistentAssetStatus|ambiguousAssetUuids/.test(space));
});

test("C: a resolução de identidade da pré-visão é de LEITURA pura — sem criação e sem lock", () => {
    const preview = intakeSource.slice(
        intakeSource.indexOf("// ---- ASSET preview"), intakeSource.indexOf("const rdfPreview"));

    assert.ok(!/INSERT INTO assets/i.test(preview), "a pré-visão nunca cria um ativo");
    assert.ok(!/withEquipmentTagIdentityLock/.test(preview),
        "o lock protege a escrita create-se-ausente, nunca uma exibição de leitura");
    assert.ok(!/createAsset/.test(preview));
    // O caminho model-scoped da V1 desapareceu por completo.
    assert.ok(!/findAssetIdentity\(/.test(intakeSource), "o lookup model-scoped da V1 já não existe");
    assert.ok(!/findAssetIdentity\(/.test(dbSource));
    assert.ok(!/\.trim\(\)\.toUpperCase\(\)/.test(preview),
        "a pré-visão já não tem uma canonicalização própria — delega em canonicalEquipmentTagKey");
    assert.match(preview, /canonicalEquipmentTagKey\(element\.tag\)/);
});
