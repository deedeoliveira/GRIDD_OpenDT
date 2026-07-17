/**
 * Backfill da identidade espacial (Prompt 3) — não destrutivo, idempotente.
 *
 * Uso (⚠️ requer backend Node e Flask a correr — o reprocessamento usa o
 * fluxo Node–Python existente, sem mecanismo paralelo de acesso aos IFCs):
 *   npx tsx scripts/backfillSpaces.ts            # relatório (não escreve)
 *   npx tsx scripts/backfillSpaces.ts --apply    # aplica
 *
 * Fontes, por ordem (as entities atuais NÃO guardam o código de inventário,
 * por isso a fonte 1 do prompt não é utilizável neste esquema):
 *   1. reprocessamento do ficheiro da versão via storage_key, através de
 *      /api/model/inventory do Flask com path=<download da versão no Node>;
 *   2. nenhuma associação quando o ficheiro está ausente/irrecuperável.
 *
 * Não reprocessa: versões failed; versões sem storage_key. Não inventa
 * códigos nem associações.
 */
import "dotenv/config";
import mysql from "mysql2/promise";
import { getSpaceIdentityResolver } from "../identity/spaceIdentityProvider.ts";

const SELF = process.env.SELF_API_BASE ?? `http://localhost:${process.env.PORT || 3000}`;
const FLASK = process.env.IFCOPENSHELL_FLASK_API_ROUTE;

type Row = Record<string, any>;

