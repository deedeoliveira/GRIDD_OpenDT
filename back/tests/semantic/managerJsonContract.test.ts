import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runManagerRequest } from '../../reservationApproval/managerApiContract.ts';
import { ReservationApprovalError } from '../../reservationApproval/reservationApprovalService.ts';
import { parseApiJsonResponse, ApiResponseError } from '../../../front/lib/apiResponse.mts';
import { normalizeManagerProxyResponse } from '../../../front/lib/managerProxyResponse.mts';

function responseCapture() {
  return { statusCode: 0, body: null as any, status(value: number) { this.statusCode = value; return this; }, json(value: unknown) { this.body = value; return this; } };
}

test('backend manager errors always include JSON bodies with code and sanitized details', async () => {
  const original = console.error; console.error = () => {};
  try {
    const conflict = responseCapture(); await runManagerRequest(conflict as any, async () => { throw new ReservationApprovalError('review_evidence_required', 'Open review before deciding.', 409); });
    assert.deepEqual(conflict.body, { ok: false, status: 409, code: 'review_evidence_required', message: 'Open review before deciding.', details: null, error: 'Open review before deciding.' });
    const failure = responseCapture(); await runManagerRequest(failure as any, async () => { throw new Error('SQL and secret must not escape'); });
    assert.equal(failure.statusCode, 500); assert.equal(failure.body.code, 'reservation_management_failed'); assert.doesNotMatch(JSON.stringify(failure.body), /SQL|secret/);
  } finally { console.error = original; }
});

test('proxy normalization preserves valid 200, 409 and 500 JSON status and body', () => {
  for (const status of [200, 409, 500]) {
    const body = JSON.stringify({ ok: status === 200, status, code: status === 200 ? undefined : 'controlled', data: status === 200 ? {} : undefined });
    assert.deepEqual(normalizeManagerProxyResponse(status, 'application/json; charset=utf-8', body), { status, body });
  }
});

test('proxy normalization never exposes an empty, invalid JSON or HTML manager response', () => {
  for (const [contentType, body, code] of [['application/json', '', 'manager_proxy_empty_response'], ['application/json', '{', 'manager_proxy_invalid_response'], ['text/html', '<h1>error</h1>', 'manager_proxy_invalid_response']] as const) {
    const normalized = normalizeManagerProxyResponse(500, contentType, body); const payload = JSON.parse(normalized.body);
    assert.equal(normalized.status, 500); assert.equal(payload.ok, false); assert.equal(payload.code, code); assert.doesNotMatch(normalized.body, /<h1>/);
  }
});

test('frontend parser reads the body once and converts empty, invalid and non-JSON responses into controlled errors', async () => {
  for (const [response, code] of [
    [new Response('', { status: 500, headers: { 'content-type': 'application/json' } }), 'api_response_empty'],
    [new Response('{', { status: 500, headers: { 'content-type': 'application/json' } }), 'api_response_invalid_json'],
    [new Response('<html>', { status: 500, headers: { 'content-type': 'text/html' } }), 'api_response_unexpected_content_type'],
  ] as const) await assert.rejects(() => parseApiJsonResponse(response), (error: any) => error instanceof ApiResponseError && error.code === code && error.name !== 'SyntaxError');
});

test('frontend parser preserves controlled backend 409 messages and accepts successful data', async () => {
  const success = await parseApiJsonResponse<{ reviewEvidence: { status: string } }>(new Response(JSON.stringify({ ok: true, status: 200, data: { reviewEvidence: { status: 'current' } } }), { status: 200, headers: { 'content-type': 'application/json' } }));
  assert.equal(success.data.reviewEvidence.status, 'current');
  await assert.rejects(() => parseApiJsonResponse(new Response(JSON.stringify({ ok: false, status: 409, code: 'review_evidence_required', message: 'Open review first.', details: null }), { status: 409, headers: { 'content-type': 'application/json' } })), (error: any) => error.code === 'review_evidence_required' && error.status === 409);
});

test('real proxy and page source use safe transport, one parser and review-state decision guards', () => {
  const proxy = fs.readFileSync(path.resolve(import.meta.dirname, '../../../front/app/api/manager/[...path]/route.ts'), 'utf8');
  const page = fs.readFileSync(path.resolve(import.meta.dirname, '../../../front/app/(admin)/dashboard/reservations/page.tsx'), 'utf8');
  const mine = fs.readFileSync(path.resolve(import.meta.dirname, '../../routes/reservationsMine.ts'), 'utf8');
  assert.match(proxy, /await request\.text\(\)/); assert.doesNotMatch(proxy, /request\.json\(\)/); assert.match(proxy, /await response\.text\(\)/);
  assert.doesNotMatch(page, /response\.json\(\)/); assert.match(page, /parseApiJsonResponse/g); assert.match(page, /disabled=\{!canApprove\}/); assert.match(page, /disabled=\{!canReject\}/);
  assert.match(page, /Abrir análise/); assert.match(page, /Atualizar evidência/); assert.match(page, /Nenhuma decisão foi tomada/); assert.match(page, /Detalhes técnicos/);
  assert.match(page, /setError\(null\)/); assert.match(page, /review_evidence_stale/); assert.match(page, /status: ["']stale["']/);
  assert.match(page, /needsOverride/); assert.match(page, /reasonPresent/); assert.match(page, /Reconheço o alerta da evidência/);
  assert.match(mine, /studentReservationsSql/); assert.match(mine, /toStudentReservation/);
});
