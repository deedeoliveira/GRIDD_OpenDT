/**
 * Relatório READ-ONLY de possíveis ativos legados não modelados (Prompt 5B §16).
 *
 * Classifica cada linha de `assets` sem escrever NADA:
 *   - space_asset                   → space_id preenchido (ativo-espaço, P4);
 *   - modelled_asset                → tem asset_binding OU model_entity_id
 *                                     (origem claramente IFC);
 *   - graph_projection              → source='graph' (já é não modelado, 5B);
 *   - possible_legacy_non_modelled  → sem binding, sem entity, sem espaço,
 *                                     source='ifc' (candidato a origem manual);
 *   - ambiguous_origin              → sinais contraditórios.
 * Todos os classificados terminam em `not_migrated`: NENHUM backfill
 * automático é feito nesta etapa — migrar exige confirmação humana (nunca
 * inventar URI/identidade).
 *
 * Uso: cd back && npx tsx scripts/reportNonModelledLegacy.ts
 */
import "dotenv/config";
import mysql from "mysql2/promise";

async function main(): Promise<void> {
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST ?? "localhost", port: Number(process.env.DB_PORT ?? 3306),
        database: process.env.DB_NAME ?? "", user: process.env.DB_USER ?? "", password: process.env.DB_PASSWORD ?? "",
    });

    const [rows]: any = await connection.execute(`
        SELECT a.id, a.name, a.asset_type, a.source, a.space_id, a.model_entity_id,
               a.asset_uuid, a.semantic_uri,
               EXISTS (SELECT 1 FROM asset_bindings ab WHERE ab.asset_id = a.id) AS has_binding
        FROM assets a
        ORDER BY a.id ASC
    `);

    const buckets = {
        space_asset: [] as any[], modelled_asset: [] as any[], graph_projection: [] as any[],
        possible_legacy_non_modelled: [] as any[], ambiguous_origin: [] as any[],
    };

    for (const row of rows) {
        if (row.source === "graph") buckets.graph_projection.push(row);
        else if (row.space_id !== null) buckets.space_asset.push(row);
        else if (row.has_binding || row.model_entity_id !== null) buckets.modelled_asset.push(row);
        else if (row.source === "ifc") buckets.possible_legacy_non_modelled.push(row);
        else buckets.ambiguous_origin.push(row);
    }

    console.log(`Relatório de origem dos ativos (${rows.length} linha(s)) — READ-ONLY, nada foi migrado:`);
    for (const [category, items] of Object.entries(buckets)) {
        console.log(`  ${category}: ${items.length}`);
        for (const item of items) {
            console.log(`    - asset ${item.id} '${item.name}' (type=${item.asset_type}, uuid=${item.asset_uuid ?? "NULL"}, semantic_uri=${item.semantic_uri ?? "NULL"})`);
        }
    }
    console.log("  not_migrated: " + rows.length + " (backfill automático NÃO é executado nesta etapa)");

    await connection.end();
}

main().catch((error) => { console.error(error.message); process.exit(1); });
