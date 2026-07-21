# ADR-0042 — Cross-domain semantic evidence for reservation requests

## Status

Accepted for controlled Prompt 7F walkthrough; feature disabled by default.

## Decision

The real reservation form may explicitly request a read-only evidence run for
the selected actor key, persistent asset and interval. The backend resolves the
verified SQL actor link and current institutional graph, current model-version
manifestation, latest structural SHACL run and the existing SQL temporal
conflict checks. It writes only a minimal immutable evidence graph and a
separate immutable policy-report graph.

The evidence graph references governed resources; it does not copy the
institutional/model graphs and excludes person names, student numbers,
credentials, complete IFC data, local paths and reservation payloads. SQL
stores normalized provenance/findings and can link the immutable snapshot to a
subsequently created reservation.

## Consequences

- “Check evidence” never creates a reservation.
- “Create reservation request” remains a separate explicit action using the
  existing transaction and conflict semantics.
- Evidence/run inputs are revalidated before an optional reservation link.
- Actor key is a research correlation key, not authentication.
- Evidence graphs are append-only per run UUID; no current/latest alias exists.
