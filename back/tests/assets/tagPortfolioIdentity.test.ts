/**
 * TAG-1 — IfcElement.Tag como chave de identidade persistente de PORTEFÓLIO.
 *
 * Mudança de ÂMBITO da identidade (e só isso): o predicado de correspondência
 * passa de `(linked_model_id, asset_code)` para `canonical(asset_code)` em todo
 * o portefólio. NÃO é uma reclassificação do que conta como equipamento, nem
 * uma alteração de IDS/ontologia, nem uma migração de esquema.
 *
 * Invariantes cobertas aqui:
 *  - correspondência global: o linked_model_id NÃO entra no predicado;
 *  - reutilização entre modelos NUNCA muta linked_model_id/asset_code/asset_uuid;
 *  - duplicados legados (>1 com a mesma Tag canónica) falham FECHADO em
 *    ambiguidade, com evidência de todos os candidatos — nunca fundidos;
 *  - equivalência canónica (maiúsculas/espaços) decidida em JavaScript, nunca
 *    pela collation do MySQL;
 *  - o GlobalId é manifestação, nunca identidade: reaparecer com outra Tag
 *    canónica é conflito, não reatribuição silenciosa;
 *  - presença simultânea em duas linhas de modelo CORRENTES → reconciliação;
 *  - a secção crítica de identidade está sob lock consultivo por Tag canónica,
 *    libertado também em caso de falha;
 *  - regressões: reservas, localização por binding, projeção semântica e
 *    compensação de upload permanecem inalteradas.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeMySQL, fakeConnection, respond } from "../helpers/fakeDb.ts";

installFakeMySQL();

const { IfcTagSerialAssetIdentityResolver } = await import("../../identity/ifcTagSerialAssetIdentityResolver.ts");
const { persistAssetsForVersion } = await import("../../services/assetInventoryService.ts");
const persistentAssetDb = (await import("../../utils/persistentAssetDatabase.ts")).default;
const { equipmentTagIdentityLockName } = await import("../../utils/persistentAssetDatabase.ts");
const { canonicalEquipmentTagKey, normalizeEquipmentTag } = await import("../../classification/equipmentTag.ts");
const providers = await import("../../policies/policyProvider.ts");
const identityProvider = await import("../../identity/assetIdentityProvider.ts");
const classifierProvider = await import("../../classification/equipmentClassifierProvider.ts");

import type { AssetIdentityLookup } from "../../identity/assetIdentityTypes.ts";

/** Lookup falso: por omissão o portefólio está vazio. */
function makeLookup(overrides: Partial<AssetIdentityLookup> = {}): AssetIdentityLookup {
    return {
        findEquipmentByTag: async () => [],
        findEquipmentBySerial: async () => [],
        findEquipmentByGuidHistory: async () => [],
        findCurrentModelPresence: async () => [],
        ...overrides,
    };
}

/** Modelo A (linked_model 10) — o modelo de onde vem o upload nestes testes. */
const CONTEXT = { linkedModelId: 10, modelId: 20, modelVersionId: 9 };
/** Modelo B (linked_model 99 / model 88) — outra linha de modelo do portefólio. */
const OTHER_MODEL_CONTEXT = { linkedModelId: 99, modelId: 88, modelVersionId: 77 };

const CANDIDATE = {
    guid: "guid-1", name: "Betoneira 01", ifcType: "IfcBuildingElementProxy",
    tag: "EQP-000123", objectType: "Betoneira Diesel", psets: null, entityId: 101, spaceId: 7,
};

beforeEach(() => {
    fakeConnection.reset();
    providers.resetPolicyProviders();
    identityProvider.resetAssetIdentityResolver();
    classifierProvider.resetEquipmentClassifier();
    delete process.env.ASSET_IDENTITY_PROVIDER;
});

/* =====================================================================
   1. CHAVE CANÓNICA — determinística, independente do motor
   ===================================================================== */

test("chave canónica = aparar + maiúsculas; o valor PERSISTIDO continua a ser só aparado", () => {
    assert.equal(canonicalEquipmentTagKey("  eqp-000123  "), "EQP-000123");
    assert.equal(canonicalEquipmentTagKey("EQP-000123"), "EQP-000123");
    assert.equal(canonicalEquipmentTagKey("  EQP-000123"), "EQP-000123");

    // A representação de exibição/persistência NÃO é alterada pela canonicalização:
    // asset_code preserva as maiúsculas/minúsculas escolhidas pelo gestor.
    assert.equal(normalizeEquipmentTag("  eqp-000123  "), "eqp-000123");
    assert.notEqual(normalizeEquipmentTag("eqp-000123"), canonicalEquipmentTagKey("eqp-000123"));
});

/**
 * NOTA: `isValidEquipmentTag` exige o prefixo `EQP-` em MAIÚSCULAS (regra
 * case-sensitive pré-existente, deliberadamente FORA do âmbito de TAG-1). Por
 * isso a equivalência de caixa é exercida no SUFIXO da Tag, que é onde ela pode
 * realmente ocorrer em Tags válidas.
 */
