/**
 * Executa um ficheiro .sql (statements separados por ';') contra a BD do .env.
 *
 * Uso: npx tsx scripts/runSqlFile.ts <caminho/para/ficheiro.sql>
 *
 * Não existe (ainda) tabela de controlo de migrations — a aplicação é manual
 * e cada migration deve ser idempotente ou aplicada uma única vez.
 */
import "dotenv/config";
import mysql from "mysql2/promise";
import fs from "fs";

async function main() {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) {
    console.error("Uso: npx tsx scripts/runSqlFile.ts <ficheiro.sql>");
    process.exit(1);
  }

  const sql = fs.readFileSync(file, "utf-8");
  const statements = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    multipleStatements: false,
  } as any);

  console.log(`A executar ${statements.length} statement(s) de ${file}`);

  for (const [i, statement] of statements.entries()) {
    const preview = statement.replace(/\s+/g, " ").slice(0, 90);
    try {
      await conn.query(statement);
      console.log(`  [${i + 1}/${statements.length}] OK  ${preview}...`);
    } catch (error: any) {
      console.error(`  [${i + 1}/${statements.length}] ERRO ${preview}`);
      console.error(`  ${error.message}`);
      await conn.end();
      process.exit(1);
    }
  }

  await conn.end();
  console.log("Concluído.");
}

main().catch((e) => { console.error(e); process.exit(1); });
