import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { ReservationApprovalError, ReservationApprovalService } from '../../reservationApproval/reservationApprovalService.ts';

type Reservation = { id: number; actor_id?: string; asset_id: number; status: string; start_time: string; end_time: string; shadow_eligibility_outcome?: string | null; evidence_expires_at?: string | null };

class ApprovalHarness {
  calls: string[] = [];
  audits: any[] = [];
  allowed = true;
  conflict = false;
  actorSourceCurrent = true;
  reservation: Reservation = { id: 40, actor_id: 'actor', asset_id: 7, status: 'pending', start_time: '2030-02-01 10:00:00', end_time: '2030-02-01 11:00:00', shadow_eligibility_outcome: 'eligible', evidence_expires_at: '2030-03-01 00:00:00' };
  async connect() {}
  async disconnect() {}
  async checkConnection() {}
  connection = { execute: async (sql: string) => this.reply(sql, {}, false) };
  async withTransaction<T>(fn: (connection: any) => Promise<T>) { return fn({ execute: async (sql: string, values: any) => this.reply(sql, values, true) }); }
  private async reply(sql: string, values: any, transactional: boolean): Promise<any> {
    this.calls.push(sql);
    if (/FROM reservation_management_scopes/.test(sql)) return [this.allowed ? [{ id: 3, asset_id: 7, scope_uuid: 'scope-7' }] : []];
    if (/FROM res_reservations r/.test(sql)) return [[this.reservation]];
    if (/FROM actor_institutional_links/.test(sql)) return [this.actorSourceCurrent ? [{ id: 4 }] : []];
    if (/FROM semantic_artifact_families/.test(sql)) return [[{ current_artifact_id: 9 }]];
    if (/UPDATE reservation_manager_evidence_reviews/.test(sql)) return [{ affectedRows: 1 }];
    if (/SELECT id FROM assets/.test(sql)) return [[]];
    if (/status IN \('approved','in_use','no_show'\)/.test(sql)) return [this.conflict ? [{ id: 99 }] : []];
    if (/UPDATE res_reservations/.test(sql)) {
      if (this.reservation.status !== values.previousStatus) return [{ affectedRows: 0 }];
      this.reservation.status = values.status;
      return [{ affectedRows: 1 }];
    }
    if (/INSERT INTO reservation_decisions/.test(sql)) { this.audits.push(values); return [{ insertId: this.audits.length }]; }
    throw new Error(`Unexpected query: ${sql}`);
  }
}

function service(harness: ApprovalHarness) { return new ReservationApprovalService(harness as any, { latest: async () => ({ id: 9, review_uuid: 'review-current', status: 'current', reservation_input_hash: crypto.createHash('sha256').update(JSON.stringify({ actor: harness.reservation.actor_id ?? 'actor', asset: Number(harness.reservation.asset_id), start: new Date(`${harness.reservation.start_time}Z`).toISOString(), end: new Date(`${harness.reservation.end_time}Z`).toISOString() })).digest('hex'), expires_at: '2031-03-01 00:00:00.000', evidence_run_id: 88, run_uuid: 'review-run', shadow_eligibility_outcome: harness.reservation.shadow_eligibility_outcome ?? 'eligible', sql_availability_status: 'available' }), freshness: () => true, markStale: async () => {} } as any, async () => true); }

test('vertical lifecycle: a session-resolved scoped manager approves a pending request and creates one audit', async () => {
  const harness = new ApprovalHarness();
  const result = await service(harness).decide(501, 'session-1', 40, 'approved', { managerId: 99999 } as any);
  assert.equal(result.status, 'approved');
  assert.equal(harness.reservation.status, 'approved');
  assert.equal(harness.audits.length, 1);
  assert.equal(harness.audits[0].accountId, 501, 'the service receives the resolved session account, never a body manager id');
  assert.match(harness.calls[1]!, /FOR UPDATE/);
  assert.ok(harness.calls.some((sql) => /SELECT id FROM assets.*FOR UPDATE/.test(sql)));
  assert.ok(harness.calls.some((sql) => /status IN \('approved','in_use','no_show'\)/.test(sql)));
});

