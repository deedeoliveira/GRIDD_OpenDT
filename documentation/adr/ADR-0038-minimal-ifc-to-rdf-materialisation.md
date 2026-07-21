# ADR-0038 — Minimal IFC-to-RDF materialisation per model version

Status: accepted for the Prompt 7D research prototype (2026-07-20).

## Context

The project needs executable evidence linking one immutable IFC version to its persistent SQL spaces/assets without claiming full ifcOWL, geometry conversion, SHACL, eligibility or reservation semantics.

## Decision

Use a governed public `ifc_rdf_mapping` JSON revision (`file_executed`) as a validated declarative allowlist. Materialise only model/version provenance, managed spaces/assets and their version-specific IFC manifestations with selected BOT, BEO, PROV-O, Dublin Core Terms and the small project namespace.

Each successful model version has one internally generated graph URI:

`{GRAPH_BASE_URI}/graph/model-version/{modelVersionUuid}`

SQL stores lifecycle/evidence in `model_version_semantic_materialisations`; Turtle remains in the immutable version directory and Fuseki contains the verified query copy. The graph is written and remotely counted before activation in `required` mode. Existing graphs are verified/reused during safe retry and never overwritten or deleted as rollback behaviour.

Persistent resource URIs use SQL UUIDs. IFC GUID identifies only a manifestation; Reference and Tag remain literals and identity evidence. `prov:specializationOf` links a manifestation to its persistent operational resource. `owl:sameAs` is not used.

## Consequences

- V1 and V2 have different version graphs and manifestations while reusing persistent space/asset URIs.
- Geometry, full property-set export, full ifcOWL, reservations, actor links, institutional data, IDS XML and SHACL results are absent.
- `disabled` preserves legacy behaviour; `best_effort` records a retryable semantic failure without blocking IFC activation; `required` blocks activation until verification.
