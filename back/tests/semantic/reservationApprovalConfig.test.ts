import test from 'node:test'; import assert from 'node:assert/strict';
import { loadReservationApprovalConfig } from '../../reservationApproval/reservationApprovalConfig.ts';
test('approval defaults to disabled and local approval is refused in production',()=>{assert.equal(loadReservationApprovalConfig({}).enabled,false);assert.throws(()=>loadReservationApprovalConfig({NODE_ENV:'production',RESERVATION_APPROVAL_ENABLED:'true'}),/refused in production/);});
