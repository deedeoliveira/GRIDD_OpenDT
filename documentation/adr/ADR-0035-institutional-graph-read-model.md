# ADR-0035 — Read-only institutional graph model

- Status: accepted
- Date: 2026-07-20
- Scope: Prompt 7B2

## Decision

The institutional feature resolves the active ontology, synthetic dataset and bridge revisions through the Semantic Artifact Registry. Client-supplied graph URIs, operational/test graphs and mutable aliases are rejected.

`InstitutionalGraphProvider` exposes typed people, organizations, memberships, roles, supervisors and artifact provenance. The Fuseki implementation owns controlled parameterized SPARQL builders using the existing IRI/literal escaping. It returns domain objects rather than raw SPARQL JSON. Empty results, including a missing supervisor assertion, are valid.

Labels prefer Portuguese, then English, then untagged labels, then URI local names. Student numbers remain strings and are optional. No inference, SHACL execution or complete reasoning is claimed.

The HTTP surface contains only GET context and synthetic-demo-list routes. Feature and demo modes default off. The frontend calls application API proxies only and has no direct Fuseki access.

## Failure and observability

Unavailable/timeout/malformed graph responses map to sanitized domain errors. Structured logs contain correlation/link/artifact identifiers, duration and counts—not person labels, student numbers, queries, graph contents or credentials.

## Non-goals

Authentication, authorization, institutional eligibility, reservation decisions, approval, RDF actor-link materialization, private data, IDS and IFC-to-RDF are outside this read model.