export async function runSpacesBackfill(apply: boolean) {
    const resolver = getSpaceIdentityResolver();

    const conn = await mysql.createConnection({
        host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
        database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    } as any);
    (conn as any).config.namedPlaceholders = true;

    const [versions]: any = await conn.query(`
        SELECT v.id, v.model_id, v.version_number, v.status, v.storage_key,
               m.linked_parent_id AS linked_model_id
        FROM model_versions v
        INNER JOIN models m ON m.id = v.model_id
        ORDER BY v.model_id, v.version_number
    `);

    const report: Row[] = [];
    const counts: Record<string, number> = {};
    const bump = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };

    for (const version of versions) {
        const base = {
            linked_model: version.linked_model_id, model: version.model_id,
            version: version.id, nº: version.version_number,
        };

        if (version.status === "failed") {
            report.push({ ...base, entity: "—", código: "—", resultado: "skipped_failed_version" });
            bump("skipped_failed_version");
            continue;
        }
        if (!version.storage_key) {
            // pós-Prompt 2, storage_key NULL cobre ausente/ambíguo/irrecuperável
            report.push({ ...base, entity: "—", código: "—", resultado: "source_file_unavailable" });
            bump("source_file_unavailable");
            continue;
        }
        if (version.linked_model_id === null) {
            report.push({ ...base, entity: "—", código: "—", resultado: "no_linked_model_scope" });
            bump("no_linked_model_scope");
            continue;
        }

        /* ---- reprocessar via fluxo Node–Python existente ---- */
        const fileUrl = `${SELF}/api/model/versions/${version.id}/download`;
        let inventory: Record<string, any>;
        try {
            const resp = await fetch(`${FLASK}/model/inventory/${version.model_id}`, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: `path=${encodeURIComponent(fileUrl)}`,
            });
            if (!resp.ok) throw new Error(`Flask respondeu ${resp.status}`);
            inventory = ((await resp.json()) as any)?.data ?? {};
        } catch (error: any) {
            report.push({ ...base, entity: "—", código: "—", resultado: `reprocess_error: ${error.message}` });
            bump("reprocess_error");
            continue;
        }

        /* ---- entities de espaço desta versão ---- */
        const [entities]: any = await conn.query(`
            SELECT id, guid, name FROM entities
            WHERE model_version_id = :versionId AND entity_type = 'space'
        `, { versionId: version.id });
        const entityByGuid = new Map<string, any>(entities.map((e: any) => [e.guid, e]));

        /* ---- resolver identidades ---- */
        const resolved: { guid: string; entity: any; result: any; space: any }[] = [];
        for (const [guid, space] of Object.entries(inventory)) {
            const entity = entityByGuid.get(guid);
            if (!entity) continue; // elemento sem entity de espaço nesta versão

            const result = await resolver.resolve(
                { guid, name: (space as any).spaceName, longName: (space as any).spaceLongName, psets: (space as any).psets },
                { linkedModelId: version.linked_model_id, modelId: version.model_id, modelVersionId: version.id }
            );
            resolved.push({ guid, entity, result, space });
        }

        // duplicados no contexto da versão
        const byCode = new Map<string, typeof resolved>();
        for (const r of resolved) {
            if (r.result.status !== "valid") continue;
            const c = r.result.normalizedValue;
            if (!byCode.has(c)) byCode.set(c, [] as any);
            (byCode.get(c) as any).push(r);
        }
        for (const [, group] of byCode) {
            if ((group as any).length > 1) for (const r of group as any) r.result.status = "duplicate";
        }

        for (const r of resolved) {
            const rowBase = { ...base, entity: r.entity.id, código: r.result.rawValue ?? "—" };

            if (r.result.status === "missing") { report.push({ ...rowBase, resultado: "missing_reference" }); bump("missing_reference"); continue; }
            if (r.result.status === "invalid") { report.push({ ...rowBase, resultado: "invalid_reference" }); bump("invalid_reference"); continue; }
            if (r.result.status === "duplicate") { report.push({ ...rowBase, resultado: "duplicate_reference" }); bump("duplicate_reference"); continue; }

            // idempotência: binding já existe para esta entity?
            const [existing]: any = await conn.query(
                "SELECT id FROM space_bindings WHERE entity_id = :entityId LIMIT 1", { entityId: r.entity.id });
            if (existing.length) { report.push({ ...rowBase, resultado: "already_bound" }); bump("already_bound"); continue; }

            const code = r.result.normalizedValue;
            const [spaceRows]: any = await conn.query(`
                SELECT id FROM spaces
                WHERE linked_model_id = :lm AND inventory_code_normalized = :code LIMIT 1
            `, { lm: version.linked_model_id, code });

            let spaceId = spaceRows[0]?.id ?? null;

            if (apply) {
                if (!spaceId) {
                    const [ins]: any = await conn.query(`
                        INSERT INTO spaces (space_uuid, inventory_code, inventory_code_normalized, linked_model_id, name, status)
                        VALUES (UUID(), :raw, :code, :lm, :name, 'active')
                    `, { raw: r.result.rawValue, code, lm: version.linked_model_id, name: (r.space as any).spaceLongName ?? (r.space as any).spaceName ?? null });
                    spaceId = ins.insertId;
                    report.push({ ...rowBase, resultado: "space_identity_created" }); bump("space_identity_created");
                }
                await conn.query(`
                    INSERT INTO space_bindings
                        (space_id, model_version_id, entity_id, ifc_guid, inventory_code_snapshot, name_snapshot, long_name_snapshot, binding_status)
                    VALUES (:spaceId, :versionId, :entityId, :guid, :raw, :name, :longName, 'active')
                `, {
                    spaceId, versionId: version.id, entityId: r.entity.id, guid: r.guid,
                    raw: r.result.rawValue, name: (r.space as any).spaceName ?? null, longName: (r.space as any).spaceLongName ?? null,
                });
                report.push({ ...rowBase, resultado: "space_binding_created" }); bump("space_binding_created");
            } else {
                report.push({
                    ...rowBase,
                    resultado: spaceId ? "would_create_binding" : "would_create_space_and_binding",
                });
                bump(spaceId ? "would_create_binding" : "would_create_space_and_binding");
            }
        }
    }

    console.log("=== RELATÓRIO DE BACKFILL DE ESPAÇOS ===");
    console.table(report);
    console.log("Totais:", counts);
    console.log(apply ? "\nAplicado." : "\n(modo relatório — nada foi escrito; usa --apply)");

    await conn.end();
}

/* Execução direta como script (importável em testes sem efeitos colaterais) */
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").includes("backfillSpaces")) {
    runSpacesBackfill(process.argv.includes("--apply"))
        .catch((e) => { console.error(e); process.exit(1); });
}
