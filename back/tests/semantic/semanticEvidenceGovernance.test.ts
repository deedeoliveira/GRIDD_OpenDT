import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadPublicArtifactManifest } from "../../semantic/publicArtifactManifest.ts";
import { reservationEvidenceGraphUri, reservationPolicyReportGraphUri } from "../../graph/namedGraphs.ts";

const ROOT = path.resolve(process.cwd(), "..");

test("public manifest distinguishes evidence vocabulary from a graph-backed SHACL shadow policy", async () => {
    const manifest = await loadPublicArtifactManifest(path.join(ROOT, "semantic/artifacts/semantic-artifacts-public-manifest.json"));
    const vocabulary = manifest.artifacts.find((entry) => entry.artifactKey === "project-semantic-evidence-1.0.0");
    const policy = manifest.artifacts.find((entry) => entry.artifactKey === "project-reservation-eligibility-shadow-1.0.0");
    assert.equal(vocabulary?.artifactType, "bridge_vocabulary");
    assert.equal(policy?.artifactType, "semantic_policy");
    assert.equal(policy?.policyLanguage, "SHACL");
    assert.equal(policy?.policyScope, "reservation_eligibility_shadow");
    assert.equal(policy?.privacyClassification, "public_research_artifact");
    assert.equal(policy?.activationAllowed, true);
});

test("evidence and policy report graph URIs are internal, run-specific and separate", () => {
    const run = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const evidence = reservationEvidenceGraphUri("http://oswadt.local/id", run);
    const report = reservationPolicyReportGraphUri("http://oswadt.local/id", run);
    assert.notEqual(evidence, report);
    assert.match(evidence, /\/graph\/evidence\/reservation\/aaaaaaaa-/);
    assert.match(report, /\/graph\/evidence\/reservation-policy-report\/aaaaaaaa-/);
    assert.doesNotMatch(evidence + report, /current|latest/i);
});

test("forward/rollback persistence is normalized and does not change reservation conflict semantics", () => {
    const forward = fs.readFileSync(path.join(ROOT, "database/migrations/2026-07-21_semantic_reservation_evidence.sql"), "utf8");
    const rollback = fs.readFileSync(path.join(ROOT, "database/migrations/2026-07-21_semantic_reservation_evidence_rollback.sql"), "utf8");
    assert.match(forward, /semantic_evidence_runs/);
    assert.match(forward, /semantic_evidence_findings/);
    assert.match(forward, /reservation_semantic_evidence_links/);
    assert.doesNotMatch(forward + rollback, /DELETE\s+FROM\s+res_reservations|ALTER\s+TABLE\s+res_reservations/i);
    assert.doesNotMatch(forward + rollback, /CLEAR|DROP\s+(ALL|NAMED|DEFAULT)/i);
});

test("real reservation UI uses researcher-controlled asset/interval and two explicit actions without hardcoded outcomes", () => {
    const ui = fs.readFileSync(path.join(ROOT, "front/app/(viewer)/student/ReservationModal.tsx"), "utf8");
    assert.match(ui, /actorId/);
    assert.match(ui, /Check evidence/);
    assert.match(ui, /Create reservation request/);
    assert.match(ui, /semanticEvidenceRunUuid/);
    assert.doesNotMatch(ui, /SHACL PASS|SHACL FAIL|outcome:\s*["']eligible/);
});

test("reservation integration preserves SQL as authority and never blocks on shadow outcome", () => {
    const route = fs.readFileSync(path.join(ROOT, "back/routes/reservation.ts"), "utf8");
    const database = fs.readFileSync(path.join(ROOT, "back/utils/reservationDatabase.ts"), "utf8");
    assert.match(route, /createReservation/);
    assert.doesNotMatch(route, /semanticEligibility.*throw|not_eligible.*return/i);
    assert.match(database, /status IN \('approved','in_use','no_show'\)/);
    assert.match(database, /status IN \('pending','approved'\)/);
    assert.match(database, /'pending'/);
});

test("API accepts only actor/resource/interval inputs and exposes no client graph, SPARQL or policy upload surface", () => {
    const route = fs.readFileSync(path.join(ROOT, "back/routes/reservation.ts"), "utf8");
    const ui = fs.readFileSync(path.join(ROOT, "front/app/(viewer)/student/ReservationModal.tsx"), "utf8");
    assert.match(route, /actorKey[\s\S]*assetId[\s\S]*start[\s\S]*end/);
    assert.doesNotMatch(route, /req\.body.*graphUri|req\.body.*policyUri|req\.body.*sparql/i);
    assert.doesNotMatch(ui, /fuseki|sparql|policy upload/i);
    assert.doesNotMatch(ui, /synthetic-actors|institutional\/demo\/actors|datalist/i,
        "the normal student form cannot impersonate a synthetic actor");
});
