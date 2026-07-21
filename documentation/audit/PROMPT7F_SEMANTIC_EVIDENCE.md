# Prompt 7F — Semantic evidence implementation report

## Baseline and short reservation audit

- Baseline: `main` at `0c3a784`, aligned with `origin/main`; 558 tests.
- Actor entry: `student/page.tsx` supplies the legacy actor value;
  `ReservationModal.tsx` now exposes the actor key as a researcher-controlled
  input with non-executing synthetic suggestions.
- Asset entry: the researcher chooses an asset before opening the real modal;
  the modal shows that selected persistent asset.
- Interval entry: start/end are selected in the modal and sent in the actual
  request body.
- Submission path: Next proxy `/api/reservation/request` forwards to backend
  `/api/reservation/request`, which invokes `ReservationDatabase.createReservation`.
- SQL conflicts: `approved`, `in_use`, `no_show` block every actor;
  `pending` and `approved` block the same actor. A third party is not blocked
  by another actor’s `pending` row.
- Cancellation: only the same actor may cancel; pending may be cancelled at
  any time; approved requires at least 24 hours; in-use/overdue cannot cancel.
- Read-only insertion: `/api/reservation/evidence` executes before creation and
  is outside the reservation transaction.
- Evidence association: a matching, unexpired run is checked before creation
  and linked after the existing transaction returns the pending reservation ID.
- Preserved transaction: asset `FOR UPDATE`, lifecycle checks, both existing
  conflict queries, booking snapshots and pending insert remain unchanged.

## Implemented layers

1. Institutional actor evidence: verified/revoked/expired link state, current
   dataset, agent URI, organizations and roles; student number omitted.
2. Resource evidence: persistent asset UUID/Tag/location, current model version,
   materialisation and IFC manifestation.
3. Structural evidence: latest completed model/materialisation SHACL run.
4. Shadow eligibility: governed SHACL policy executed by pySHACL.
5. SQL availability: existing conflict methods, explicitly `authority=sql`.
6. Operational result: only the separate creation action can create pending.

The evidence vocabulary and policy are separate immutable public artifacts.
Each run gets one evidence graph and one policy report graph. SQL stores no full
RDF payload. No policy upload, arbitrary graph URI, SPARQL, authorization,
approval or authoritative semantic decision was added.

Building onboarding remains future work. The current experience still depends
on pre-existing building/model/asset data. Prompt 7G is expected to consolidate
the final management interface; Prompt 7F changes only the real reservation
request modal.