test("equivalência canónica: 'EQP-ABC123' e '  EQP-abc123 ' correspondem ao MESMO ativo", async () => {
    const seen: string[] = [];
    const resolver = new IfcTagSerialAssetIdentityResolver(makeLookup({
        findEquipmentByTag: async (canonicalTag: string) => {
            seen.push(canonicalTag);
            return canonicalTag === "EQP-ABC123"
                ? [{ id: 77, asset_code: "EQP-ABC123", serial_number: null, linked_model_id: 10 }] : [];
        },
    }));

    const a = await resolver.resolve({ ...CANDIDATE, tag: "EQP-ABC123" }, CONTEXT);
    const b = await resolver.resolve({ ...CANDIDATE, tag: "  EQP-abc123 " }, CONTEXT);

    assert.deepEqual(seen, ["EQP-ABC123", "EQP-ABC123"], "o lookup recebe SEMPRE a chave canónica");
    assert.equal(a.matchedAssetId, 77);
    assert.equal(b.matchedAssetId, 77, "diferença de caixa/espaços não cria uma segunda identidade");
    assert.equal(b.stableCode, "EQP-abc123", "o stableCode persistido mantém a forma original aparada");
});

/* =====================================================================
   2. CORRESPONDÊNCIA DE PORTEFÓLIO — linked_model_id fora do predicado
   ===================================================================== */

/**
 * O predicado de IDENTIDADE (a Tag) nunca recebe âmbito de modelo. A consulta de
 * EVIDÊNCIA SECUNDÁRIA por serial recebe-o deliberadamente (V2, correção B) — o
 * que a TAG-1 proíbe é `linked_model_id` no predicado de identidade, não a sua
 * presença numa heurística secundária que nunca decide identidade.
 */
test("o predicado de identidade NÃO recebe linked_model_id (assinatura de um só argumento)", async () => {
    const tagArgs: any[][] = [];
    const serialArgs: any[][] = [];
    const resolver = new IfcTagSerialAssetIdentityResolver(makeLookup({
        findEquipmentByTag: async (...a: any[]) => { tagArgs.push(a); return []; },
        findEquipmentBySerial: async (...a: any[]) => { serialArgs.push(a); return []; },
    }));

    await resolver.resolve({ ...CANDIDATE, psets: { Pset_ManufacturerOccurrence: { SerialNumber: "SN-1" } } }, CONTEXT);

    assert.ok(tagArgs.length > 0, "a identidade pela Tag foi consultada");
    for (const call of tagArgs) {
        assert.equal(call.length, 1, "o lookup de IDENTIDADE recebe só a chave canónica — nunca um âmbito de modelo");
        assert.notEqual(call[0], CONTEXT.linkedModelId);
    }
    assert.deepEqual(serialArgs, [["SN-1", CONTEXT.linkedModelId]],
        "a evidência secundária por serial é escopada ao linked_model (nunca de portefólio)");
});

test("CASE B: mesma Tag, ativo de OUTRO linked_model, GlobalId novo → reutiliza a mesma identidade", async () => {
    const resolver = new IfcTagSerialAssetIdentityResolver(makeLookup({
        // O ativo foi criado no linked_model 99; o upload vem do linked_model 10.
        findEquipmentByTag: async () => [{ id: 77, asset_code: "EQP-000123", serial_number: null, linked_model_id: 99 }],
    }));

    const result = await resolver.resolve({ ...CANDIDATE, guid: "guid-NOVO" }, CONTEXT);

    assert.equal(result.status, "matched", "a origem noutro modelo não impede a correspondência");
    assert.equal(result.matchedAssetId, 77);
    assert.equal(result.method, "equipment_tag");
});

test("CASE A: mesma Tag, mesmo modelo, GlobalId novo → reutiliza (comportamento preservado)", async () => {
    const resolver = new IfcTagSerialAssetIdentityResolver(makeLookup({
        findEquipmentByTag: async () => [{ id: 77, asset_code: "EQP-000123", serial_number: null, linked_model_id: 10 }],
    }));

    const result = await resolver.resolve({ ...CANDIDATE, guid: "guid-OUTRO" }, CONTEXT);
    assert.equal(result.status, "matched");
    assert.equal(result.matchedAssetId, 77);
});

test("a decisão é idêntica seja qual for o linked_model do upload (mesma Tag, mesmo ativo)", async () => {
    const lookup = makeLookup({
        findEquipmentByTag: async () => [{ id: 77, asset_code: "EQP-000123", serial_number: null, linked_model_id: 1234 }],
    });
    const resolver = new IfcTagSerialAssetIdentityResolver(lookup);

    const fromA = await resolver.resolve(CANDIDATE, CONTEXT);
    const fromB = await resolver.resolve(CANDIDATE, OTHER_MODEL_CONTEXT);

    assert.equal(fromA.matchedAssetId, fromB.matchedAssetId, "identidade é do portefólio, não do modelo");
    assert.equal(fromA.status, fromB.status);
});

/* =====================================================================
   3. DUPLICADOS LEGADOS — falha FECHADA, evidência preservada
   ===================================================================== */

test("CASE 7: >1 ativo persistente com a mesma Tag canónica → ambiguidade com TODOS os candidatos", async () => {
    const resolver = new IfcTagSerialAssetIdentityResolver(makeLookup({
        findEquipmentByTag: async () => [
            { id: 1, asset_code: "EQP-000123", serial_number: null, linked_model_id: 10 },
            { id: 2, asset_code: "eqp-000123", serial_number: null, linked_model_id: 99 },
            { id: 3, asset_code: "EQP-000123", serial_number: null, linked_model_id: 7 },
        ],
    }));

    const result = await resolver.resolve(CANDIDATE, CONTEXT);

    assert.equal(result.status, "ambiguous");
    assert.equal(result.matchedAssetId, null, "nunca escolhe automaticamente");
    assert.ok(result.reasons.some((r) => /tag_conflict/.test(r)));
    assert.deepEqual(result.candidatesConsidered.map((c) => c.assetId), [1, 2, 3],
        "evidência de TODOS os duplicados preservada para identificação posterior");
    assert.ok(result.reasons.some((r) => /never merged automatically/i.test(r)));
});

