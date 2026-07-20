# ADR-0034 — Controlled actor-to-institutional-agent links

- Status: accepted
- Date: 2026-07-20
- Scope: Prompt 7B2

## Context

`res_reservations.actor_id` is client-supplied text. There is no account table, authentication or verified user identity. Nevertheless, the synthetic demonstrator needs an auditable association between a platform actor key and an RDF institutional agent.

## Decision

SQL is authoritative for the association, lifecycle, validity, verification history and exact institutional dataset revision. RDF remains authoritative for the person, identifiers, memberships, roles, organizations and supervision. The association ABox is not written to RDF and never uses `owl:sameAs`.

`actor_institutional_links` stores the original and normalized actor key, agent URI, exact dataset artifact FK, one controlled link type, lifecycle timestamps and verification source. Actor keys are trimmed, case-normalized for comparison, length-bounded and control-character checked; they are never converted into URIs.

MySQL 8 generated-column uniqueness permits at most one stored `verified` current link per normalized actor/type while retaining superseded, revoked and suspended history. A named lock serializes changes for one actor key; graph existence checks occur before that lock, and the SQL transaction revalidates the dataset current pointer.

## Consequences

- A superseded dataset revision yields `requires_reverification`; its historical graph is not current evidence.
- Pending, suspended, revoked, superseded and expired links never trigger person graph queries.
- Seeds are explicit, idempotent, synthetic-only CLI operations and never run at startup.
- Links do not authenticate, authorize, determine eligibility/reservability, approve or alter reservations.
