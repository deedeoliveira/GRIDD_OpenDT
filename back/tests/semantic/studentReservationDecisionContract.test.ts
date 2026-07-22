import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { studentReservationsSql,toStudentReservation } from '../../reservationApproval/studentReservationDecision.ts';

test('student decision contract selects the latest decision matching the current reservation status', () => {
  assert.match(studentReservationsSql,/d2\.new_status=r\.status/);
  assert.match(studentReservationsSql,/ORDER BY d2\.created_at DESC,d2\.id DESC/);
  const cancelled=toStudentReservation({id:31,asset_id:3,status:'cancelled',start_time:'2026-08-04T20:00:00.000Z',end_time:'2026-08-04T21:00:00.000Z',decision_type:'cancelled',decision_status:'cancelled',decision_reason:'Synthetic manager cancellation.',decision_created_at:'2026-07-21T17:39:03.332Z',manager_role_snapshot:'reservation_manager'});
  assert.deepEqual(cancelled.decision,{type:'cancel',status:'cancelled',reason:'Synthetic manager cancellation.',decidedAt:'2026-07-21T17:39:03.332Z',decidedByRole:'reservation_manager'});
  assert.doesNotMatch(JSON.stringify(cancelled),/application_account_id|session_uuid|scope_uuid/);
});

test('student contract retains rejected reasons and makes missing historical reasons explicit without inventing them', () => {
  const rejected=toStudentReservation({id:29,asset_id:3,status:'rejected',start_time:'x',end_time:'y',decision_type:'rejected',decision_status:'rejected',decision_reason:'Synthetic rejection.',decision_created_at:'2026-07-21T21:18:55.400Z',manager_role_snapshot:'reservation_manager'});
  assert.equal(rejected.decision?.reason,'Synthetic rejection.');
  const legacy=toStudentReservation({id:12,asset_id:3,status:'cancelled',start_time:'x',end_time:'y'});
  assert.equal(legacy.decision,null);
});

test('student proxy preserves the decision summary and the page renders decision reason and date', () => {
  const proxy=fs.readFileSync(path.resolve(import.meta.dirname,'../../../front/app/api/reservations/mine/route.ts'),'utf8');
  const page=fs.readFileSync(path.resolve(import.meta.dirname,'../../../front/app/(viewer)/student/page.tsx'),'utf8');
  assert.match(proxy,/await response\.text\(\)/);
  assert.match(page,/No reason was recorded for this historical decision\./);
  assert.match(page,/Data da decisão:/);
  assert.match(page,/decisionDetails\(r\)/);
});
