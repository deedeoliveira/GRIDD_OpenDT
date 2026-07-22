# ADR-0048 — demonstrator interface consolidation

## Decision

The research demonstrator presents a session-resolved student or manager area.
Existing models are selected from the current schema; no building entity,
building onboarding, or first model-line creation is introduced.

The main interface is task-oriented and in Portuguese (pt-PT). Technical
identifiers, hashes, graph references and provenance remain available under
expandable details. Dates are displayed in `Europe/Lisbon`; UTC remains the
storage and API authority. A building-owned timezone is future work.

## Boundaries

SQL remains the transactional authority. The manager makes operational
decisions from application role and scope. Semantic eligibility remains shadow
only. IDS, project rules and SHACL remain distinct validation layers.