test("duplicados legados que diferem só na caixa são detetados como duplicados (não como Tags distintas)", async () => {
    const resolver = new IfcTagSerialAssetIdentityResolver(makeLookup({
        findEquipmentByTag: async () => [
            { id: 1, asset_code: "EQP-ABC", serial_number: null, linked_model_id: 10 },
            { id: 2, asset_code: "eqp-abc", serial_number: null, linked_model_id: 10 },
        ],
    }));

    const result = await resolver.resolve({ ...CANDIDATE, tag: "EQP-ABC" }, CONTEXT);
    assert.equal(result.status, "ambiguous");
    assert.equal(result.candidatesConsidered.length, 2);
});

/* =====================================================================
   4. GLOBALID — manifestação, nunca identidade
   ===================================================================== */

test("mesmo GlobalId + Tag canónica DIFERENTE → ambiguidade; sem reatribuição e sem mutar o asset_code original", async () => {
    const resolver = new IfcTagSerialAssetIdentityResolver(makeLookup({
        findEquipmentByTag: async () => [],
        // O GlobalId G1 já manifestou o ativo A (Tag T1); agora chega com a Tag T2.
        findEquipmentByGuidHistory: async () => [{ id: 42, asset_code: "EQP-T1", serial_number: null, linked_model_id: 10 }],
    }));

    const result = await resolver.resolve({ ...CANDIDATE, guid: "G1", tag: "EQP-T2" }, CONTEXT);

    assert.equal(result.status, "ambiguous");
    assert.equal(result.matchedAssetId, null, "a manifestação NUNCA é reatribuída em silêncio");
    assert.ok(result.reasons.some((r) => /globalid_tag_conflict/.test(r)));
    assert.ok(result.candidatesConsidered.some((c) => c.assetId === 42 && c.via === "globalid_history"));
    // O resolver não tem qualquer caminho de escrita: não pode mutar A.asset_code.
    assert.equal(fakeConnection.callsMatching(/UPDATE assets/i).length, 0);
});

test("mesmo GlobalId, Tag nova que JÁ pertence a outro ativo B → evidência de A e B, sem fusão", async () => {
    const resolver = new IfcTagSerialAssetIdentityResolver(makeLookup({
        findEquipmentByTag: async () => [{ id: 55, asset_code: "EQP-T2", serial_number: null, linked_model_id: 99 }],
        findEquipmentByGuidHistory: async () => [{ id: 42, asset_code: "EQP-T1", serial_number: null, linked_model_id: 10 }],
    }));

    const result = await resolver.resolve({ ...CANDIDATE, guid: "G1", tag: "EQP-T2" }, CONTEXT);

    assert.equal(result.status, "ambiguous");
    assert.equal(result.matchedAssetId, null);
    const ids = result.candidatesConsidered.map((c) => c.assetId).sort();
    assert.deepEqual(ids, [42, 55], "evidência preservada para AMBOS os ativos, sem escolher nem fundir");
});

test("mesma Tag canónica + GlobalId novo NÃO é conflito: histórico coerente → reutilização normal", async () => {
    const resolver = new IfcTagSerialAssetIdentityResolver(makeLookup({
        findEquipmentByTag: async () => [{ id: 77, asset_code: "EQP-000123", serial_number: null, linked_model_id: 99 }],
        // O mesmo ativo já manifestou noutro GlobalId, mas com a MESMA Tag canónica.
        findEquipmentByGuidHistory: async () => [],
    }));

    const result = await resolver.resolve({ ...CANDIDATE, guid: "G2" }, CONTEXT);
    assert.equal(result.status, "matched");
    assert.equal(result.matchedAssetId, 77);
});

test("histórico de GlobalId com a MESMA Tag canónica (caixa diferente) não é tratado como conflito", async () => {
    const resolver = new IfcTagSerialAssetIdentityResolver(makeLookup({
        findEquipmentByTag: async () => [{ id: 77, asset_code: "eqp-000123", serial_number: null, linked_model_id: 10 }],
        findEquipmentByGuidHistory: async () => [{ id: 77, asset_code: "eqp-000123", serial_number: null, linked_model_id: 10 }],
    }));

    const result = await resolver.resolve({ ...CANDIDATE, tag: "EQP-000123" }, CONTEXT);
    assert.equal(result.status, "matched", "a comparação é canónica, não literal");
    assert.equal(result.matchedAssetId, 77);
});

/* =====================================================================
   5. CASE E — presença simultânea em modelos CORRENTES
   ===================================================================== */

test("CASE E: correspondência já corrente noutra linha de modelo → ambiguidade explícita", async () => {
    const resolver = new IfcTagSerialAssetIdentityResolver(makeLookup({
        findEquipmentByTag: async () => [{ id: 77, asset_code: "EQP-000123", serial_number: null, linked_model_id: 99 }],
        // models.current_version_id do modelo 88 aponta para a versão 77.
        findCurrentModelPresence: async () => [{ model_id: 88, model_version_id: 77 }],
    }));

    const result = await resolver.resolve(CANDIDATE, CONTEXT); // upload no modelo 20

    assert.equal(result.status, "ambiguous");
    assert.equal(result.matchedAssetId, null);
    assert.ok(result.reasons.some((r) => /simultaneous_current_model_presence/.test(r)));
});