test('vertical lifecycle: a rejection needs a reason and an approved request may be administratively cancelled once', async () => {
  const harness = new ApprovalHarness();
  await assert.rejects(() => service(harness).decide(501, 'session-1', 40, 'rejected', {}), (error: any) => error.code === 'decision_reason_required');
  await service(harness).decide(501, 'session-1', 40, 'rejected', { reason: 'Synthetic walkthrough rejection.' });
  assert.equal(harness.reservation.status, 'rejected');
  await assert.rejects(() => service(harness).decide(501, 'session-1', 40, 'approved', {}), (error: any) => error.code === 'reservation_not_pending');
  harness.reservation.status = 'approved';
  await service(harness).decide(501, 'session-1', 40, 'cancelled', { reason: 'Synthetic administrative cancellation.' });
  assert.equal(harness.reservation.status, 'cancelled');
  assert.equal(harness.audits.length, 2);
});

test('vertical lifecycle: no application role/scope and a different asset are both denied', async () => {
  const noRole = new ApprovalHarness(); noRole.allowed = false;
  for (const kind of ['approved','rejected','cancelled'] as const) await assert.rejects(() => service(noRole).decide(501, 'session-1', 40, kind, {}), (error: any) => error instanceof ReservationApprovalError && error.httpStatus === 403);
  const outOfScope = new ApprovalHarness(); outOfScope.reservation.asset_id = 8;
  await assert.rejects(() => service(outOfScope).decide(501, 'session-1', 40, 'approved', {}), (error: any) => error instanceof ReservationApprovalError && error.httpStatus === 403);
});

test('vertical lifecycle: current SQL conflict blocks the second overlapping approval without adding an audit', async () => {
  const harness = new ApprovalHarness(); harness.conflict = true;
  await assert.rejects(() => service(harness).decide(501, 'session-1', 40, 'approved', {}), (error: any) => error.code === 'reservation_approval_conflict');
  assert.equal(harness.reservation.status, 'pending');
  assert.equal(harness.audits.length, 0);
});

test('vertical lifecycle: non-eligible shadow evidence is non-binding but approval needs acknowledgement and reason', async () => {
  const harness = new ApprovalHarness(); harness.reservation.shadow_eligibility_outcome = 'not_eligible';
  await assert.rejects(() => service(harness).decide(501, 'session-1', 40, 'approved', {}), (error: any) => error.code === 'reservation_shadow_override_required');
  await service(harness).decide(501, 'session-1', 40, 'approved', { overrideAcknowledged: true, reason: 'Synthetic documented override.' });
  assert.equal(harness.reservation.status, 'approved');
  assert.equal(harness.audits[0].override, true);
});

test('pending revoked-link request with current not-eligible review and conflicting SQL snapshot can be rejected without override', async () => {
  const harness = new ApprovalHarness(); harness.reservation.shadow_eligibility_outcome = 'not_eligible'; harness.conflict = true;
  const hash = crypto.createHash('sha256').update(JSON.stringify({ actor: harness.reservation.actor_id, asset: 7, start: new Date(`${harness.reservation.start_time}Z`).toISOString(), end: new Date(`${harness.reservation.end_time}Z`).toISOString() })).digest('hex');
  const reviews: any = { latest: async () => ({ id: 12, review_uuid: 'revoked-current-review', status: 'current', reservation_input_hash: hash, expires_at: '2031-01-01 00:00:00.000', evidence_run_id: 91, run_uuid: 'revoked-review-run', shadow_eligibility_outcome: 'not_eligible', sql_availability_status: 'conflict' }), freshness: () => true, markStale: async () => {} };
  const result = await new ReservationApprovalService(harness as any, reviews, async () => true).decide(501, 'session-1', 40, 'rejected', { reason: 'Institutional link is revoked.' });
  assert.equal(result.status, 'rejected'); assert.equal(result.availability, 'conflict'); assert.equal(result.reviewUuid, 'revoked-current-review');
  assert.equal(harness.audits[0].evidenceId, 91); assert.equal(harness.audits[0].override, false); assert.equal(harness.audits[0].availability, 'conflict');
  assert.ok(!harness.calls.some((sql) => /status IN \('approved','in_use','no_show'\)/.test(sql)), 'reject does not perform or require an approval conflict check');
});

test('not-eligible approval needs acknowledgement and reason, then still depends on the transactional SQL recheck', async () => {
  const harness = new ApprovalHarness(); harness.reservation.shadow_eligibility_outcome = 'not_eligible';
  await assert.rejects(() => service(harness).decide(501, 'session-1', 40, 'approved', {}), (error: any) => error.code === 'reservation_shadow_override_required');
  harness.conflict = true;
  await assert.rejects(() => service(harness).decide(501, 'session-1', 40, 'approved', { overrideAcknowledged: true, reason: 'Synthetic override.' }), (error: any) => error.code === 'reservation_approval_conflict');
  assert.equal(harness.reservation.status, 'pending'); assert.equal(harness.audits.length, 0);
});

