import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const forward = fs.readFileSync(path.resolve(import.meta.dirname, "../../../database/migrations/2026-07-20_actor_institutional_links.sql"), "utf8");
const rollback = fs.readFileSync(path.resolve(import.meta.dirname, "../../../database/migrations/2026-07-20_actor_institutional_links_rollback.sql"), "utf8");

test("actor-link migration has history, exact artifact FK and MySQL 8 current-verified uniqueness", () => {
    assert.match(forward, /CREATE TABLE `actor_institutional_links`/);
    for (const column of ["link_uuid", "actor_key", "actor_key_normalized", "institutional_agent_uri", "institutional_dataset_artifact_id", "valid_from", "valid_to", "verified_at", "superseded_at", "revoked_at"]) {
        assert.match(forward, new RegExp("`" + column + "`"));
    }
    assert.match(forward, /GENERATED ALWAYS AS/);
    assert.match(forward, /UNIQUE KEY `uq_actor_institutional_current_verified`/);
    assert.match(forward, /REFERENCES `semantic_artifacts` \(`id`\)/);
    assert.doesNotMatch(forward, /INSERT INTO|res_reservations|semantic_sync_operations|rdf_payload/i);
});

test("actor-link rollback removes only the stage table", () => {
    assert.match(rollback, /^--[\s\S]*DROP TABLE `actor_institutional_links`;\s*$/);
    assert.doesNotMatch(rollback, /semantic_artifacts|res_reservations|CLEAR|DROP\s+(ALL|NAMED|DEFAULT)/i);
});