test("CASE E não dispara na MESMA linha de modelo: a nova versão sucede a corrente → reutilização normal", async () => {
    const resolver = new IfcTagSerialAssetIdentityResolver(makeLookup({
        findEquipmentByTag: async () => [{ id: 77, asset_code: "EQP-000123", serial_number: null, linked_model_id: 10 }],
        findCurrentModelPresence: async () => [{ model_id: 20, model_version_id: 8 }],
    }));

    const result = await resolver.resolve(CANDIDATE, CONTEXT); // modelId 20 == presença
    assert.equal(result.status, "matched");
    assert.equal(result.matchedAssetId, 77);
});

test("CASE E não dispara contra bindings apenas HISTÓRICOS/superados", async () => {
    const resolver = new IfcTagSerialAssetIdentityResolver(makeLookup({
        findEquipmentByTag: async () => [{ id: 77, asset_code: "EQP-000123", serial_number: null, linked_model_id: 99 }],
        findCurrentModelPresence: async () => [], // nenhum binding na versão corrente
    }));

    const result = await resolver.resolve(CANDIDATE, CONTEXT);
    assert.equal(result.status, "matched", "reutilizar contra histórico é CASE A/B normal");
});

/* =====================================================================
   6. SERIAL — evidência secundária, âmbito alargado
   ===================================================================== */

test("mesma Tag + serial divergente continua a ser serial_conflict (comportamento preservado)", async () => {
    const resolver = new IfcTagSerialAssetIdentityResolver(makeLookup({
        findEquipmentByTag: async () => [{ id: 77, asset_code: "EQP-000123", serial_number: "SN-OLD", linked_model_id: 10 }],
    }));

    const result = await resolver.resolve({
        ...CANDIDATE, psets: { Pset_ManufacturerOccurrence: { SerialNumber: "SN-NEW" } },
    }, CONTEXT);

    assert.equal(result.status, "ambiguous");
    assert.ok(result.reasons.some((r) => /serial_conflict/.test(r)));
});

test("mesmo serial + Tag diferente DENTRO do mesmo linked_model: renumeração → reconciliação", async () => {
    let scopeArg: any = "não chamado";
    const resolver = new IfcTagSerialAssetIdentityResolver(makeLookup({
        findEquipmentByTag: async () => [],
        findEquipmentBySerial: async (...a: any[]) => {
            scopeArg = a;
            // Mesma linha de modelo (10): é aqui que "mudei a Tag mas mantive o
            // serial" acontece de facto, entre versões do mesmo modelo.
            return [{ id: 88, asset_code: "EQP-OUTRA", serial_number: "SN-9", linked_model_id: 10 }];
        },
    }));

    const result = await resolver.resolve({
        ...CANDIDATE, tag: "EQP-NOVA", psets: { Pset_ManufacturerOccurrence: { SerialNumber: "SN-9" } },
    }, CONTEXT);

    assert.deepEqual(scopeArg, ["SN-9", CONTEXT.linkedModelId],
        "a evidência secundária por serial é consultada COM âmbito de linked_model (V2)");
    assert.equal(result.status, "ambiguous");
    assert.ok(result.reasons.some((r) => /serial_renumbering/.test(r)));
    assert.equal(result.matchedAssetId, null, "o serial NUNCA cria nem reutiliza identidade sozinho");
});

/**
 * TAG-1 V2 — CORREÇÃO B. O serial é evidência SECUNDÁRIA e NÃO tem unicidade de
 * portefólio assumida, logo NUNCA pode ser uma restrição de identidade NEGATIVA
 * de portefólio: um ativo sem qualquer relação (outra Tag, outro modelo, sem
 * histórico de GlobalId comum) não pode vetar a criação limpa de uma Tag nova.
 */
test("V2: serial coincidente num ativo NÃO relacionado de outro modelo NÃO veta a Tag nova", async () => {
    const serialQueries: any[][] = [];
    const resolver = new IfcTagSerialAssetIdentityResolver(makeLookup({
        // Tag T-B não existe em lado nenhum do portefólio.
        findEquipmentByTag: async () => [],
        findEquipmentByGuidHistory: async () => [],   // nenhuma ligação por GlobalId
        findEquipmentBySerial: async (serial: string, linkedModelId: number) => {
            serialQueries.push([serial, linkedModelId]);
            // Ativo A: Tag T-A, serial 12345, criado no linked_model 99 (modelo M1).
            // A consulta é ESCOPADA ao linked_model 10 (M2), logo A não aparece.
            const portfolio = [{ id: 500, asset_code: "EQP-T-A", serial_number: "12345", linked_model_id: 99 }];
            return portfolio.filter((r) => r.linked_model_id === linkedModelId);
        },
    }));

    // Candidato: Tag T-B, MESMO serial 12345, a chegar pelo modelo M2 (linked_model 10).
    const result = await resolver.resolve({
        ...CANDIDATE, tag: "EQP-T-B", guid: "guid-sem-historico",
        psets: { Pset_ManufacturerOccurrence: { SerialNumber: "12345" } },
    }, CONTEXT);

    assert.deepEqual(serialQueries, [["12345", 10]], "a consulta por serial é escopada ao linked_model do candidato");
    assert.equal(result.status, "new", "Tag nova sem correspondência no portefólio → identidade nova, como qualquer outra");
    assert.equal(result.matchedAssetId, null, "NUNCA reutiliza o ativo A (não relacionado)");
    assert.equal(result.stableCode, "EQP-T-B");
    assert.ok(!result.reasons.some((r) => /serial_renumbering/.test(r)),
        "sem aviso de renumeração contra uma Tag não relacionada noutro ponto do portefólio");
});

