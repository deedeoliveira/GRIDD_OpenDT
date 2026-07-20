# Prompt 7B2 — Institutional context integration

Date: 2026-07-20. Baseline: 459 automated tests and Prompt 7B1 registry.

## Implemented

- SQL actor-to-agent links with pending/verified/suspended/revoked/superseded lifecycle, temporal validity, history, exact dataset revision and concurrency guard.
- Explicit synthetic-only idempotent seed with dry-run; no migration seed and no RDF write.
- Registry-resolved active ontology/dataset/bridge context.
- Read-only typed graph provider and controlled parameterized SPARQL builders.
- Actor context orchestration, provenance and mandatory caveats.
- GET-only institutional API, textual CLI and `/semantic-demo` functional page.
- Structured privacy-safe observability and fake vertical demonstrator.

## Authority boundary

SQL governs the link. The active synthetic institutional graph governs descriptions and relationships. The bridge describes the pattern but no actor-link ABox is materialized. `actor_id` and reservation behavior are untouched. An actor key is not an account, identity proof or URI, and no `owl:sameAs` is asserted.

## Functional scenarios

- Student 001: student number, research-group membership, two roles and one supervisor.
- Student 002: valid cluster membership and roles; no supervisor assertion, without error or negative decision.
- Revoked actor: link found, graph evidence deliberately not used.

Every response states synthetic data, unauthenticated actor key and absence of eligibility, authorization and reservation decisions.

## Safety

Features default disabled. Graph URIs come only from active registry pointers. Operational/test graphs and private classifications are excluded. API routes are GET-only; no proxy query, seed or verification endpoint exists. Frontend has no Fuseki endpoint or SPARQL.

## Automated evidence and unperformed infrastructure work

Deterministic fakes cover lifecycle, concurrency, escaping/injection, graph mapping, unavailable states, API serialization, frontend contracts and the complete vertical story. MySQL/Fuseki real infrastructure, migrations and seeds were not executed. No technical manual test is claimed.

## Scientific status

Institutional graph access, SQL actor-to-agent links and a synthetic functional demonstrator are implemented. Authentication, authorization, eligibility, SHACL, reservability and approval are not implemented.
