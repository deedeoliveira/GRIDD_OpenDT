/**
 * Concorrência do versionamento IFC (§6/§11.5) e da resolução de casos de
 * reconciliação de ativos modelados (§7) — Prompt 6.
 *
 * O versionamento do Prompt 2 já estava correto EM SQL (FOR UPDATE + UNIQUE +
 * transação); o que o Prompt 6 corrigiu foi a execução: com a conexão única
 * partilhada, transações de uploads simultâneos entrelaçavam-se. Estes testes
 * confirmam a integração com o pool: transações dedicadas + lock da linha de
 * models serializam a reserva do version_number.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeMySQL, fakeConnection } from "../helpers/fakeDb.ts";

installFakeMySQL();
const { default: versionDb } = await import("../../utils/modelVersionDatabase.ts");
const { default: persistentAssetDb } = await import("../../utils/persistentAssetDatabase.ts");

beforeEach(() => fakeConnection.reset());

/* ================= §6/§11.5 — versionamento ================= */

function versioningState() {
    const state = {
        versions: [] as any[],
        currentVersionId: null as number | null,
        nextId: 1,
    };
    fakeConnection.handler = (sql: string, params?: any) => {
        if (/SELECT id FROM models WHERE id = :modelId FOR UPDATE/.test(sql)) {
            return [[{ id: params.modelId }]];
        }
        if (/COALESCE\(MAX\(version_number\), 0\)/.test(sql)) {
            const max = Math.max(0, ...state.versions.filter((v) => v.model_id === params.modelId).map((v) => v.version_number));
            return [[{ next: max + 1 }]];
        }
        if (/INSERT INTO model_versions/.test(sql)) {
            // emula UNIQUE(model_id, version_number)
            if (state.versions.some((v) => v.model_id === params.modelId && v.version_number === params.versionNumber)) {
                const err: any = new Error(`Duplicate entry '${params.modelId}-${params.versionNumber}' for key 'uq_mv'`);
                err.errno = 1062; err.code = "ER_DUP_ENTRY";
                throw err;
            }
            const id = state.nextId++;
            state.versions.push({ id, model_id: params.modelId, version_number: params.versionNumber, status: "processing" });
            return [{ insertId: id }];
        }
        if (/SELECT id, status FROM model_versions WHERE id = :versionId AND model_id = :modelId FOR UPDATE/.test(sql)) {
            return [state.versions.filter((v) => v.id === params.versionId && v.model_id === params.modelId).map((v) => ({ ...v }))];
        }
        if (/SELECT current_version_id FROM models WHERE id = :modelId FOR UPDATE/.test(sql)) {
            return [[{ current_version_id: state.currentVersionId }]];
        }
        if (/SET status = 'active'/.test(sql)) {
            const v = state.versions.find((x) => x.id === params.versionId);
            if (v) v.status = "active";
            return [{ affectedRows: v ? 1 : 0 }];
        }
        if (/SET status = 'archived'/.test(sql)) {
            const v = state.versions.find((x) => x.id === params.previousId);
            if (v) v.status = "archived";
            return [{ affectedRows: v ? 1 : 0 }];
        }
        if (/UPDATE models SET current_version_id/.test(sql)) {
            state.currentVersionId = params.versionId;
            return [{ affectedRows: 1 }];
        }
        return [[]];
    };
    return state;
}

const uploadInput = (n: number) => ({
    modelId: 7, originalFilename: `v${n}.ifc`, fileHash: `hash${n}`, fileSize: 100 + n,
});

test("§11.5 dois uploads simultâneos do mesmo modelo recebem version_numbers DIFERENTES (serialização pela linha de models)", async () => {
    for (let i = 0; i < 10; i++) {
        fakeConnection.reset();
        const state = versioningState();

        const [a, b] = await Promise.all([
            versionDb.reserveVersion(uploadInput(1)),
            versionDb.reserveVersion(uploadInput(2)),
        ]);

        assert.notEqual(a.versionNumber, b.versionNumber, `iteração ${i}: números distintos`);
        assert.deepEqual([a.versionNumber, b.versionNumber].sort(), [1, 2]);
        assert.equal(state.versions.length, 2);
    }
});

test("§6 ativação simultânea de duas versões: ambas serializadas — UMA corrente final, a outra archived; nenhuma perdida", async () => {
    const state = versioningState();
    const [a, b] = await Promise.all([
        versionDb.reserveVersion(uploadInput(1)),
        versionDb.reserveVersion(uploadInput(2)),
    ]);

    await Promise.all([
        versionDb.activateVersion(7, a.versionId),
        versionDb.activateVersion(7, b.versionId),
    ]);

    // a corrente é EXPLÍCITA (models.current_version_id) e única
    assert.ok([a.versionId, b.versionId].includes(state.currentVersionId!));
    const current = state.versions.find((v) => v.id === state.currentVersionId)!;
    const other = state.versions.find((v) => v.id !== state.currentVersionId)!;
    assert.equal(current.status, "active");
    assert.equal(other.status, "archived", "a versão que perdeu a corrida ficou archived — nunca perdida");
});