test("o serial nunca cria identidade: sem Tag válida o resultado é unresolved mesmo com serial conhecido", async () => {
    const resolver = new IfcTagSerialAssetIdentityResolver(makeLookup({
        findEquipmentBySerial: async () => [{ id: 5, asset_code: "EQP-5", serial_number: "SN-9", linked_model_id: 10 }],
    }));

    const result = await resolver.resolve({
        ...CANDIDATE, tag: null, psets: { Pset_ManufacturerOccurrence: { SerialNumber: "SN-9" } },
    }, CONTEXT);

    assert.equal(result.status, "unresolved");
    assert.equal(result.matchedAssetId, null);
});

/* =====================================================================
   7. TAG AUSENTE/INVÁLIDA — inalterado
   ===================================================================== */

test("Tag ausente/inválida: comportamento inalterado (unresolved, sem consultar o portefólio)", async () => {
    for (const tag of [null, "", "   ", "SEM-PREFIXO-1", "EQP-"]) {
        let consulted = false;
        const resolver = new IfcTagSerialAssetIdentityResolver(makeLookup({
            findEquipmentByTag: async () => { consulted = true; return []; },
        }));

        const result = await resolver.resolve({ ...CANDIDATE, tag }, CONTEXT);
        assert.equal(result.status, "unresolved", `tag ${JSON.stringify(tag)}`);
        assert.equal(consulted, false, "sem Tag válida não se consulta a identidade");
    }
});

/* =====================================================================
   8. CARACTERIZAÇÃO — TAG-1 não mexeu na elegibilidade nem na não-identidade
   ===================================================================== */

test("caracterização: ObjectType e Manufacturer continuam SEM participar da identidade", async () => {
    const resolver = new IfcTagSerialAssetIdentityResolver(makeLookup({
        findEquipmentByTag: async () => [{ id: 77, asset_code: "EQP-000123", serial_number: null, linked_model_id: 99 }],
    }));

    const a = await resolver.resolve({ ...CANDIDATE, objectType: "Tipo A" }, CONTEXT);
    const b = await resolver.resolve({
        ...CANDIDATE, objectType: "Tipo Totalmente Outro",
        psets: { Pset_ManufacturerTypeInformation: { Manufacturer: "Outro Fabricante" } },
    }, CONTEXT);

    assert.equal(a.matchedAssetId, 77);
    assert.equal(b.matchedAssetId, 77, "nem ObjectType nem Manufacturer alteram a correspondência");
});

test("caracterização: a regra de validade da Tag (prefixo EQP-) mantém-se exatamente como estava", async () => {
    // TAG-1 é uma mudança de ÂMBITO da identidade — a convenção EQP- é dívida de
    // governança separada e NÃO é alterada aqui.
    const resolver = new IfcTagSerialAssetIdentityResolver(makeLookup());
    assert.equal((await resolver.resolve({ ...CANDIDATE, tag: "EQP-X" }, CONTEXT)).status, "new");
    assert.equal((await resolver.resolve({ ...CANDIDATE, tag: "TAG-X" }, CONTEXT)).status, "unresolved");
});

/* =====================================================================
   9. SERVIÇO: reutilização entre modelos e imutabilidade da linha `assets`
   ===================================================================== */

function baseRoutes(overrides: [RegExp, any][] = []): [RegExp, any][] {
    return [
        ...overrides,
        [/SELECT DATABASE\(\)/i, [[{ db: "test-db" }]]],
        [/FROM assets[\s\S]*asset_code IS NOT NULL/i, [[]]],
        [/FROM assets[\s\S]*serial_number = :serial/i, [[]]],
        [/INSERT INTO assets/i, (() => { let id = 300; return () => [{ insertId: id++ }]; })()],
        [/INSERT INTO asset_bindings/i, [{ insertId: 400 }]],
        [/INSERT INTO asset_reconciliation_cases/i, [{ insertId: 900 }]],
        [/UPDATE assets/i, [{}]],
    ];
}

function equipmentInput(element: Record<string, any>, overrides: Record<string, any> = {}) {
    return {
        linkedModelId: 10, modelId: 20, modelVersionId: 9,
        inventoryData: { "space-A": { spaceGuid: "space-A", spaceName: "Sala A", elements: [element] } },
        spaceEntityIdsByGuid: { "space-A": 100 },
        elementEntityIdsByGuid: { [element.guid]: 101 },
        spaceInfoByGuid: { "space-A": { spaceId: 7, code: "R-A" } },
        ...overrides,
    };
}

test("CASE 8: reutilização entre modelos NÃO muta linked_model_id, asset_code nem asset_uuid", async () => {
    respond(baseRoutes([
        // ativo persistente criado originalmente no linked_model 99
        [/FROM assets[\s\S]*asset_code IS NOT NULL/i,
            [[{ id: 77, asset_code: "EQP-1", serial_number: null, linked_model_id: 99 }]]],
    ]));

    // upload a partir do linked_model 10
    await persistAssetsForVersion(equipmentInput({
        guid: "g-novo", type: "IfcFurniture", name: "Mesa 01", tag: "EQP-1", psets: {},
    }) as any);

    assert.equal(fakeConnection.callsMatching(/INSERT INTO assets/i).length, 0,
        "reutiliza a MESMA linha assets — nunca cria uma segunda");

    // Nenhuma escrita toca a identidade da linha persistente.
    for (const call of fakeConnection.callsMatching(/UPDATE assets/i)) {
        assert.doesNotMatch(call.sql, /linked_model_id\s*=/i, "linked_model_id é metadado de ORIGEM, nunca atualizado");
        assert.doesNotMatch(call.sql, /asset_code\s*=/i, "asset_code nunca é reescrito por reutilização");
        assert.doesNotMatch(call.sql, /asset_uuid\s*=/i, "asset_uuid é imutável");
    }

    const binding = fakeConnection.callsMatching(/INSERT INTO asset_bindings/i)[0]!;
    assert.equal(binding.params.assetId, 77, "o novo binding aponta para a identidade existente");
    assert.equal(binding.params.modelVersionId, 9, "binding com o contexto do upload que chega");
    assert.equal(binding.params.ifcGuid, "g-novo");
    assert.equal(binding.params.spaceId, 7, "localização é do binding, não da linha persistente");
});