test('decision always audits the newest operational review selected server-side', async () => {
  const harness = new ApprovalHarness(); const hash = crypto.createHash('sha256').update(JSON.stringify({ actor: harness.reservation.actor_id, asset: 7, start: new Date(`${harness.reservation.start_time}Z`).toISOString(), end: new Date(`${harness.reservation.end_time}Z`).toISOString() })).digest('hex');
  const historical = { id: 1, review_uuid: 'old-review', status: 'stale', evidence_run_id: 80 };
  const operational = { id: 2, review_uuid: 'new-review', status: 'current', reservation_input_hash: hash, expires_at: '2031-01-01 00:00:00.000', evidence_run_id: 92, run_uuid: 'new-run', shadow_eligibility_outcome: 'eligible', sql_availability_status: 'available' };
  const reviews: any = { latest: async () => operational, freshness: () => true, markStale: async () => {} };
  const result = await new ReservationApprovalService(harness as any, reviews, async () => true).decide(501, 'session-1', 40, 'rejected', { reason: 'Synthetic rejection.' });
  assert.equal(result.reviewUuid, operational.review_uuid); assert.equal(harness.audits[0].evidenceId, operational.evidence_run_id); assert.notEqual(harness.audits[0].evidenceId, historical.evidence_run_id);
});

test('a revoked actor-link snapshot remains semantically current while an actual link-version change makes it stale', async () => {
  const hashFor = (h: ApprovalHarness) => crypto.createHash('sha256').update(JSON.stringify({ actor: h.reservation.actor_id, asset: 7, start: new Date(`${h.reservation.start_time}Z`).toISOString(), end: new Date(`${h.reservation.end_time}Z`).toISOString() })).digest('hex');
  const reviewFor = (h: ApprovalHarness) => ({ id: 15, review_uuid: 'revoked-review', status: 'current', reservation_input_hash: hashFor(h), expires_at: '2031-01-01 00:00:00.000', evidence_run_id: 93, run_uuid: 'revoked-run', actor_link_id: 4, actor_link_uuid_snapshot: 'revoked-link-uuid', actor_link_status_snapshot: 'revoked', institutional_artifact_id: 4, policy_artifact_id: 9, model_version_id: 11, materialisation_id: 9, structural_validation_run_id: 5, shadow_eligibility_outcome: 'not_eligible', sql_availability_status: 'conflict' });
  const resource: any = { resolveResource: async () => ({ model_version_id: 11, materialisation_id: 9, structural_validation_run_id: 5 }) };
  const current = new ApprovalHarness(); current.reservation.actor_id = 'TEST-ACTOR-REVOKED-001'; const currentReview: any = { latest: async () => reviewFor(current), freshness: () => true, markStale: async () => {} };
  await new ReservationApprovalService(current as any, currentReview, undefined, undefined, resource).decide(501, 'session-1', 40, 'rejected', { reason: 'Revoked link is current evidence.' });
  assert.equal(current.reservation.status, 'rejected'); assert.ok(!current.calls.some((sql) => /sql_availability_status/.test(sql)), 'SQL availability is not a semantic freshness source');
  const changed = new ApprovalHarness(); changed.reservation.actor_id = 'TEST-ACTOR-REVOKED-001'; changed.actorSourceCurrent = false; const changedReview: any = { latest: async () => reviewFor(changed), freshness: () => true, markStale: async () => {} };
  await assert.rejects(() => new ReservationApprovalService(changed as any, changedReview, undefined, undefined, resource).decide(501, 'session-1', 40, 'rejected', { reason: 'Must be stale.' }), (error: any) => error.code === 'review_evidence_stale');
});

test('vertical lifecycle: changed material sources make a review stale before the SQL decision', async () => {
  const harness = new ApprovalHarness();
  const review: any = { latest: async () => ({ id: 9, status: 'current', reservation_input_hash: crypto.createHash('sha256').update(JSON.stringify({ actor: harness.reservation.actor_id, asset: Number(harness.reservation.asset_id), start: new Date(`${harness.reservation.start_time}Z`).toISOString(), end: new Date(`${harness.reservation.end_time}Z`).toISOString() })).digest('hex'), expires_at: '2031-03-01 00:00:00.000', evidence_run_id: 88, run_uuid: 'review-run', shadow_eligibility_outcome: 'eligible' }), freshness: () => true, markStale: async () => {} };
  const sut = new ReservationApprovalService(harness as any, review, async () => false);
  await assert.rejects(() => sut.decide(501, 'session-1', 40, 'approved', {}), (error: any) => error.code === 'review_evidence_stale');
  assert.equal(harness.reservation.status, 'pending');
  assert.equal(harness.audits.length, 0);
});

