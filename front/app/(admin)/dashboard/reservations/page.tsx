'use client';

import { useEffect, useState } from 'react';
import { ApiResponseError, parseApiJsonResponse } from '@/lib/apiResponse.mts';

type Row = {
  id: number; status: string; asset_code: string; name: string;
  start_time: string; end_time: string; actor_id: string;
  shadow_eligibility_outcome: string | null; sql_availability_status: string | null;
  reason: string | null;
};
type Review = {
  status: 'current' | 'stale' | 'expired' | 'session_ended' | 'failed';
  run_uuid?: string; reviewed_at?: string; expires_at?: string; stale_reason?: string | null;
  actor_link_id?: number | null; institutional_artifact_id?: number | null;
  model_version_id?: number | null; materialisation_id?: number | null;
  structural_validation_run_id?: number | null; policy_artifact_id?: number | null;
  shadow_eligibility_outcome?: string | null; sql_availability_status?: string | null;
};
type UiError = { message: string; details: string; code: string };

function uiError(error: unknown): UiError {
  if (error instanceof ApiResponseError) return { message: error.message, details: error.technicalDetails, code: error.code };
  return { message: 'The operation could not be completed. Please retry.', details: 'Unexpected client error; no server payload was exposed.', code: 'technical_error' };
}

function reviewState(value: Review | undefined) {
  if (!value) return 'absent';
  if (value.status === 'current' && value.expires_at && new Date(value.expires_at).getTime() <= Date.now()) return 'expired';
  return value.status;
}

