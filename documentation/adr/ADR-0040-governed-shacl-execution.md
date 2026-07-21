# ADR-0040 — Governed SHACL execution

Status: accepted for the Prompt 7E research prototype (2026-07-20).

## Context

Loading a Turtle shapes graph proves artifact integrity, not SHACL execution.
Structural validation needs a standards-compatible engine, exact data/shapes
hashes, explainable results and a boundary that cannot be confused with IDS,
project rules or operational policy.

## Decision

Use `SemanticValidationProvider` as the application boundary and
`PyShaclValidationProvider` as the production implementation. The provider
starts pinned pySHACL 0.40.0 in the project Python venv, sends RDF through
stdin, disables ontology imports, applies meta-SHACL, and returns a normalized
contract containing focus node, path, value, source shape, constraint
component, severity and message. Timeouts, cancellation and sanitized errors
are part of the boundary.

The public `oswadt-model-rdf-structural-shapes` family is immutable,
graph-backed and selected through the semantic registry current pointer.
Backend code verifies repository hash/size, Turtle, allowlisted namespaces,
meta-SHACL and the governed graph URI. Constraint descriptions shown by the UI
are extracted from the selected Turtle; they are not frontend presets.

Local/dev may inspect and execute one temporary `.ttl` upload. It is hashed and
meta-SHACL checked by the backend, never registered, activated or loaded into
Fuseki, and is removed after the request. Imports, external execution inputs,
client graph URIs, path traversal, symlinks and oversize payloads are rejected.

## Consequences

- pySHACL execution is executable evidence; artifact loading remains a
  separate governance event.
- Preview reports are ephemeral and write neither data nor report graphs.
- Persistent runs store normalized SQL evidence and an immutable report graph,
  never the complete RDF payload in SQL.
- SHACL validates graph structure/quality only. It does not authenticate,
  authorize, decide eligibility/reservability/availability/approval, resolve
  temporal conflicts or execute reservation transactions.
