/**
 * Guardas de integridade do Prompt 2:
 *  - o snapshot histórico do esquema não foi alterado nem regenerado;
 *  - as migrations desta etapa não tocam nas reservas (overdue preservado
 *    no forward E no rollback);
 *  - nenhuma verificação inline de classe IFC foi reintroduzida fora da
 *    camada de políticas.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backDir = fileURLToPath(new URL("../../", import.meta.url));
const repoRoot = path.resolve(backDir, "..");

test("snapshot histórico do esquema permanece o da baseline (sem versionamento, sem overdue)", () => {
    const snapshot = fs.readFileSync(
        path.join(repoRoot, "database/schema_snapshot_2026-07-15.sql"), "utf-8");

    // é o snapshot PRÉ-migrations: se alguém o regenerar, estas asserções falham
    assert.match(snapshot, /Extraído em 2026-07-15/);
    assert.match(snapshot, /CREATE TABLE `model_versions`/);
    assert.doesNotMatch(snapshot, /version_number/);
    assert.doesNotMatch(snapshot, /current_version_id/);
    assert.doesNotMatch(snapshot, /storage_key/);
    assert.doesNotMatch(snapshot, /'overdue'/);
});

test("migration forward do versionamento não toca em res_reservations nem no ENUM das reservas", () => {
    const forward = fs.readFileSync(
        path.join(repoRoot, "database/migrations/2026-07-16_model_versioning.sql"), "utf-8");

    assert.match(forward, /ADD COLUMN `version_number`/);
    assert.match(forward, /ADD UNIQUE KEY `uq_model_version_number`/);
    assert.match(forward, /ADD COLUMN `current_version_id`/);

    const withoutComments = forward.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    assert.doesNotMatch(withoutComments, /res_reservations/i, "forward não altera reservas");
    assert.doesNotMatch(withoutComments, /overdue/i, "forward não mexe no ENUM das reservas");
});

test("rollback do versionamento restaura o esquema anterior SEM reverter o overdue nem apagar reservas", () => {
    const rollback = fs.readFileSync(
        path.join(repoRoot, "database/migrations/2026-07-16_model_versioning_rollback.sql"), "utf-8");

    assert.match(rollback, /DROP COLUMN `version_number`/);
    assert.match(rollback, /DROP COLUMN `current_version_id`/);

    const withoutComments = rollback.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    assert.doesNotMatch(withoutComments, /res_reservations/i, "rollback não altera reservas");
    assert.doesNotMatch(withoutComments, /overdue/i, "rollback não reverte o ENUM");
    assert.doesNotMatch(withoutComments, /DELETE|DROP TABLE/i, "rollback não apaga dados");
});

test("a migration de overdue (Prompt 1) continua intacta no diretório de migrations", () => {
    const overdueMigration = fs.readFileSync(
        path.join(repoRoot, "database/migrations/2026-07-15_add_overdue_status.sql"), "utf-8");
    assert.match(overdueMigration, /'overdue'/);
});

test("nenhuma verificação inline de classe IFC fora da camada de políticas", () => {
    const dirs = ["routes", "services", "utils", "scripts"];
    const offenders: string[] = [];

    for (const dir of dirs) {
        const full = path.join(backDir, dir);
        if (!fs.existsSync(full)) continue;

        const walk = (d: string) => {
            for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
                const p = path.join(d, entry.name);
                if (entry.isDirectory()) { walk(p); continue; }
                if (!entry.name.endsWith(".ts")) continue;

                const content = fs.readFileSync(p, "utf-8");
                if (/['"`]IfcSensor['"`]/.test(content)) {
                    offenders.push(path.relative(backDir, p));
                }
            }
        };
        walk(full);
    }

    assert.deepEqual(offenders, [], "a regra IfcSensor vive apenas em back/policies/");
});
