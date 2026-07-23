/**
 * Reset seguro dos dados OPERACIONAIS da base de desenvolvimento (revisão do
 * Prompt 3). Limpa dados; NUNCA toca em schema, migrations, ENUMs, FKs,
 * índices, triggers, variáveis de ambiente nem dados de referência.
 *
 * Uso:
 *   npx tsx scripts/resetOperationalData.ts                      # --dry-run (default)
 *   ALLOW_DESTRUCTIVE_DEV_RESET=true npx tsx scripts/resetOperationalData.ts --apply
 *
 * Proteções:
 *  - --apply exige a variável ALLOW_DESTRUCTIVE_DEV_RESET=true (não a guardes
 *    ativa em nenhum .env — passa-a inline no comando);
 *  - recusa correr com NODE_ENV=production;
 *  - DELETEs em transação, por ordem segura de FKs; repetível (2.ª execução é no-op);
 *  - backup JSON automático antes do --apply (diretório gitignored);
 *  - contagens antes e depois; nenhum dado fictício é inserido.
 *
 * Tabelas LIMPAS (operacionais): asset_location_assignments,
 *   semantic_sync_operations, asset_bindings, asset_reconciliation_cases,
 *   legacy_asset_mapping, space_bindings, res_reservations, assets, spaces,
 *   entities, model_versions, sensors_channels, sensors_data, sensors,
 *   models, linked_models.
 * (5B) Depois do SQL, limpa também os recursos de ativos não modelados do
 *   grafo operacional (remoção direcionada; nunca CLEAR/DROP) — se o grafo
 *   estiver desligado, avisa e indica cleanupNonModelledGraphData.ts.
 * Tabelas PRESERVADAS: channels (dados de referência dos sensores).
 *   (Não existem tabelas de utilizadores/papéis — a aplicação não tem
 *   autenticação; nada a preservar nesse campo.)
 *
 * Ficheiros runtime (com --apply): remove diretórios de versões
 * (models/<id numérico>/) e ficheiros legados (models/<id numérico>.ifc) e
 * limpa models/temp/ — só caminhos sob o storage root validado; nunca toca
 * em _backup*, código, migrations, fixtures fonte ou documentação.
 */
import "dotenv/config";
import mysql from "mysql2/promise";
import fs from "fs";
import path from "path";
import { STORAGE_ROOT, REAL_DEV_STORAGE_ROOT } from "../utils/storage.ts";
import { cleanupNonModelledGraphResources } from "./cleanupNonModelledGraphData.ts";

/** Ordem segura de FKs: filhos antes de pais. */
export const OPERATIONAL_TABLES = [
    "asset_location_assignments",   // (5B) referencia assets e spaces
    "semantic_sync_operations",     // (5B) workflow grafo→SQL
    "asset_bindings",
    "asset_reconciliation_cases",
    "legacy_asset_mapping",
    "space_bindings",
    "res_reservations",
    "assets",
    "spaces",
    "entities",
    "model_versions",
    "sensors_channels",
    "sensors_data",
    "sensors",
    "models",
    "linked_models",
] as const;

export const PRESERVED_TABLES = ["channels"] as const;

export interface ResetOptions {
    /** Root do storage a limpar. Nos TESTES tem de ser um diretório descartável
     *  — a BD é falsa mas o filesystem é real (lição de 2026-07-17: uma suite
     *  de testes apagou ficheiros de versões reais por usar o root verdadeiro). */
    storageRoot?: string;
}

