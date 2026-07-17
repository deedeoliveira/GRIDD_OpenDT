/**
 * Guardas do Prompt 3:
 *  - separação entre identidade (identity/) e política (policies/);
 *  - migrations de espaços não tocam nas reservas nem no snapshot histórico.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backDir = fileURLToPath(new URL("../../", import.meta.url));
const repoRoot = path.resolve(backDir, "..");

function readDirFiles(dir: string): { name: string; content: string }[] {
    const full = path.join(backDir, dir);
    return fs.readdirSync(full)
        .filter((f) => f.endsWith(".ts"))
        .map((f) => ({ name: `${dir}/${f}`, content: fs.readFileSync(path.join(full, f), "utf-8") }));
}

test("separação identidade/política: identity/ não importa policies/ e policies/ não importa identity/", () => {
    // A verificação é sobre DEPENDÊNCIAS (imports) — comentários explicativos
    // que distinguem as responsabilidades são permitidos.
    for (const file of readDirFiles("identity")) {
        assert.doesNotMatch(file.content, /from\s+["'].*policies\//, `${file.name} não deve importar policies/`);
    }
    for (const file of readDirFiles("policies")) {
        assert.doesNotMatch(file.content, /from\s+["'].*identity\//, `${file.name} não deve importar identity/`);
        assert.doesNotMatch(file.content, /SpaceIdentity/, `${file.name} não deve referenciar identidade espacial`);
    }
});

test("o resolver não é registado no provider de políticas", () => {
    const provider = fs.readFileSync(path.join(backDir, "policies/policyProvider.ts"), "utf-8");
    assert.doesNotMatch(provider, /Space/i);
});

test("a ausência de Reference não entra na regra de reservabilidade legada", () => {
    const evaluator = fs.readFileSync(path.join(backDir, "policies/legacyIfcReservabilityEvaluator.ts"), "utf-8");
    assert.doesNotMatch(evaluator, /Reference|Pset/i, "a política não conhece o código de inventário");
});

test("migration de espaços não toca em res_reservations, overdue, entities, assets nem storage_key", () => {
    const forward = fs.readFileSync(
        path.join(repoRoot, "database/migrations/2026-07-16_space_identity.sql"), "utf-8");
    const active = forward.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

    assert.match(active, /CREATE TABLE `spaces`/);
    assert.match(active, /CREATE TABLE `space_bindings`/);
    assert.match(active, /uq_spaces_scope_code/);
    assert.match(active, /uq_binding_entity/);
    assert.doesNotMatch(active, /res_reservations|overdue/i);
    assert.doesNotMatch(active, /ALTER TABLE `entities`|ALTER TABLE `assets`|storage_key/i);
});

test("rollback de espaços remove só as estruturas novas e avisa da perda de dados", () => {
    const rollback = fs.readFileSync(
        path.join(repoRoot, "database/migrations/2026-07-16_space_identity_rollback.sql"), "utf-8");

    assert.match(rollback, /DROP TABLE `space_bindings`/);
    assert.match(rollback, /DROP TABLE `spaces`/);
    assert.match(rollback, /PERDIDAS/i, "aviso explícito de perda");

    const active = rollback.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    assert.doesNotMatch(active, /entities|assets|res_reservations|overdue|current_version_id|storage_key/i);
});

test("snapshot histórico continua sem as estruturas de espaços (não foi regenerado)", () => {
    const snapshot = fs.readFileSync(
        path.join(repoRoot, "database/schema_snapshot_2026-07-15.sql"), "utf-8");
    assert.doesNotMatch(snapshot, /space_bindings|space_uuid|spatial_authority/);
});