test('decision guard returns controlled 409 errors for absent, expired, stale and session-ended review evidence', async () => {
  const harness = new ApprovalHarness();
  const hash = crypto.createHash('sha256').update(JSON.stringify({ actor: harness.reservation.actor_id, asset: 7, start: new Date(`${harness.reservation.start_time}Z`).toISOString(), end: new Date(`${harness.reservation.end_time}Z`).toISOString() })).digest('hex');
  for (const [state, expected] of [[null, 'review_evidence_required'], ['expired', 'review_evidence_stale'], ['stale', 'review_evidence_stale'], ['session_ended', 'review_evidence_stale']] as const) {
    const reviews: any = { latest: async () => state === null ? null : ({ id: 9, status: state, reservation_input_hash: hash, expires_at: state === 'expired' ? '2020-01-01 00:00:00.000' : '2031-01-01 00:00:00.000' }), freshness: (row: any) => row.status === 'current', markStale: async () => {} };
    const sut = new ReservationApprovalService(harness as any, reviews, async () => true);
    await assert.rejects(() => sut.decide(501, 'session-1', 40, 'approved', {}), (error: any) => error.code === expected && error.httpStatus === 409, String(state));
  }
});

test('vertical review flow opens current evidence before approval and returns a controlled SQL conflict for the overlapping request', async () => {
  class ReviewStore {
    current: any = null;
    async latest() { return this.current; }
    freshness(row: any) { return row?.status === 'current'; }
    async markStale() {}
    async markExpired() {}
    async persist(input: any) { this.current = { id: 1, status: 'current', reservation_input_hash: input.inputHash, expires_at: '2031-01-01 00:00:00.000', evidence_run_id: input.evidenceRunId, run_uuid: 'opened-review', shadow_eligibility_outcome: 'eligible' }; }
  }
  const evidence: any = { evaluate: async () => ({ runUuid: 'opened-review' }), getRun: async () => ({ id: 88, row: { actor_link_id: 6, institutional_artifact_id: 4, model_version_id: 11, materialisation_id: 9, structural_validation_run_id: 5, policy_artifact_id: 9, expires_at: '2031-01-01 00:00:00.000' } }) };
  const first = new ApprovalHarness(); const firstStore = new ReviewStore(); const firstService = new ReservationApprovalService(first as any, firstStore as any, async () => true, evidence);
  assert.equal((await firstService.detail(501, 'session-1', 40)).reviewEvidence.status, 'current');
  assert.equal((await firstService.decide(501, 'session-1', 40, 'approved', {})).status, 'approved');
  const second = new ApprovalHarness(); second.conflict = true; const secondStore = new ReviewStore(); const secondService = new ReservationApprovalService(second as any, secondStore as any, async () => true, evidence);
  assert.equal((await secondService.detail(501, 'session-1', 40)).reviewEvidence.status, 'current');
  await assert.rejects(() => secondService.decide(501, 'session-1', 40, 'approved', {}), (error: any) => error.code === 'reservation_approval_conflict' && error.httpStatus === 409);
  assert.equal(second.reservation.status, 'pending');
});

test('vertical lifecycle: a manager cancellation requires a reason and refuses an already checked-in reservation', async () => {
  const harness = new ApprovalHarness();
  await assert.rejects(() => service(harness).decide(501, 'session-1', 40, 'cancelled', {}), (error: any) => error.code === 'decision_reason_required');
  harness.reservation.status = 'approved';
  await service(harness).decide(501, 'session-1', 40, 'cancelled', { reason: 'Synthetic manager cancellation before check-in.' });
  assert.equal(harness.reservation.status, 'cancelled');
  assert.equal(harness.audits.at(-1)?.kind, 'cancelled');
  assert.equal(harness.audits.at(-1)?.reason, 'Synthetic manager cancellation before check-in.');
  harness.reservation.status = 'in_use';
  (harness.reservation as any).checkin_time = '2030-02-01 10:00:00';
  await assert.rejects(() => service(harness).decide(501, 'session-1', 40, 'cancelled', { reason: 'Must not cancel in use.' }),
    (error: any) => error.code === 'reservation_already_checked_in' && error.httpStatus === 409);
});