test("o binding novo é ADICIONADO: o binding antigo do outro modelo nunca é apagado nem reescrito", async () => {
    respond(baseRoutes([
        [/FROM assets[\s\S]*asset_code IS NOT NULL/i,
            [[{ id: 77, asset_code: "EQP-1", serial_number: null, linked_model_id: 99 }]]],
    ]));

    await persistAssetsForVersion(equipmentInput({
        guid: "g-novo", type: "IfcFurniture", name: "Mesa", tag: "EQP-1", psets: {},
    }) as any);

    assert.equal(fakeConnection.callsMatching(/DELETE/i).length, 0, "nada é apagado por reutilização");
    assert.equal(fakeConnection.callsMatching(/UPDATE asset_bindings/i).length, 0,
        "bindings históricos preservam o seu contexto de modelo");
    assert.equal(fakeConnection.callsMatching(/INSERT INTO asset_bindings/i).length, 1);
});

test("regressão de projeção semântica: a identidade persistente (asset_uuid) é estável entre modelos", async () => {
    // O URI persistente é construído a partir de assets.asset_uuid. Reutilizar a
    // MESMA linha assets entre modelos é precisamente o que mantém esse URI
    // estável — nenhuma linha nova, nenhum uuid novo.
    respond(baseRoutes([
        [/FROM assets[\s\S]*asset_code IS NOT NULL/i,
            [[{ id: 77, asset_code: "EQP-1", serial_number: null, linked_model_id: 99 }]]],
    ]));

    await persistAssetsForVersion(equipmentInput({
        guid: "g-x", type: "IfcFurniture", name: "Mesa", tag: "EQP-1", psets: {},
    }) as any);

    assert.equal(fakeConnection.callsMatching(/INSERT INTO assets/i).length, 0,
        "um novo asset_uuid quebraria o URI persistente — não pode acontecer");
});

test("regressão de localização: a localização vem do binding da versão, nunca de linked_model_id", async () => {
    respond(baseRoutes([
        [/FROM assets[\s\S]*asset_code IS NOT NULL/i,
            [[{ id: 77, asset_code: "EQP-1", serial_number: null, linked_model_id: 99 }]]],
    ]));

    await persistAssetsForVersion(equipmentInput({
        guid: "g-x", type: "IfcFurniture", name: "Mesa", tag: "EQP-1", psets: {},
    }, { spaceInfoByGuid: { "space-A": { spaceId: 4242, code: "R-Z" } } }) as any);

    const binding = fakeConnection.callsMatching(/INSERT INTO asset_bindings/i)[0]!;
    assert.equal(binding.params.spaceId, 4242, "space_id do binding da versão que chega");
});

/* =====================================================================
   10. CONCORRÊNCIA — lock consultivo por Tag canónica
   ===================================================================== */

test("nome do lock: determinístico, por Tag canónica, delimitado à BD e sempre < 64 caracteres", () => {
    const a = equipmentTagIdentityLockName("digital_twin", "EQP-1");
    const b = equipmentTagIdentityLockName("digital_twin", "EQP-1");
    const c = equipmentTagIdentityLockName("digital_twin", "EQP-2");
    const d = equipmentTagIdentityLockName("outra_bd", "EQP-1");

    assert.equal(a, b, "determinístico");
    assert.notEqual(a, c, "Tags diferentes → locks diferentes (processáveis em paralelo)");
    assert.notEqual(a, d, "esquemas diferentes nunca disputam o mesmo lock");

    // A Tag é texto livre do modelador: entra HASHADA, nunca em bruto.
    const longTag = "EQP-" + "X".repeat(5000);
    const long = equipmentTagIdentityLockName("digital_twin", longTag);
    assert.ok(long.length < 64, `nome do lock com ${long.length} caracteres (limite do MySQL: 64)`);
    assert.ok(!long.includes("XXXX"), "a Tag em bruto nunca aparece no nome do lock");
});

test("a secção crítica abrange consulta E criação: GET_LOCK antes do SELECT, RELEASE_LOCK depois do INSERT", async () => {
    respond(baseRoutes());

    await persistAssetsForVersion(equipmentInput({
        guid: "g-novo", type: "IfcFurniture", name: "Mesa nova", tag: "EQP-NOVA", psets: {},
    }) as any);

    const sqls = fakeConnection.calls.map((c) => c.sql);
    const get = sqls.findIndex((s) => /GET_LOCK/i.test(s));
    const lookup = sqls.findIndex((s) => /FROM assets[\s\S]*asset_code IS NOT NULL/i.test(s));
    const insert = sqls.findIndex((s) => /INSERT INTO assets/i.test(s));
    const release = sqls.findIndex((s) => /RELEASE_LOCK/i.test(s));

    assert.ok(get >= 0, "o lock é mesmo adquirido");
    assert.ok(get < lookup, "lock ANTES da releitura pela Tag canónica");
    assert.ok(lookup < insert, "a consulta precede a criação");
    assert.ok(insert < release, "a criação acontece DENTRO da secção crítica");
});