export default function ReservationManagement() {
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<UiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reason, setReason] = useState<Record<number, string>>({});
  const [acknowledged, setAcknowledged] = useState<Record<number, boolean>>({});
  const [review, setReview] = useState<Record<number, Review>>({});
  const [busy, setBusy] = useState<Record<number, boolean>>({});
  const [statusFilter, setStatusFilter] = useState('pending');
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 25, totalItems: 0, totalPages: 1 });
  const formatUtc = (value: string) => new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Lisbon' }).format(new Date(value.endsWith('Z') ? value : `${value.replace(' ', 'T')}Z`));

  const load = async (requestedPage = page, requestedStatus = statusFilter) => {
    try {
      const response = await fetch(`/api/manager/reservations?page=${requestedPage}&pageSize=25&status=${requestedStatus}`, { cache: 'no-store' });
      const payload = await parseApiJsonResponse<{ items: Row[]; page: number; pageSize: number; totalItems: number; totalPages: number }>(response);
      setRows(payload.data.items); setPagination(payload.data); setPage(payload.data.page); setError(null);
    } catch (caught) { setError(uiError(caught)); }
  };
  useEffect(() => { void load(page, statusFilter); }, [page, statusFilter]);

  const openDetail = async (id: number, refresh = false) => {
    setBusy((current) => ({ ...current, [id]: true })); setError(null); setNotice(null);
    try {
      const response = await fetch(`/api/manager/reservations/${id}${refresh ? '/refresh-evidence' : ''}`, {
        method: refresh ? 'POST' : 'GET',
        headers: { Accept: 'application/json' },
      });
      const payload = await parseApiJsonResponse<{ reviewEvidence: Review; refreshed: boolean }>(response);
      setReview((current) => ({ ...current, [id]: payload.data.reviewEvidence }));
      setNotice(refresh
        ? `Evidence refreshed for this review at ${formatUtc(payload.data.reviewEvidence.reviewed_at!)}. No decision was made.`
        : `Review opened for request #${id}. No decision was made.`);
      await load();
    } catch (caught) {
      setError(uiError(caught));
      setReview((current) => current[id] ? current : ({ ...current, [id]: { status: 'failed' } }));
    } finally { setBusy((current) => ({ ...current, [id]: false })); }
  };

  const decide = async (id: number, action: 'approve' | 'reject' | 'cancel') => {
    setBusy((current) => ({ ...current, [id]: true })); setError(null); setNotice(null);
    try {
      const response = await fetch(`/api/manager/reservations/${id}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ reason: reason[id] ?? '', overrideAcknowledged: acknowledged[id] === true }),
      });
      await parseApiJsonResponse(response);
      setNotice(`Request #${id} was ${action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'cancelled'}.`);
      await load();
    } catch (caught) {
      const nextError = uiError(caught); setError(nextError);
      if (nextError.code === 'review_evidence_stale') setReview((current) => current[id] ? ({ ...current, [id]: { ...current[id], status: 'stale' } }) : current);
      if (nextError.code === 'review_evidence_required') setReview((current) => { const next = { ...current }; delete next[id]; return next; });
    }
    finally { setBusy((current) => ({ ...current, [id]: false })); }
  };
  const logout = async () => { await fetch('/api/auth/logout', { method: 'POST' }); window.location.assign('/login'); };

  return <main className="min-h-screen bg-slate-950 p-8 text-slate-100">
    <div className="flex items-center justify-between gap-4"><h1 className="text-3xl font-bold">Reservation management</h1><button onClick={logout}>Logout</button></div>
    <p className="mt-2 text-slate-300">Operational decisions are made by scoped application managers. Semantic evidence is shadow only; SQL is rechecked before approval.</p>
    <div className="mt-4 flex flex-wrap items-center gap-3"><label>Status: <select className="bg-slate-900 p-2" value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); setPage(1); }}><option value="pending">pending</option><option value="all">all</option><option value="approved">approved</option><option value="rejected">rejected</option><option value="cancelled">cancelled</option><option value="in_use">in use</option><option value="completed">completed</option></select></label><span>Showing {rows.length} of {pagination.totalItems} requests</span><button disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page} of {pagination.totalPages}</span><button disabled={page >= pagination.totalPages} onClick={() => setPage(page + 1)}>Next</button><button onClick={() => load(page, statusFilter)}>Refresh queue</button></div>
    {error && <div className="mt-4 rounded bg-rose-950 p-3" role="alert"><p>{error.message}</p><details className="mt-2 text-sm"><summary>Technical details</summary><code>{error.details}</code></details></div>}
    {notice && <p className="mt-4 rounded bg-emerald-950 p-3" role="status">{notice}</p>}
    <div className="mt-6 space-y-4">{rows.map((row) => {
      const evidence = review[row.id]; const state = reviewState(evidence); const reviewOutcome = evidence?.shadow_eligibility_outcome ?? row.shadow_eligibility_outcome;
      const needsOverride = reviewOutcome === 'not_eligible' || reviewOutcome === 'indeterminate';
      const reasonPresent = Boolean(reason[row.id]?.trim()); const reviewReady = row.status === 'pending' && state === 'current' && !busy[row.id];
      const canReject = reviewReady && reasonPresent; const canApprove = reviewReady && (!needsOverride || (acknowledged[row.id] === true && reasonPresent));
      return <article className="rounded border border-slate-700 p-4" key={row.id}>
        <div className="flex flex-wrap justify-between gap-2"><b>#{row.id} - {row.status}</b><span>{row.asset_code} - {formatUtc(row.start_time)} to {formatUtc(row.end_time)}</span></div>
        <p className="mt-2 text-sm">Requester: {row.actor_id} - Submission shadow: {row.shadow_eligibility_outcome ?? 'none'} - Submission SQL snapshot: {row.sql_availability_status ?? 'recheck on decision'}</p>
        <p className="mt-2 text-sm" id={`review-state-${row.id}`}>Review status: <b>{state}</b>{state === 'absent' && ' - Open this request before deciding.'}{state === 'session_ended' && ' - Open a new review in this session.'}{(state === 'stale' || state === 'expired') && ' - Refresh evidence before deciding.'}{state === 'failed' && ' - Retry opening or refreshing the review.'}</p>
        <div className="mt-2 flex gap-2">
          {(state === 'absent' || state === 'session_ended' || state === 'failed') && <button disabled={busy[row.id]} onClick={() => openDetail(row.id)}>Open review</button>}
          {state !== 'absent' && state !== 'session_ended' && <button disabled={busy[row.id]} onClick={() => openDetail(row.id, true)}>Refresh evidence</button>}
        </div>
        {evidence?.run_uuid && <div className="mt-3 rounded bg-slate-900 p-3 text-sm">
          <p>Reviewed at: {formatUtc(evidence.reviewed_at!)} - belongs to the current review session</p>
          <dl className="mt-2 grid gap-1 sm:grid-cols-2"><div>Evidence run: {evidence.run_uuid}</div><div>Actor evidence link: {evidence.actor_link_id ?? 'none'}</div><div>Institutional source: {evidence.institutional_artifact_id ?? 'none'}</div><div>Model version: {evidence.model_version_id ?? 'none'}</div><div>Materialisation: {evidence.materialisation_id ?? 'none'}</div><div>Structural evidence: {evidence.structural_validation_run_id ?? 'none'}</div><div>Policy artifact: {evidence.policy_artifact_id ?? 'none'}</div><div>Shadow outcome: {evidence.shadow_eligibility_outcome ?? 'indeterminate'}</div><div>SQL snapshot: {evidence.sql_availability_status ?? 'not available'}</div></dl>
        </div>}
        {['pending', 'approved'].includes(row.status) && <div className="mt-3 flex flex-wrap gap-2">
          <input className="rounded bg-slate-900 p-2" placeholder="Reason (required to reject, override, or cancel)" value={reason[row.id] ?? ''} onChange={(event) => setReason({ ...reason, [row.id]: event.target.value })} />
          {row.status === 'pending' && needsOverride && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={acknowledged[row.id] === true} onChange={(event) => setAcknowledged({ ...acknowledged, [row.id]: event.target.checked })} />I acknowledge this shadow outcome for approval</label>}
          {row.status === 'pending' && <><button aria-describedby={`review-state-${row.id}`} disabled={!canApprove} onClick={() => decide(row.id, 'approve')}>Approve</button><button aria-describedby={`review-state-${row.id}`} disabled={!canReject} onClick={() => decide(row.id, 'reject')}>Reject</button></>}
          <button disabled={busy[row.id]} onClick={() => decide(row.id, 'cancel')}>Cancel</button>
        </div>}
        {row.status === 'pending' && state === 'current' && !reasonPresent && <p className="mt-2 text-sm">A reason is required to reject. For a non-eligible or indeterminate shadow outcome, approval also requires this reason and the acknowledgement above.</p>}
        {row.reason && <p className="mt-2">Decision reason: {row.reason}</p>}
      </article>;
    })}</div>
  </main>;
}
