# ADR-0037 — Composed model-requirements validation

Status: accepted for implementation, pending researcher walkthrough.

## Decision

The preflight is composed of two explicit layers:

1. `ids`: standard-expressible per-entity information requirements executed by
   IfcTester over the governed active profile.
2. `project_rule`: cross-instance, identity and federation rules owned by the
   application.

`disabled` preserves the prior project validator and does not execute or
persist IDS. `report_only` persists IDS results but an IDS failure does not
block activation. `required` blocks on IDS failure. Project-rule failure
remains blocking in every enabled mode.

## Boundaries

Duplicate References/Tags, spatial authority, identity continuity,
Tag/serial conflicts, historical reconciliation, current-version semantics,
availability, reservability, eligibility, approval and reservation
transactions remain outside IDS. Upload validation completes before inventory,
identity, asset and activation writes. A blocked version follows the existing
compensation path, so the previous current version remains current.