test("o lock é libertado mesmo quando a criação falha (secção crítica não fica presa)", async () => {
    respond(baseRoutes([
        [/INSERT INTO assets/i, () => { throw new Error("insert falhou"); }],
    ]));

    await assert.rejects(persistAssetsForVersion(equipmentInput({
        guid: "g-novo", type: "IfcFurniture", name: "Mesa", tag: "EQP-NOVA", psets: {},
    }) as any));

    assert.equal(fakeConnection.callsMatching(/GET_LOCK/i).length, 1);
    assert.equal(fakeConnection.callsMatching(/RELEASE_LOCK/i).length, 1,
        "RELEASE_LOCK acontece no finally — uma falha nunca deixa a Tag bloqueada");
});

test("Tags diferentes usam locks distintos; a mesma Tag reusa o mesmo nome de lock", async () => {
    respond(baseRoutes());

    await persistAssetsForVersion(equipmentInput({
        guid: "g-1", type: "IfcFurniture", name: "A", tag: "EQP-A", psets: {},
    }, {
        inventoryData: { "space-A": { spaceGuid: "space-A", spaceName: "Sala A", elements: [
            { guid: "g-1", type: "IfcFurniture", name: "A", tag: "EQP-A", psets: {} },
            { guid: "g-2", type: "IfcFurniture", name: "B", tag: "EQP-a", psets: {} },
            { guid: "g-3", type: "IfcFurniture", name: "C", tag: "EQP-C", psets: {} },
        ] } },
        elementEntityIdsByGuid: { "g-1": 101, "g-2": 102, "g-3": 103 },
    }) as any);

    const names = fakeConnection.callsMatching(/GET_LOCK/i).map((c) => c.params.name);
    assert.equal(names.length, 3);
    assert.equal(names[0], names[1], "'EQP-A' e 'EQP-a' são a MESMA identidade canónica → o mesmo lock");
    assert.notEqual(names[0], names[2], "'EQP-C' é independente e não bloqueia");
});

test("sem Tag válida não há secção crítica a proteger (nenhum lock é adquirido)", async () => {
    respond(baseRoutes());

    await persistAssetsForVersion(equipmentInput({
        guid: "g-duto", type: "IfcDuctSegment", name: "Duto", tag: null, psets: {},
    }) as any);

    assert.equal(fakeConnection.callsMatching(/GET_LOCK/i).length, 0);
});

/* =====================================================================
   11. COMPENSAÇÃO — inalterada
   ===================================================================== */

test("compensação: só o ativo criado POR ESTA tentativa é reportado para remoção", async () => {
    respond(baseRoutes([
        [/INSERT INTO asset_bindings/i, () => { throw new Error("binding falhou"); }],
    ]));

    await assert.rejects(persistAssetsForVersion(equipmentInput({
        guid: "g-novo", type: "IfcFurniture", name: "Mesa nova", tag: "EQP-NOVA", psets: {},
    }) as any), (error: any) => {
        assert.equal(error.uploadStage, "asset_binding");
        assert.deepEqual(error.createdAssetIds, [300]);
        return true;
    });
});

test("compensação: um ativo REUTILIZADO (pré-existente) nunca entra na lista de remoção", async () => {
    respond(baseRoutes([
        [/FROM assets[\s\S]*asset_code IS NOT NULL/i,
            [[{ id: 77, asset_code: "EQP-1", serial_number: null, linked_model_id: 99 }]]],
        [/INSERT INTO asset_bindings/i, () => { throw new Error("binding falhou"); }],
    ]));

    await assert.rejects(persistAssetsForVersion(equipmentInput({
        guid: "g-x", type: "IfcFurniture", name: "Mesa", tag: "EQP-1", psets: {},
    }) as any), (error: any) => {
        assert.deepEqual(error.createdAssetIds, [],
            "um ativo pré-existente reutilizado NUNCA é apagado pela compensação");
        return true;
    });
});

