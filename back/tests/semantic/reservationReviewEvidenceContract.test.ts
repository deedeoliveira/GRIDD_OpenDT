import assert from 'node:assert/strict';
import test from 'node:test';
import { ReservationApprovalService } from '../../reservationApproval/reservationApprovalService.ts';

const reservation = { id: 25, actor_id: 'pg202405', asset_id: 9, status: 'pending', start_time: '2030-09-01 19:45:00', end_time: '2030-09-01 20:30:00' };

class ReviewDatabaseHarness {
  scoped = true;
  everQueriedScopes = false;
  row = { ...reservation };
  async connect() {} async checkConnection() {}
  connection = { execute: async (sql: string) => {
    if (sql.includes('FROM reservation_management_scopes')) { this.everQueriedScopes = true; return [this.scoped ? [{ id: 1, asset_id: 9, scope_uuid: 'scope-9' }] : []]; }
    if (sql.includes('FROM res_reservations r')) return [[this.row]];
    throw new Error(`Unexpected query: ${sql}`);
  } };
}

class ReviewsHarness {
  rows: any[] = [];
  stale: Array<{ id: number; reason: string }> = [];
  expired: number[] = [];
  async latest() { return this.rows.at(-1) ?? null; }
  freshness(row: any) { return row?.status === 'current' && new Date(row.expires_at).getTime() > Date.now(); }
  async persist(input: any) { this.rows.push({ id: this.rows.length + 1, status: 'current', reviewed_at: new Date().toISOString(), expires_at: input.expiresAt.toISOString(), reservation_input_hash: input.inputHash, evidence_run_id: input.evidenceRunId, run_uuid: `run-${input.evidenceRunId}`, actor_link_id: input.actorLinkId, institutional_artifact_id: input.institutionalArtifactId, model_version_id: input.modelVersionId, materialisation_id: input.materialisationId, structural_validation_run_id: input.structuralValidationRunId, policy_artifact_id: input.policyArtifactId, shadow_eligibility_outcome: 'eligible', sql_availability_status: 'available' }); }
  async markStale(id: number, reason: string) { this.stale.push({ id, reason }); const row = this.rows.find((item) => item.id === id); if (row?.status === 'current') row.status = 'stale'; }
  async markExpired(id: number) { this.expired.push(id); const row = this.rows.find((item) => item.id === id); if (row?.status === 'current') row.status = 'expired'; }
}

function evidenceHarness(fails = false) {
  let evaluations = 0;
  return {
    get evaluations() { return evaluations; },
    evaluate: async () => { evaluations += 1; if (fails) throw new Error('private implementation detail'); return { runUuid: `evidence-${evaluations}` }; },
    getRun: async () => ({ id: 100 + evaluations, row: { actor_link_id: 6, institutional_artifact_id: 4, model_version_id: 11, materialisation_id: 9, structural_validation_run_id: 5, policy_artifact_id: 9, expires_at: '2031-01-01 00:00:00.000' } }),
  };
}

test('open review returns a complete JSON-ready current review and reuses only the same current session evidence', async () => {
  const db = new ReviewDatabaseHarness(); const reviews = new ReviewsHarness(); const evidence = evidenceHarness();
  const service = new ReservationApprovalService(db as any, reviews as any, async () => true, evidence as any);
  const opened = await service.detail(7, 'manager-session-a', 25);
  assert.equal(opened.reviewEvidence.status, 'current'); assert.equal(opened.reviewEvidence.run_uuid, 'run-101');
  assert.equal(opened.reviewEvidence.actor_link_id, 6); assert.equal(opened.reviewEvidence.structural_validation_run_id, 5);
  const reopened = await service.detail(7, 'manager-session-a', 25);
  assert.equal(reopened.refreshed, false); assert.equal(evidence.evaluations, 1);
});

test('explicit refresh creates a new review, preserves the prior row and never changes the reservation', async () => {
  const db = new ReviewDatabaseHarness(); const reviews = new ReviewsHarness(); const evidence = evidenceHarness();
  const service = new ReservationApprovalService(db as any, reviews as any, async () => true, evidence as any);
  await service.detail(7, 'manager-session-a', 25); const refreshed = await service.reviewReservation(7, 'manager-session-a', 25, true);
  assert.equal(refreshed.reviewEvidence.run_uuid, 'run-102'); assert.equal(reviews.rows.length, 2);
  assert.deepEqual(reviews.stale, [{ id: 1, reason: 'refreshed' }]); assert.equal(db.row.status, 'pending');
});

test('failed refresh is sanitized, preserves the previous review and leaves the reservation pending', async () => {
  const db = new ReviewDatabaseHarness(); const reviews = new ReviewsHarness(); const prior = { id: 9, status: 'current', expires_at: '2031-01-01T00:00:00.000Z', reservation_input_hash: 'different' };
  reviews.rows.push(prior); const service = new ReservationApprovalService(db as any, reviews as any, async () => true, evidenceHarness(true) as any);
  await assert.rejects(() => service.reviewReservation(7, 'manager-session-a', 25, true), (error: any) => error.code === 'review_evidence_refresh_failed' && error.httpStatus === 500 && !error.message.includes('private'));
  assert.equal(reviews.rows.length, 1); assert.equal(db.row.status, 'pending');
});

test('expired, stale and session-ended reviews are not reused when opening a request', async () => {
  for (const state of ['expired', 'stale', 'session_ended'] as const) {
    const db = new ReviewDatabaseHarness(); const reviews = new ReviewsHarness(); const evidence = evidenceHarness();
    reviews.rows.push({ id: 1, status: state, expires_at: '2031-01-01T00:00:00.000Z', reservation_input_hash: 'old' });
    const opened = await new ReservationApprovalService(db as any, reviews as any, async () => true, evidence as any).detail(7, 'manager-session-a', 25);
    assert.equal(opened.reviewEvidence.status, 'current'); assert.equal(evidence.evaluations, 1, state);
  }
});

test('an expired current review is explicitly marked expired before a replacement is created', async () => {
  const db = new ReviewDatabaseHarness(); const reviews = new ReviewsHarness(); reviews.rows.push({ id: 1, status: 'current', expires_at: '2020-01-01T00:00:00.000Z', reservation_input_hash: 'old' });
  await new ReservationApprovalService(db as any, reviews as any, async () => true, evidenceHarness() as any).detail(7, 'manager-session-a', 25);
  assert.deepEqual(reviews.expired, [1]); assert.equal(reviews.rows.at(-1).status, 'current');
});

test('open and refresh are global: the service does not gate on asset scopes (the route enforces operationalManagement)', async () => {
  // Scopes are dormant; the absence of any scope must not affect the service.
  const db = new ReviewDatabaseHarness(); db.scoped = false;
  const service = new ReservationApprovalService(db as any, new ReviewsHarness() as any, async () => true, evidenceHarness() as any);
  const opened = await service.detail(7, 'manager-session-a', 25);
  assert.equal(opened.reviewEvidence.status, 'current');
  const refreshed = await service.reviewReservation(7, 'manager-session-a', 25, true);
  assert.equal(refreshed.reviewEvidence.status, 'current');
  assert.ok(!db.everQueriedScopes, 'the service never queries reservation_management_scopes');
});
