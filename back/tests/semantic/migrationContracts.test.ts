import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const migration = fs.readFileSync(path.resolve(
    import.meta.dirname,
    "../../../database/migrations/2026-07-20_semantic_artifact_registry.sql"
), "utf8");
const rollback = fs.readFileSync(path.resolve(
    import.meta.dirname,
    "../../../database/migrations/2026-07-20_semantic_artifact_registry_rollback.sql"
), "utf8");

test("registry migration declares the three governed tables and immutable identities", () => {
    for (const table of ["semantic_artifact_families", "semantic_artifacts", "semantic_artifact_load_operations"]) {
        assert.match(migration, new RegExp("CREATE TABLE `" + table + "`"));
    }
    for (const key of [
        "uq_semantic_family_uuid",
        "uq_semantic_family_key",
        "uq_semantic_family_type_uri",
        "uq_semantic_artifact_uuid",
        "uq_semantic_artifact_family_version",
        "uq_semantic_artifact_graph_uri",
        "uq_semantic_artifact_family_hash",
        "uq_semantic_load_operation_uuid",
        "uq_semantic_load_idempotency_key",
    ]) assert.match(migration, new RegExp(key));
    assert.doesNotMatch(migration, /rdf_payload|turtle_payload|sparql_text/i);
});

test("current pointer foreign key is added after artifact creation", () => {
    assert.ok(migration.indexOf("CREATE TABLE `semantic_artifacts`") < migration.indexOf("fk_semantic_family_current_artifact"));
    assert.match(migration, /Same-family\/current eligibility is a transactional domain invariant/);
});

test("rollback removes only this stage in foreign-key-safe order", () => {
    const currentFk = rollback.indexOf("DROP FOREIGN KEY `fk_semantic_family_current_artifact`");
    const operations = rollback.indexOf("DROP TABLE `semantic_artifact_load_operations`");
    const artifacts = rollback.indexOf("DROP TABLE `semantic_artifacts`");
    const families = rollback.indexOf("DROP TABLE `semantic_artifact_families`");
    assert.ok(currentFk >= 0 && currentFk < operations && operations < artifacts && artifacts < families);
    assert.doesNotMatch(rollback, /CLEAR|DROP\s+(ALL|NAMED|DEFAULT)|semantic_sync_operations/i);
});