test("regressão de reservas: a guarda de remoção continua a proteger ativos com reservas", async () => {
    respond([[/DELETE FROM assets/i, [{}]]]);
    await persistentAssetDb.deleteAssetsWithoutReferences([300]);

    const del = fakeConnection.callsMatching(/DELETE FROM assets/i)[0]!;
    assert.match(del.sql, /NOT EXISTS \(SELECT 1 FROM res_reservations/i,
        "uma reserva a apontar para assets.id impede sempre a remoção");
    assert.match(del.sql, /NOT EXISTS \(SELECT 1 FROM asset_bindings/i);
});

/* =====================================================================
   11. TAG-1 V2 — CORREÇÃO A: a recolha de candidatos é um SUPERCONJUNTO
       PROVADO da função canónica, nunca um pré-filtro que a imite no motor
   ===================================================================== */

/**
 * O `EQP-` é dívida de governança conhecida e `isValidEquipmentTag` exige-o em
 * MAIÚSCULAS; o SUFIXO, porém, é texto livre do modelador. O contraexemplo mais
 * forte REALMENTE alcançável pelo resolver é por isso um sufixo Unicode:
 *
 *   canonicalEquipmentTagKey('EQP-straße')  === 'EQP-STRASSE'   (JS expande ß→SS)
 *   MySQL  UPPER('EQP-straße')              === 'EQP-STRAßE'    (não expande)
 *
 * A V1 fazia `WHERE UPPER(TRIM(asset_code)) = :canonicalTag`, logo procurando
 * 'EQP-STRASSE' o MySQL NÃO devolveria a linha 'EQP-straße' — um FALSO NEGATIVO
 * de identidade que criaria um segundo ativo persistente para o mesmo
 * equipamento. A V2 elimina a classe inteira de risco: o SQL não canonicaliza.
 */
test("V2/A: sem falso negativo — 'EQP-straße' e 'EQP-STRASSE' são a MESMA identidade", async () => {
    assert.equal(canonicalEquipmentTagKey("EQP-straße"), "EQP-STRASSE",
        "pré-condição do contraexemplo: o JavaScript expande ß→SS");
    assert.notEqual("EQP-straße".toUpperCase(), "EQP-STRAßE",
        "e é exatamente aqui que o UPPER() do MySQL divergiria");

    respond([
        [/SELECT DATABASE\(\)/i, [[{ db: "test-db" }]]],
        [/FROM assets[\s\S]*asset_code IS NOT NULL/i, [[
            { id: 1, asset_code: "EQP-straße", serial_number: null, linked_model_id: 10 },
        ]]],
    ]);

    const rows = await persistentAssetDb.findEquipmentByTag(canonicalEquipmentTagKey("EQP-STRASSE"));

    assert.deepEqual(rows.map((r: any) => r.id), [1],
        "a linha canonicamente equivalente É encontrada (a V1 perdia-a)");
});

test("V2/A: o SQL de recolha de candidatos NÃO canonicaliza no motor", async () => {
    respond([
        [/SELECT DATABASE\(\)/i, [[{ db: "test-db" }]]],
        [/FROM assets[\s\S]*asset_code IS NOT NULL/i, [[]]],
    ]);

    await persistentAssetDb.findEquipmentByTag("EQP-QUALQUER");

    const query = fakeConnection.callsMatching(/FROM assets[\s\S]*asset_code IS NOT NULL/i)[0]!;
    assert.ok(!/UPPER\s*\(/i.test(query.sql),
        "nenhum UPPER() no SQL: o motor nunca tenta reproduzir a canonicalização do JavaScript");
    assert.ok(!/COLLATE/i.test(query.sql),
        "nenhuma COLLATE: a correspondência não pode depender da collation do esquema/ambiente");
    assert.ok(!/asset_code\s*=/i.test(query.sql), "nenhuma igualdade de asset_code no SQL");
    // O domínio devolvido é exatamente o conjunto de linhas que a função canónica
    // poderia alguma vez fazer corresponder — superconjunto por CONSTRUÇÃO.
    assert.match(query.sql, /asset_type\s*=\s*'equipment'/i);
    assert.match(query.sql, /asset_uuid IS NOT NULL/i);
    assert.match(query.sql, /asset_code IS NOT NULL/i);
});

test("V2/A: candidato FALSO POSITIVO devolvido pelo SQL é rejeitado pelo filtro canónico", async () => {
    respond([
        [/SELECT DATABASE\(\)/i, [[{ db: "test-db" }]]],
        // A consulta larga devolve TODO o domínio de equipamentos — incluindo
        // linhas que nada têm a ver com a Tag procurada.
        [/FROM assets[\s\S]*asset_code IS NOT NULL/i, [[
            { id: 1, asset_code: "EQP-OUTRA", serial_number: null, linked_model_id: 10 },
            { id: 2, asset_code: "  eqp-alvo  ", serial_number: null, linked_model_id: 99 },
            { id: 3, asset_code: "EQP-ALVO-2", serial_number: null, linked_model_id: 10 },
            { id: 4, asset_code: null, serial_number: null, linked_model_id: 10 },
        ]]],
    ]);

    const rows = await persistentAssetDb.findEquipmentByTag("EQP-ALVO");

    assert.deepEqual(rows.map((r: any) => r.id), [2],
        "só a linha canonicamente igual sobrevive: o JavaScript é a ÚNICA autoridade");
});

/**
 * CORREÇÃO A (parte 2): o nome do lock consultivo deriva da MESMA função
 * canónica, logo Tags canonicamente equivalentes disputam SEMPRE o mesmo lock —
 * caso contrário duas escritas concorrentes da mesma identidade não se
 * serializariam e criariam dois ativos persistentes.
 */
test("V2/D: pares canonicamente equivalentes produzem SEMPRE o mesmo nome de lock", () => {
    const equivalentes: [string, string][] = [
        ["EQP-ABC123", "  eqp-abc123  "],
        ["EQP-straße", "EQP-STRASSE"],
        ["EQP-Alvo", "EQP-ALVO"],
        [" EQP-1 ", "EQP-1"],
    ];

    for (const [a, b] of equivalentes) {
        assert.equal(canonicalEquipmentTagKey(a), canonicalEquipmentTagKey(b), `canónicas iguais: ${a} / ${b}`);
        assert.equal(
            equipmentTagIdentityLockName("digital_twin", canonicalEquipmentTagKey(a)),
            equipmentTagIdentityLockName("digital_twin", canonicalEquipmentTagKey(b)),
            `o lock tem de ser o MESMO para '${a}' e '${b}'`);
    }

    // E continuam distintos para Tags que a função canónica separa.
    assert.notEqual(
        equipmentTagIdentityLockName("digital_twin", canonicalEquipmentTagKey("EQP-ALVO")),
        equipmentTagIdentityLockName("digital_twin", canonicalEquipmentTagKey("EQP-ALVO-2")));
});

test("V2/A: a chave canónica é UMA só função — o alias de duplicados delega nela", async () => {
    const { equipmentTagDuplicateKey } = await import("../../classification/equipmentTag.ts");
    for (const tag of ["EQP-straße", "  eqp-abc  ", "EQP-1", "EQP-ÁÇÃO"]) {
        assert.equal(equipmentTagDuplicateKey(tag), canonicalEquipmentTagKey(tag),
            `deteção de duplicados e identidade nunca podem divergir (${tag})`);
    }
});