test("§6 uma versão 'failed' nunca pode ser ativada (regra preservada sob concorrência)", async () => {
    const state = versioningState();
    const { versionId } = await versionDb.reserveVersion(uploadInput(1));
    state.versions.find((v) => v.id === versionId)!.status = "failed";

    await assert.rejects(
        versionDb.activateVersion(7, versionId),
        /Only a version in 'processing' state can be activated/
    );
    assert.equal(state.currentVersionId, null);
});

/* ================= §7 — resolução simultânea de casos ================= */

function caseState() {
    const state = {
        case: {
            id: 50, status: "open", model_version_id: 3, model_entity_id: 33,
            ifc_guid: "GUID-1", name_snapshot: "Projector", type_snapshot: "IfcBuildingElementProxy",
            space_id: null, resolved_asset_id: null as number | null,
        },
        assets: [] as any[],
        bindings: [] as any[],
        retired: [] as number[],
        nextId: 100,
    };
    fakeConnection.handler = (sql: string, params?: any) => {
        if (/FROM asset_reconciliation_cases WHERE id = :caseId LIMIT 1 FOR UPDATE/.test(sql)) {
            return [[{ ...state.case }]];
        }
        if (/INSERT INTO assets/.test(sql)) {
            const id = state.nextId++;
            state.assets.push({ id, name: params.name });
            return [{ insertId: id }];
        }
        if (/INSERT INTO asset_bindings/.test(sql)) {
            // emula UNIQUE(model_entity_id) — backstop
            if (state.bindings.some((b) => b.model_entity_id === params.modelEntityId)) {
                const err: any = new Error("Duplicate entry for key 'uq_ab_entity'");
                err.errno = 1062; err.code = "ER_DUP_ENTRY";
                throw err;
            }
            state.bindings.push({ asset_id: params.assetId, model_entity_id: params.modelEntityId });
            return [{ insertId: state.nextId++ }];
        }
        if (/SET lifecycle_status = 'retired'/.test(sql)) {
            state.retired.push(params.assetId);
            return [{ affectedRows: 1 }];
        }
        if (/UPDATE asset_reconciliation_cases/.test(sql)) {
            const ok = state.case.status === "open";
            if (ok) {
                state.case.status = params.status;
                state.case.resolved_asset_id = params.resolvedAssetId;
            }
            return [{ affectedRows: ok ? 1 : 0 }];
        }
        return [[]];
    };
    return state;
}

test("§7 resolução simultânea do MESMO caso: uma vence, a outra recebe o estado resolvido (409 na rota) — UM asset, UM binding", async () => {
    for (let i = 0; i < 10; i++) {
        fakeConnection.reset();
        const state = caseState();

        const resolve = () => persistentAssetDb.resolveCaseTransactionally({
            caseId: 50, caseStatus: "resolved_new", resolvedBy: "andressa",
            linkAssetId: null, newAsset: { name: "Projector", reservable: false },
            retireAssetId: null, skipBinding: false,
        });

        const [a, b] = await Promise.all([resolve(), resolve()]);

        const winners = [a, b].filter((r) => !r.alreadyResolvedAs);
        const losers = [a, b].filter((r) => r.alreadyResolvedAs);
        assert.equal(winners.length, 1, `iteração ${i}: exatamente uma resolução efetiva`);
        assert.equal(losers.length, 1);
        assert.equal(losers[0]!.alreadyResolvedAs, "resolved_new");
        assert.equal(state.assets.length, 1, "um único asset criado");
        assert.equal(state.bindings.length, 1, "um único binding criado");
        assert.equal(state.case.status, "resolved_new");
    }
});

test("§7 confirm_replacement simultâneo: apenas UM ativo é retirado (nunca duas retiradas)", async () => {
    const state = caseState();

    const resolve = () => persistentAssetDb.resolveCaseTransactionally({
        caseId: 50, caseStatus: "resolved_replacement", resolvedBy: "andressa",
        linkAssetId: null, newAsset: { name: "Projector v2", reservable: false },
        retireAssetId: 7, skipBinding: false,
    });

    await Promise.all([resolve(), resolve()]);
    assert.equal(state.retired.length, 1, "o substituído foi retirado exatamente uma vez");
    assert.equal(state.assets.length, 1);
});

test("§7 casos já resolvidos NUNCA são alterados: resolução sobre caso resolvido devolve o estado sem efeitos", async () => {
    const state = caseState();
    state.case.status = "resolved_link";
    state.case.resolved_asset_id = 42;

    const outcome = await persistentAssetDb.resolveCaseTransactionally({
        caseId: 50, caseStatus: "resolved_new", resolvedBy: "x",
        linkAssetId: null, newAsset: { name: "Outro", reservable: true },
        retireAssetId: null, skipBinding: false,
    });

    assert.equal(outcome.alreadyResolvedAs, "resolved_link");
    assert.equal(outcome.resolvedAssetId, 42);
    assert.equal(state.assets.length, 0, "nenhum efeito colateral");
    assert.equal(state.case.status, "resolved_link");
});