export async function runOperationalReset(apply: boolean, options: ResetOptions = {}): Promise<void> {
    const isTestEnv = process.env.NODE_ENV === "test";

    /* ---- guardas pós-incidente de 2026-07-17 (falha SEGURA, nunca default
            silencioso): em ambiente de teste o root TEM de ser explicitamente
            injetado e NUNCA pode ser o storage real de desenvolvimento. ---- */
    if (isTestEnv && !options.storageRoot) {
        throw new Error(
            "resetOperationalData: NODE_ENV=test requires an explicitly injected disposable storageRoot " +
            "(tests must never touch the real development storage)"
        );
    }

    const storageRoot = options.storageRoot ?? STORAGE_ROOT;
    const resolvedRoot = path.resolve(storageRoot);
    const realRoot = path.resolve(REAL_DEV_STORAGE_ROOT);

    if (isTestEnv && (resolvedRoot === realRoot || resolvedRoot.startsWith(realRoot + path.sep))) {
        throw new Error(
            "resetOperationalData: refusing to run against the real development storage (back/cdn_resources) in a test environment"
        );
    }

    if (process.env.NODE_ENV === "production") {
        throw new Error("resetOperationalData: refusing to run with NODE_ENV=production");
    }
    if (apply && process.env.ALLOW_DESTRUCTIVE_DEV_RESET !== "true") {
        throw new Error(
            "resetOperationalData: --apply requires ALLOW_DESTRUCTIVE_DEV_RESET=true (pass it inline; do not persist it in .env)"
        );
    }

    const conn = await mysql.createConnection({
        host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
        database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    } as any);

    /* ---- contagens antes ---- */
    const before: Record<string, number> = {};
    for (const table of [...OPERATIONAL_TABLES, ...PRESERVED_TABLES]) {
        const [rows]: any = await conn.query(`SELECT COUNT(*) AS n FROM \`${table}\``);
        before[table] = rows[0].n;
    }

    console.log("=== PLANO DE RESET ===");
    console.table(Object.entries(before).map(([tabela, linhas]) => ({
        tabela, linhas,
        ação: (PRESERVED_TABLES as readonly string[]).includes(tabela) ? "PRESERVAR" : "LIMPAR",
    })));

    if (!apply) {
        console.log("(--dry-run: nada foi alterado; usa --apply com ALLOW_DESTRUCTIVE_DEV_RESET=true)");
        await conn.end();
        return;
    }

    /* ---- backup JSON antes de apagar (nome único por execução — nunca
            sobrescreve backups anteriores) ---- */
    const backupDir = path.join(storageRoot, `_backup_reset_${new Date().toISOString().replace(/[:.]/g, "-")}`);
    fs.mkdirSync(backupDir, { recursive: true });
    const backup: Record<string, any[]> = {};
    for (const table of [...OPERATIONAL_TABLES, ...PRESERVED_TABLES]) {
        const [rows]: any = await conn.query(`SELECT * FROM \`${table}\``);
        backup[table] = rows;
    }
    const backupPath = path.join(backupDir, "db_operational_data.json");
    fs.writeFileSync(backupPath, JSON.stringify(backup, null, 1));
    console.log("Backup criado:", backupPath);

    /* ---- limpeza da BD em transação, ordem segura de FKs ---- */
    await conn.beginTransaction();
    try {
        for (const table of OPERATIONAL_TABLES) {
            if (table === "entities") {
                // FK auto-referenciada (parent_id): filhas antes das raízes
                await conn.query("DELETE FROM `entities` WHERE parent_id IS NOT NULL");
            }
            await conn.query(`DELETE FROM \`${table}\``);
        }
        await conn.commit();
    } catch (error) {
        await conn.rollback();
        await conn.end();
        throw error;
    }

    // AUTO_INCREMENT de volta a 1 (DDL leve; ids limpos para os testes)
    for (const table of OPERATIONAL_TABLES) {
        await conn.query(`ALTER TABLE \`${table}\` AUTO_INCREMENT = 1`);
    }

    /* ---- ficheiros runtime correspondentes aos dados apagados ---- */
    const modelsDir = path.join(storageRoot, "models");
    if (fs.existsSync(modelsDir)) {
        for (const entry of fs.readdirSync(modelsDir, { withFileTypes: true })) {
            const full = path.join(modelsDir, entry.name);
            if (entry.isDirectory() && /^\d+$/.test(entry.name)) {
                fs.rmSync(full, { recursive: true, force: true });
                console.log("removido diretório de versões:", entry.name);
            } else if (entry.isFile() && /^\d+\.ifc$/i.test(entry.name)) {
                fs.rmSync(full, { force: true });
                console.log("removido ficheiro legado:", entry.name);
            } else if (entry.isDirectory() && entry.name === "temp") {
                for (const t of fs.readdirSync(full)) fs.rmSync(path.join(full, t), { force: true });
                console.log("temp/ limpo");
            }
            // tudo o resto (ex.: archive movido para _backup, .gitkeep) fica intacto
        }
    }

    /* ---- contagens depois + verificação de estrutura ---- */
    const after: Record<string, number> = {};
    for (const table of [...OPERATIONAL_TABLES, ...PRESERVED_TABLES]) {
        const [rows]: any = await conn.query(`SELECT COUNT(*) AS n FROM \`${table}\``);
        after[table] = rows[0].n;
    }
    console.log("=== DEPOIS ===");
    console.table(after);

    const [enumCheck]: any = await conn.query("SHOW COLUMNS FROM res_reservations LIKE 'status'");
    const [spacesCheck]: any = await conn.query("SHOW TABLES LIKE 'spaces'");
    console.log("estrutura intacta:",
        "overdue:", enumCheck[0].Type.includes("overdue"),
        "| spaces:", spacesCheck.length === 1);

    await conn.end();

    /* ---- (5B) limpeza correspondente no GRAFO operacional: sem isto o
            Fuseki ficaria com ativos não modelados/atribuições/proveniência
            órfãos. Remoção DIRECIONADA (nunca CLEAR/DROP), reutilizando o
            mesmo serviço de scripts/cleanupNonModelledGraphData.ts. Uma
            falha aqui NÃO desfaz o reset SQL — fica instrução para repetir. ---- */
    // A suite usa uma ligação SQL falsa, mas o grafo é um serviço externo.
    // Nunca deixar um reset de teste alcançar o dataset persistente local.
    if (process.env.NODE_ENV === "test") {
        console.log("Grafo operacional preservado em NODE_ENV=test (a suite não pode limpar /oswadt-dev).");
    } else try {
        const graphCleanup = await cleanupNonModelledGraphResources();
        if (graphCleanup.skipped) {
            console.warn(
                "AVISO: grafo NÃO limpo (" + (graphCleanup.reason ?? "não configurado") + "). " +
                "Se usas o grafo, liga o Fuseki e corre: npx tsx scripts/cleanupNonModelledGraphData.ts"
            );
        } else {
            console.log(`Grafo operacional limpo: ${graphCleanup.resourcesDeleted} recurso(s) removido(s).`);
        }
    } catch (error: any) {
        console.warn(
            "AVISO: a limpeza do grafo falhou (" + (error?.code ?? "erro") + ": " + (error?.message ?? error) + "). " +
            "O reset SQL foi concluído; corre depois: npx tsx scripts/cleanupNonModelledGraphData.ts"
        );
    }

    console.log("Reset concluído. Nenhum dado fictício foi criado.");
}

/* Execução direta como script (importável em testes sem efeitos colaterais) */
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").includes("resetOperationalData")) {
    runOperationalReset(process.argv.includes("--apply"))
        .catch((e) => { console.error(e.message ?? e); process.exit(1); });
}
