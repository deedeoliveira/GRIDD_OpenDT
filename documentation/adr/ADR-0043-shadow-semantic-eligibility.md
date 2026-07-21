# ADR-0043 — Semantic eligibility is shadow-only

## Status

Accepted for Prompt 7F. No advisory, required or authoritative mode exists.

## Decision

`project-reservation-eligibility-shadow` 1.0.0 is a public, graph-backed,
project-specific SHACL policy. Pinned pySHACL evaluates the exact minimal
evidence graph against the exact governed policy bytes. The normalized outcome
is `eligible`, `not_eligible` or `indeterminate`; missing graphs and technical
failures are indeterminate.

The policy checks only current verified actor linkage, current institutional
dataset, an allowed governed institutional role, persistent asset/Tag, current
model manifestation and conforming structural validation. Temporal conflict,
availability, authentication, authorization, approval, capacity, concurrency,
reservation lifecycle and final decisions are outside the policy.

## Authority boundary

- SQL and the existing transaction remain authoritative for temporal
  availability, conflicts and reservation lifecycle.
- Actor-link SQL associates the actor key with an institutional agent.
- Governed graphs provide institutional/model facts.
- Structural SHACL is graph-quality evidence.
- Eligibility SHACL is non-binding shadow evidence.
- No approval or authorization workflow is introduced.
