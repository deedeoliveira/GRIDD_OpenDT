/**
 * Limpeza DEFINITIVA dos dados de ativos NÃO modelados (Prompt 5B) —
 * SQL (projeção) + Fuseki (grafo operacional). Executar o script = intenção
 * de apagar (sem dry-run nem confirmação, por decisão da utilizadora).
 *
 * Uso:
 *   cd back
 *   npx tsx scripts/cleanupNonModelledGraphData.ts
 *
 * APAGA (apenas o universo 5B):
 *  - res_reservations de assets source='graph';
 *  - asset_location_assignments desses assets;
 *  - semantic_sync_operations (tabela exclusivamente 5B — TODAS as linhas);
 *  - assets com source='graph';
 *  - no grafo operacional: recursos tipados pelo vocabulário operational-v1
 *    (NonModelledAsset, LocationAssignment, RegistrationActivity,
 *    LocationChangeActivity) — triplos onde são sujeito E onde são objeto.
 *
 * PRESERVA: models, model_versions, linked_models, spaces, space_bindings,
 * entities, asset_bindings, ativos modelados (source≠'graph') e as suas
 * reservas, sensores, channels, ficheiros IFC, outros named graphs.
 *
 * Segurança: remoção DIRECIONADA (nunca CLEAR/DROP; nunca deleteGraph);
 * idempotente (2.ª execução termina com contagens a zero); falha controlada
 * se SQL ou Fuseki estiverem indisponíveis; nenhuma credencial é impressa;
 * recusa NODE_ENV=production (guarda de escrita operacional aplicada).
 */
import "dotenv/config";
import mysql from "mysql2/promise";
import type { Connection } from "mysql2/promise";
import { loadGraphConfig, assertOperationalGraphWriteSafety } from "../graph/graphConfig.ts";
import { getGraphClient } from "../graph/graphClientProvider.ts";
import { operationalGraphUri } from "../graph/namedGraphs.ts";
import { operationalVocabulary } from "../graph/operationalVocabulary.ts";
import {
    buildResourceDeleteUpdates,
    buildResourcesByTypeSelect,
} from "../graph/operationalStatements.ts";

export interface NonModelledCleanupResult {
    sql: { reservations: number; assignments: number; syncOperations: number; assets: number };
    graph: { skipped: boolean; reason?: string; resourcesDeleted: number };
}

/** Limpa a PROJEÇÃO SQL (reservas → localizações → operações → assets). */
export async function cleanupNonModelledSql(conn: Connection): Promise<NonModelledCleanupResult["sql"]> {
    await conn.beginTransaction();
    try {
        const [r1]: any = await conn.query(`
            DELETE r FROM res_reservations r
            INNER JOIN assets a ON a.id = r.asset_id
            WHERE a.source = 'graph'
        `);
        const [r2]: any = await conn.query(`
            DELETE ala FROM asset_location_assignments ala
            INNER JOIN assets a ON a.id = ala.asset_id
            WHERE a.source = 'graph'
        `);
        const [r3]: any = await conn.query("DELETE FROM semantic_sync_operations");
        const [r4]: any = await conn.query("DELETE FROM assets WHERE source = 'graph'");
        await conn.commit();
        return {
            reservations: r1.affectedRows ?? 0,
            assignments: r2.affectedRows ?? 0,
            syncOperations: r3.affectedRows ?? 0,
            assets: r4.affectedRows ?? 0,
        };
    } catch (error) {
        await conn.rollback();
        throw error;
    }
}

/**
 * Limpa os recursos 5B do grafo operacional (remoção direcionada por tipo do
 * vocabulário; nunca CLEAR/DROP). Devolve skipped=true quando o grafo não
 * está configurado — quem chama decide se isso é aceitável.
 */
export async function cleanupNonModelledGraphResources(): Promise<NonModelledCleanupResult["graph"]> {
    const config = loadGraphConfig();
    if (!config.configured) {
        return { skipped: true, reason: config.reason, resourcesDeleted: 0 };
    }
    assertOperationalGraphWriteSafety(config.config);

    const client = getGraphClient();
    const vocab = operationalVocabulary(config.config.baseUri);
    const graphUri = operationalGraphUri(config.config.baseUri);

    const typesToDelete = [
        vocab.NonModelledAsset,
        vocab.LocationAssignment,
        vocab.RegistrationActivity,
        vocab.LocationChangeActivity,
    ];

    let resourcesDeleted = 0;
    for (const typeUri of typesToDelete) {
        const result = await client.query(buildResourcesByTypeSelect(graphUri, typeUri));
        const resources = (result.results?.bindings ?? [])
            .map((b: any) => b.r?.value)
            .filter((r: unknown): r is string => typeof r === "string");

        for (const resourceUri of resources) {
            for (const update of buildResourceDeleteUpdates(graphUri, resourceUri)) {
                await client.update(update);
            }
            resourcesDeleted += 1;
        }
    }
    return { skipped: false, resourcesDeleted };
}

/** Limpeza completa (SQL primeiro; grafo depois). */
export async function cleanupNonModelledData(conn: Connection): Promise<NonModelledCleanupResult> {
    const sql = await cleanupNonModelledSql(conn);
    const graph = await cleanupNonModelledGraphResources();
    return { sql, graph };
}

/* Execução direta como script (importável sem efeitos colaterais) */
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").includes("cleanupNonModelledGraphData")) {
    (async () => {
        if (process.env.NODE_ENV === "production") {
            throw new Error("cleanupNonModelledGraphData: refusing to run with NODE_ENV=production");
        }
        const conn = await mysql.createConnection({
            host: process.env.DB_HOST ?? "localhost", port: Number(process.env.DB_PORT ?? 3306),
            database: process.env.DB_NAME ?? "", user: process.env.DB_USER ?? "", password: process.env.DB_PASSWORD ?? "",
        });
        try {
            const result = await cleanupNonModelledData(conn);
            console.log("SQL limpo:",
                `reservas=${result.sql.reservations}`,
                `localizações=${result.sql.assignments}`,
                `operações=${result.sql.syncOperations}`,
                `assets=${result.sql.assets}`);
            if (result.graph.skipped) {
                console.warn(`Grafo NÃO limpo (${result.graph.reason}) — corre de novo com GRAPH_* configurado e o Fuseki ligado.`);
                process.exitCode = 2;
            } else {
                console.log(`Grafo operacional limpo: ${result.graph.resourcesDeleted} recurso(s) removido(s) de forma direcionada.`);
            }
        } finally {
            await conn.end();
        }
    })().catch((e) => { console.error(e.code ?? "", e.message ?? e); process.exit(1); });
}
