/**
 * Backfill do versionamento (Prompt 2) — não destrutivo, repetível.
 *
 * Uso:
 *   npx tsx scripts/backfillModelVersions.ts            # só relatório (default)
 *   npx tsx scripts/backfillModelVersions.ts --apply    # relatório + aplicação
 *
 * O que faz (apenas UPDATEs em model_versions/models; nunca move/apaga ficheiros):
 *  - version_number sequencial por modelo (ordem de id — a ordem de criação legada);
 *  - status: última versão de cada modelo -> active; anteriores -> archived;
 *  - models.current_version_id -> última versão (a semântica legada "maior id");
 *  - storage_key/hash/size: associa o ficheiro corrente legado (models/<id>.ifc)
 *    à versão corrente, e ficheiros de archive a versões históricas apenas quando
 *    a correspondência temporal é única (ver lib/backfillPlanner.ts);
 *  - linhas já preenchidas são ignoradas (2.ª execução = no-op);
 *  - ficheiros órfãos (sem linha) e histórico não recuperável ficam no relatório
 *    e NÃO geram metadados inventados.
 */
import "dotenv/config";
import mysql from "mysql2/promise";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { planBackfill, parseArchiveFileName, type ArchiveFile, type VersionRow } from "./lib/backfillPlanner.ts";

const STORAGE_ROOT = path.join(import.meta.dirname, "../cdn_resources");
const MODELS_DIR = path.join(STORAGE_ROOT, "models");
const ARCHIVE_DIR = path.join(MODELS_DIR, "archive");

function sha256(filePath: string) {
    const data = fs.readFileSync(filePath);
    return { hash: crypto.createHash("sha256").update(data).digest("hex"), size: data.length };
}

async function main() {
    const apply = process.argv.includes("--apply");

    const conn = await mysql.createConnection({
        host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
        database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    } as any);
    (conn as any).config.namedPlaceholders = true;

    const [versions]: any = await conn.query(
        "SELECT id, model_id, created_at, version_number, status, storage_key FROM model_versions ORDER BY model_id, id");
    const [models]: any = await conn.query("SELECT id, current_version_id FROM models");
    const modelIds = new Set<number>(models.map((m: any) => m.id));

    // Ficheiros correntes legados models/<id>.ifc
    const currentFiles = fs.readdirSync(MODELS_DIR).filter((f) => /^\d+\.ifc$/i.test(f));
    const currentFilesByModel = new Set<number>();
    const orphanCurrentFiles: string[] = [];
    for (const f of currentFiles) {
        const id = Number(f.replace(/\.ifc$/i, ""));
        if (modelIds.has(id)) currentFilesByModel.add(id);
        else orphanCurrentFiles.push(f);
    }

    // Ficheiros de archive
    const archiveFiles: ArchiveFile[] = fs.existsSync(ARCHIVE_DIR)
        ? fs.readdirSync(ARCHIVE_DIR).map(parseArchiveFileName).filter((a): a is ArchiveFile => a !== null)
        : [];

    const { plans, orphanArchives } = planBackfill(versions as VersionRow[], currentFilesByModel, archiveFiles);

    /* ---------------- RELATÓRIO ---------------- */
    console.log("=== RELATÓRIO DE BACKFILL ===");
    console.log(`linked_models/models/versões: ver auditoria; versões nesta BD: ${versions.length}`);
    console.table(plans.map((p) => ({
        versão: p.versionId, modelo: p.modelId, nº: p.versionNumber, status: p.status,
        corrente: p.isCurrent, classificação: p.classification, storage_key: p.storageKey ?? "—", nota: p.note ?? "",
    })));

    const counts: Record<string, number> = {};
    for (const p of plans) counts[p.classification] = (counts[p.classification] ?? 0) + 1;
    console.log("Classificações:", counts);
    console.log("Ficheiros correntes órfãos (sem linha em models):", orphanCurrentFiles.join(", ") || "nenhum");
    console.log("Ficheiros de archive órfãos/não associados:", orphanArchives.map((a) => a.fileName).join(", ") || "nenhum");

    if (!apply) {
        console.log("\n(modo relatório — nada foi alterado; usa --apply para aplicar)");
        await conn.end();
        return;
    }

    /* ---------------- APLICAÇÃO ---------------- */
    const pending = plans.filter((p) => p.classification !== "already_backfilled");
    if (pending.length === 0) {
        console.log("\nNada a aplicar — backfill já executado (2.ª execução é no-op).");
        await conn.end();
        return;
    }

    await conn.beginTransaction();
    try {
        for (const p of pending) {
            let hash: string | null = null;
            let size: number | null = null;

            if (p.storageKey) {
                const filePath = path.join(STORAGE_ROOT, p.storageKey);
                if (fs.existsSync(filePath)) {
                    const h = sha256(filePath);
                    hash = h.hash;
                    size = h.size;
                }
            }

            await conn.execute(`
                UPDATE model_versions
                SET version_number = :versionNumber,
                    status = :status,
                    storage_key = :storageKey,
                    file_hash = :hash,
                    file_size = :size,
                    activated_at = CASE WHEN :status2 = 'active' THEN created_at ELSE activated_at END
                WHERE id = :versionId AND version_number IS NULL
            `, {
                versionNumber: p.versionNumber, status: p.status, status2: p.status,
                storageKey: p.storageKey, hash, size, versionId: p.versionId,
            });

            if (p.isCurrent) {
                await conn.execute(
                    "UPDATE models SET current_version_id = :versionId WHERE id = :modelId AND current_version_id IS NULL",
                    { versionId: p.versionId, modelId: p.modelId });
            }
        }
        await conn.commit();
        console.log(`\nAplicado: ${pending.length} versão(ões) atualizadas.`);
    } catch (error) {
        await conn.rollback();
        throw error;
    }

    await conn.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
