/**
 * Backfill da identidade persistente dos ativos (Prompt 4) — expand-and-contract,
 * não destrutivo, idempotente.
 *
 * Uso:
 *   npx tsx scripts/backfillAssets.ts            # --report (não escreve)
 *   npx tsx scripts/backfillAssets.ts --apply
 *
 * Estratégia (promover-e-mapear, só com evidência da BD — sem reprocessar IFC):
 *  - ESPAÇOS: entity do asset legado → space_binding → space_id. Um espaço
 *    persistente gera NO MÁXIMO um ativo persistente: promove-se a linha
 *    legada da versão corrente (ou a mais recente) e as restantes são
 *    mapeadas para ela. Sem space_binding (espaço sem código) → unrecoverable
 *    (nada inventado; linha legada fica intocada).
 *  - EQUIPAMENTOS: agrupados por (linha de modelo, IFC GUID) — mecanismo
 *    EXCLUSIVAMENTE legado (legacy_ifc_guid, confiança média); NENHUM merge
 *    por nome/espaço/semelhança. As linhas legadas NÃO têm IfcElement.Tag
 *    nem serial persistidos (missing_equipment_tag): o GUID nunca é
 *    convertido em asset_code e novos uploads não usam este fallback
 *    (equipamento sem Tag EQP- falha no model_requirements_preflight).
 *  - RESERVAS: reservas a apontar para linhas não-promovidas são re-apontadas
 *    para o ativo persistente do grupo (mapeamento confiável). Ambiguidade em
 *    reserva futura/bloqueante → ERRO: o backfill NÃO conclui com sucesso.
 *  - Relatório persistido em legacy_asset_mapping.
 */
import "dotenv/config";
import mysql from "mysql2/promise";
import crypto from "crypto";

type Row = Record<string, any>;

