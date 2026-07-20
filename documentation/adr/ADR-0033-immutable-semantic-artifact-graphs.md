# ADR-0033 — Immutable Semantic Artifact Named Graphs

- Status: accepted
- Date: 2026-07-20
- Scope: Prompt 7B1

## Context

`putGraph()` replaces the target graph. A mutable `current`, `active` or `latest` graph would make retry and rollback destructive and blur authority between SQL and Fuseki.

## Decision

Every registry revision receives an internally generated UUID and one graph URI below `GRAPH_BASE_URI`:

| Artifact role | Graph path |
|---|---|
| institutional ontology | `/graph/vocabularies/institutional-ontology/{artifactUuid}` |
| project/institutional bridge | `/graph/vocabularies/project-institutional-bridge/{artifactUuid}` |
| structural shapes | `/graph/validation/shapes/{artifactUuid}` |
| synthetic institutional data | `/graph/institutional-data/synthetic/{artifactUuid}` |
| negative fixture | `/graph/test/{runUuid}/negative/{artifactUuid}` |

Graph URIs are never client input. UUIDs and the configured base are validated, runtime releases never use `/graph/test/`, and semantic artefacts never use the existing `/graph/operational` authority graph.

A PUT is allowed only before activation and only for the registered artifact UUID/hash. Retry reuses that same artifact and graph. Once `graph_verified`, an activation retry skips PUT; once active, a revision can never receive another PUT.

Rollback changes only the SQL family pointer to an eligible graph-verified revision. It never deletes, clears, overwrites or aliases a historical graph.

## Verification and failure semantics

Fuseki accepting the Turtle is parsing/loading evidence. The loader then checks the exact triple count and, for ontology/bridge/shapes, the expected metadata resource. A graph written before a SQL failure is deliberately preserved; retry resumes the registered operation.

The CLI is opt-in, loading is disabled by default, and production reuses the repository’s explicit graph-write safety checks. No application startup hook or HTTP write endpoint exists.

## Consequences

Historical graphs consume storage but remain auditable and rollback-safe. Orphan diagnosis/retention policy is future work; broad `CLEAR`/`DROP` is forbidden.
