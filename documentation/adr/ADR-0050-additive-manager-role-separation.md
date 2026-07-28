# ADR-0050 — Additive manager-role separation (BIM vs operational)

## Status

Accepted. Supersedes the mandatory per-asset-scope requirement of
[ADR-0046](./ADR-0046-application-authorization-and-management-scopes.md) and
refines the session contract of
[ADR-0045](./ADR-0045-session-resolved-identity-boundary.md).

## Context

The demonstrator previously had a single application role,
`reservation_manager`, which the server collapsed into a binary
`applicationArea` (`manager`/`student`). That one role gated **both** the BIM
model-intake workspace and the operational reservation-decision workspace, and
acting on a reservation additionally required an explicit per-asset
`reservation_management_scopes` row (ADR-0046). BIM management and operational
management could not be granted independently, and a manager account was
redirected away from the normal resource-reservation workspace.

## Decision

1. **Roles are additive.** The existing `application_account_roles` join table is
   retained unchanged; an account may hold neither, either, or both canonical
   roles.

2. **Canonical roles** are `bim_manager` and `operational_manager`. Management
   roles *add* capabilities and never remove the basic user capability.

3. **Explicit capabilities are the authority.** The server resolves, per request,
   from active grants and account status:
   - `reserveResources` — every active human account (managers included);
   - `bimManagement` — accounts with `bim_manager`;
   - `operationalManagement` — accounts with `operational_manager` (or the
     transitional `reservation_manager`, see below).
   Suspended/disabled accounts receive no active capability. Capabilities are
   derived only from roles and status — **never** from asset scopes.

4. **`applicationArea` is a temporary compatibility alias only** (`manager` when
   any management capability is present, else `student`). It is no longer the
   authority for any route access; centralised helpers (`requireReserveResources`,
   `requireBimManagement`, `requireOperationalManagement`) enforce capabilities.

5. **Operational-manager access is global for this phase.** Listing, opening,
   refreshing evidence for, approving, rejecting and cancelling reservations
   require only `operationalManagement`. The `reservation_management_scopes`
   table and its rows are retained but **dormant** future-granularity
   infrastructure; they are never read or written by the operational path. This
   supersedes ADR-0046's mandatory per-asset scope.

6. **Transitional role compatibility.** The pre-migration key
   `reservation_manager` is still recognised as granting `operationalManagement`,
   but the API always normalises the exposed role to `operational_manager`, and
   new documentation, new decision snapshots and new setup scripts use
   `operational_manager`. `reservation_manager` remains only a transitional
   database compatibility key, avoiding a deployment window where new code cannot
   operate against a pre-migration database.

7. **Historical decision snapshots are never rewritten.** Existing
   `reservation_decisions.manager_role_snapshot = 'reservation_manager'` rows
   correctly record the label used at the time. New decisions record
   `manager_role_snapshot = 'operational_manager'` and
   `management_scope_snapshot = 'global'`.

8. **Opaque sessions remain server-resolved.** No role or capability is embedded
   in the browser cookie; identity and capabilities are resolved server-side each
   request (ADR-0045 preserved).

## Migration

The forward migration runs inside a **single transaction**. It renames the
`reservation_manager` catalogue row **in place** to `operational_manager`,
preserving its `application_role_id` and therefore every existing grant, and
inserts `bim_manager` if absent. An **explicit dual-state guard** (independent of
the `normalized_role_key` UNIQUE key) raises an error when both
`reservation_manager` and `operational_manager` already exist; the runner
(`runSqlFile.ts`, improved to issue an explicit `ROLLBACK` on error) then rolls
the whole transaction back, so a failure leaves the catalogue exactly as before —
no partial insert or rename. Re-running an already-migrated catalogue is a safe
no-op.

The paired rollback is also a single transaction and is **guard-first**: if any
`bim_manager` grant exists it raises an explicit error and rolls back before
renaming or deleting anything, leaving the catalogue untouched; the `RESTRICT`
foreign key `application_account_roles.fk_account_role_role` is the final backstop.
It never uses CASCADE and never deletes a grant. Rollback after operational use may
still require manual intervention and never rewrites the immutable historical
`reservation_decisions.manager_role_snapshot` values.

Both directions are verified on a disposable, throwaway MySQL schema (never the
operational/demo database) by `back/scripts/migrationSelfTest.ts`, covering the
legacy, already-migrated, invalid-dual, safe-rollback, unsafe-rollback and
historical-snapshot states. Verify there first; before applying to the active
development/demo database, create a fresh backup and review the plan. The archived
post-presentation backup/tag baseline must remain untouched.

## Consequences

- BIM and operational management are independently grantable; both-role accounts
  see both workspaces plus resource reservation.
- The front end derives navigation cards and page guards from capabilities:
  *Reservar recursos*, *Gestão BIM*, *Gestão operacional*. BIM-only accounts
  cannot load the operational page and vice-versa.
- Manager accounts can use the normal `/student` reservation workspace.
- The scope table stays available for a future re-tightening of operational
  granularity without a schema change.
- This ADR deliberately excludes RDF graph-versioning research, which is a
  separate architectural decision.
