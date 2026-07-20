# ADR-0032 — Governed Semantic Artifact Registry

- Status: accepted
- Date: 2026-07-20
- Scope: Prompt 7B1

## Context

Ontologies, bridge vocabularies, shape sets and synthetic datasets need an operational identity and lifecycle without making a mutable file, a filename, or a Fuseki alias authoritative. The institutional ontology in this release is a non-official draft research artefact; activation means only “selected for the demonstrator”.

## Decision

The audited Turtle file is authoritative for source payload bytes. SQL is authoritative for family/revision identity, integrity evidence, lifecycle, operations and the current pointer. Fuseki stores an immutable, queryable copy in a revision-specific named graph.

Three tables implement this boundary:

- `semantic_artifact_families`: stable family identity and current pointer;
- `semantic_artifacts`: immutable revision metadata, hash, graph URI and validation/lifecycle state;
- `semantic_artifact_load_operations`: idempotency, attempts, recovery and sanitized errors.

The service enforces same-family eligibility inside a transaction because a foreign key cannot express that cross-table predicate. Activation locks the family row, revalidates the candidate, compares the expected current pointer, supersedes the previous active revision and moves the pointer atomically. A concurrent loser receives `activation_conflict`.

Integrity, Fuseki parsing/loading and post-load graph verification are distinct evidence. Governing a SHACL shape graph does not execute SHACL.

## Consequences

- Filename is metadata, never identity; RDF payload is not stored in SQL.
- Reusing a family/version with different bytes is terminal; reusing the same family hash under a different version is rejected.
- An operation/idempotency named lock spans Fuseki I/O and therefore occupies one dedicated MySQL connection during that bounded CLI operation. Family row locks are held only during short SQL activation transactions.
- Migrations remain manually applied; startup performs no semantic loading.
- No HTTP mutation route is introduced.

## Not decided or implemented

Institutional domain queries, actor links, institutional policy/eligibility, authentication/authorization, SHACL execution, IDS and IFC-to-RDF remain outside this ADR.