export async function runAssetsBackfill(apply: boolean): Promise<void> {
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
        database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    } as any);
    (conn as any).config.namedPlaceholders = true;

    const report: Row[] = [];
    const counts: Record<string, number> = {};
    const bump = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };

    /* ---- linhas legadas ainda não migradas ---- */
    const [legacy]: any = await conn.query(`
        SELECT a.id, a.name, a.asset_type, a.reservable, a.model_version_id,
               a.model_entity_id, e.guid, v.model_id, m.linked_parent_id,
               m.current_version_id,
               sb.space_id
        FROM assets a
        LEFT JOIN entities e ON e.id = a.model_entity_id
        LEFT JOIN model_versions v ON v.id = a.model_version_id
        LEFT JOIN models m ON m.id = v.model_id
        LEFT JOIN space_bindings sb ON sb.entity_id = a.model_entity_id
        LEFT JOIN legacy_asset_mapping lam ON lam.legacy_asset_id = a.id
        WHERE a.asset_uuid IS NULL
          AND a.model_version_id IS NOT NULL
          AND lam.legacy_asset_id IS NULL
        ORDER BY a.id
    `);

    if (!legacy.length) {
        console.log("Nada a migrar — backfill já executado ou sem linhas legadas (no-op).");
        await conn.end();
        return;
    }

    /* ---- agrupar ---- */
    const spaceGroups = new Map<number, Row[]>();      // space_id → linhas
    const guidGroups = new Map<string, Row[]>();       // `${model_id}::${guid}` → linhas
    const unrecoverable: Row[] = [];

    for (const row of legacy) {
        if (row.asset_type === "space") {
            if (row.space_id) {
                if (!spaceGroups.has(row.space_id)) spaceGroups.set(row.space_id, []);
                spaceGroups.get(row.space_id)!.push(row);
            } else {
                unrecoverable.push(row);
            }
        } else {
            if (row.guid && row.model_id) {
                const key = `${row.model_id}::${row.guid}`;
                if (!guidGroups.has(key)) guidGroups.set(key, []);
                guidGroups.get(key)!.push(row);
            } else {
                unrecoverable.push(row);
            }
        }
    }

    /** Escolhe a linha a promover: a da versão corrente, senão a mais recente. */
    const pickPromoted = (rows: Row[]) =>
        rows.find((r) => r.model_version_id === r.current_version_id) ?? rows[rows.length - 1]!;

    const plans: {
        kind: "space" | "equipment";
        promoted: Row;
        others: Row[];
        method: string;
        spaceId: number | null;
    }[] = [];

    for (const [spaceId, rows] of spaceGroups) {
        plans.push({ kind: "space", promoted: pickPromoted(rows), others: rows.filter((r) => r !== pickPromoted(rows)), method: "space_id", spaceId });
    }
    for (const [, rows] of guidGroups) {
        plans.push({ kind: "equipment", promoted: pickPromoted(rows), others: rows.filter((r) => r !== pickPromoted(rows)), method: "legacy_ifc_guid", spaceId: null });
    }

    /* ---- reservas: verificar ambiguidades bloqueantes ANTES de escrever ---- */
    const [reservations]: any = await conn.query(`
        SELECT r.id, r.asset_id, r.status, r.end_time
        FROM res_reservations r
        INNER JOIN assets a ON a.id = r.asset_id
        WHERE a.asset_uuid IS NULL AND a.model_version_id IS NOT NULL
    `);

    const legacyIdToPlan = new Map<number, typeof plans[0]>();
    for (const plan of plans) {
        legacyIdToPlan.set(plan.promoted.id, plan);
        for (const other of plan.others) legacyIdToPlan.set(other.id, plan);
    }

    const blockingErrors: string[] = [];
    for (const reservation of reservations) {
        const plan = legacyIdToPlan.get(reservation.asset_id);
        if (!plan) {
            const isBlocking = new Date(reservation.end_time) > new Date() ||
                ["pending", "approved", "in_use", "overdue"].includes(reservation.status);
            if (isBlocking) {
                blockingErrors.push(`reserva ${reservation.id} (${reservation.status}) aponta para asset legado ${reservation.asset_id} sem mapeamento confiável`);
            } else {
                report.push({ tipo: "reserva", id: reservation.id, resultado: "requires_reconciliation" });
                bump("requires_reconciliation");
            }
        }
    }

    if (blockingErrors.length) {
        console.error("ERRO DE MIGRAÇÃO — ambiguidade em reservas futuras/bloqueantes exige decisão humana:");
        for (const err of blockingErrors) console.error("  -", err);
        await conn.end();
        throw new Error("Assets backfill aborted: ambiguous reservations require human decision");
    }

    /* ---- relatório ---- */
    for (const plan of plans) {
        report.push({
            tipo: plan.kind, promovido: plan.promoted.id,
            mapeados: plan.others.map((o: Row) => o.id).join(",") || "—",
            método: plan.method, nome: String(plan.promoted.name).slice(0, 40),
        });
        if (plan.kind === "space") {
            bump("space_promoted");
        } else {
            bump("legacy_match_by_ifc_guid");
            // linhas legadas não têm Tag institucional persistida — documentado
            bump("missing_equipment_tag");
        }
    }
    for (const row of unrecoverable) {
        report.push({ tipo: row.asset_type, promovido: "—", mapeados: row.id, método: "—", nome: String(row.name).slice(0, 40), resultado: "unrecoverable" });
        bump("unrecoverable");
    }

    console.log("=== RELATÓRIO DE BACKFILL DE ATIVOS ===");
    console.table(report);
    console.log("Totais:", counts);

    if (!apply) {
        console.log("\n(modo relatório — nada foi escrito; usa --apply)");
        await conn.end();
        return;
    }

    /* ---- aplicação ---- */
    await conn.beginTransaction();
    try {
        for (const plan of plans) {
            const promoted = plan.promoted;

            await conn.execute(`
                UPDATE assets
                SET asset_uuid = :uuid,
                    space_id = :spaceId,
                    linked_model_id = :linkedModelId,
                    lifecycle_status = :lifecycle,
                    model_version_id = NULL,
                    model_entity_id = NULL,
                    current_space_entity_id = NULL
                WHERE id = :id AND asset_uuid IS NULL
            `, {
                uuid: crypto.randomUUID(),
                spaceId: plan.spaceId,
                linkedModelId: promoted.linked_parent_id ?? null,
                lifecycle: promoted.model_version_id === promoted.current_version_id ? "active" : "absent",
                id: promoted.id,
            });

            // bindings: um por linha legada (entity/versão preservadas como histórico)
            for (const row of [promoted, ...plan.others]) {
                await conn.execute(`
                    INSERT INTO asset_bindings
                        (asset_id, model_version_id, model_entity_id, space_id, ifc_guid,
                         name_snapshot, binding_status, reconciliation_status,
                         reconciliation_method, reconciliation_confidence)
                    VALUES (:assetId, :versionId, :entityId, :spaceId, :guid,
                            :name, 'active', 'resolved', :method,
                            CASE WHEN :method2 = 'legacy_ifc_guid' THEN 'medium' ELSE 'high' END)
                `, {
                    method2: plan.method,
                    assetId: promoted.id, versionId: row.model_version_id,
                    entityId: row.model_entity_id, spaceId: plan.spaceId,
                    guid: row.guid, name: row.name, method: plan.method,
                });
            }

            // mapeamento + re-apontar reservas das linhas não promovidas
            await conn.execute(`
                INSERT INTO legacy_asset_mapping (legacy_asset_id, persistent_asset_id, mapping_method, mapping_status, confidence, notes)
                VALUES (:id, :pid, :method, 'mapped', 'high', 'promoted')
            `, { id: promoted.id, pid: promoted.id, method: plan.method });

            for (const other of plan.others) {
                await conn.execute(`
                    UPDATE res_reservations SET asset_id = :pid WHERE asset_id = :legacyId
                `, { pid: promoted.id, legacyId: other.id });

                await conn.execute(`
                    INSERT INTO legacy_asset_mapping (legacy_asset_id, persistent_asset_id, mapping_method, mapping_status, confidence, notes)
                    VALUES (:id, :pid, :method, 'mapped', 'high', 'merged into promoted row')
                `, { id: other.id, pid: promoted.id, method: plan.method });
                // expand-and-contract: a linha legada duplicada NÃO é removida
                // nesta etapa (sem asset_uuid fica fora das consultas novas;
                // o mapping regista a fusão)
            }
        }

        for (const row of unrecoverable) {
            await conn.execute(`
                INSERT INTO legacy_asset_mapping (legacy_asset_id, persistent_asset_id, mapping_method, mapping_status, confidence, notes)
                VALUES (:id, NULL, NULL, 'unrecoverable', NULL, 'no verifiable identity (no space binding / no guid)')
            `, { id: row.id });
        }

        await conn.commit();
        console.log("\nAplicado com sucesso.");
    } catch (error) {
        await conn.rollback();
        await conn.end();
        throw error;
    }

    await conn.end();
}

/* Execução direta como script (importável em testes sem efeitos colaterais) */
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").includes("backfillAssets")) {
    runAssetsBackfill(process.argv.includes("--apply"))
        .catch((e) => { console.error(e.message ?? e); process.exit(1); });
}
