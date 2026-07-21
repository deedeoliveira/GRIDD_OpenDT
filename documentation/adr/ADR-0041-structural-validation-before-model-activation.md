# ADR-0041 — Structural validation before model activation

Status: accepted for the Prompt 7E research prototype (2026-07-20).

## Context

Prompt 7D creates an immutable RDF graph for a model version immediately
before SQL activation. Structural validation must use those exact generated
bytes and a failure must not replace the previous current version.

## Decision

The materialisation order is: IFC/IDS/project rules; persistent identity and
bindings; local RDF generation; governed local SHACL; immutable model graph
write; remote count/resource verification; immutable SHACL report graph; SQL
report persistence; model-version activation.

Modes are disabled by default. `disabled` preserves 7D. `report_only` records
the governed result without blocking materialisation. `required` accepts only
the active governed model shape set and requires `conforms=true`; temporary
shapes cannot decide activation. A failed required validation performs no model
graph write and the upload pipeline never advances to current-pointer change.

Report graph URIs are generated internally as
`{GRAPH_BASE_URI}/graph/validation/report/{runUuid}`. They have no current or
latest alias, are verified after a non-overwriting PUT and are retained across
SQL rollback.

## Consequences

- A preview can prove how changing only shapes changes a result without
  creating a model version.
- The final model RDF is validated again, so a reviewed preview cannot be used
  as a substitute for validating the persisted version bytes.
- The previous current model version remains authoritative on any required
  validation/materialisation failure.
- Building onboarding remains future work; the workspace still needs a
  pre-existing building and logical model line.
