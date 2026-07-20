# Prompt 7B1 — Governed semantic artefacts

Date: 2026-07-20. Baseline: `bffe8dbf3aed26cbcf9bd49192a24d66c74ad4de`.

## Implemented boundary

This stage commits only five approved Turtle files: four public/synthetic runtime artefacts and one synthetic negative test fixture. The institutional TBox is a draft research artefact, is not official, published, approved or maintained by UMinho, and its research namespace may change before thesis publication. The public manifest contains no private classification or external package manifest.

| Authority | Responsibility |
|---|---|
| audited Turtle file | immutable source bytes |
| SQL registry | operational identity, lifecycle, validation evidence, current pointer, idempotency, retry and sanitized errors |
| revision named graph | immutable queryable copy |
| existing operational graph | non-modelled asset authority; isolated and untouched by this workflow |

## Public subset and integrity

| Artefact | Classification | SHA-256 | Bytes | Expected triples |
|---|---|---:|---:|---:|
| institutional ontology | public research | `977de2e5af18fa7059f68c2f48796121344bfaae856dbf62fc3e9a1699f9e987` | 22904 | 457 |
| project/institutional bridge | public research | `1251392c267b34701315797ac0ffafe893258a6cad90f3eeaa70671f28fd3715` | 6248 | 103 |
| structural shape set | public research | `3d3c15bffc8bae85d076bac1602ea309610f171993d56d28b452644f1d425e0c` | 4560 | 72 |
| positive institutional dataset | synthetic runtime | `cd7896437b6a7c7cc9d2871f714c5885014ca5aeabf6f6a4a996a148de845c3f` | 5491 | 115 |
| negative fixture | synthetic test only | `355e23768a209201cb80aa1066f16757c549abefc1670341b3519385be025659` | 1874 | 33 |

Files are copied byte-for-byte and never reserialized. Automated validation checks allowlist membership, containment/no traversal, SHA-256, size, Turtle media/serialization, privacy and exact declared tree. The negative fixture is non-activatable and excluded from `load-public`.

## Registry, lifecycle and saga

The migration creates families, revisions and load operations with UUID/key/version/hash/graph/idempotency uniqueness. Artifact lifecycle is `staged → validated → active → superseded` (with `retired` and `failed` reserved). Validation state is independent: `not_validated → integrity_validated → graph_verified`.

The saga is:

`manifest → integrity → converge family/revision/operation → PUT exclusive graph → count/resource verification → graph_verified → transactional activation → completed`.

The same idempotency key and payload converges. A changed payload conflicts. Retry keeps operation UUID, artifact UUID, graph URI and hash. A completed operation does not rewrite a graph. Graph-written/SQL-failed state is recoverable; Fuseki failure is retryable; verification mismatch is terminal. Stored errors are bounded and omit payload, SPARQL and credentials.

Activation uses an operation named lock plus a short family-row transaction/CAS. The named lock uses a dedicated MySQL connection while Fuseki I/O occurs; no family row lock is held while reading/hashing/loading. Concurrent candidates have one winner. Rollback is an audited idempotent activation of an earlier eligible revision and performs no graph deletion.

## CLI and configuration

Local commands are `semantic:artifacts:validate`, `load-public`, `load -- --key`, `retry -- --operation`, `rollback -- --family --to-version`, and `status`. Validate is read-only; load and rollback support `--dry-run` where meaningful. Loading requires `SEMANTIC_ARTIFACT_LOADING_ENABLED=true`; default is false. Graph endpoints and credentials come only from existing `GRAPH_*` configuration. Startup does not load artifacts and no Express write route was added.

## Validation terminology

Implemented evidence is named `integrity_validation`, `fuseki_parsing_loading_validation`, and `post_load_graph_verification`. The shape set is governed RDF only. No SHACL engine or SHACL execution exists, and no result is described as SHACL-validated.

## Verification performed

Automated tests use filesystem fixtures and deterministic in-memory SQL/graph fakes; they do not require live MySQL or Fuseki. The local validation CLI verified all five hashes/sizes. The SQL migration and real Fuseki load were deliberately not executed. See `MANUAL_TESTS.md` for the pending opt-in procedure.

## Explicitly not implemented

No institutional person/membership/supervisor queries, actor links, institutional API, private demo data, SHACL execution or eligibility, IDS, IFC-to-RDF, policy/reservation changes, approval, manager UI, operational graph migration, sensors or official ontology publication.

## Limitations and residual risks

- SQL DDL is still manually applied; the project has no migration ledger.
- MySQL/Fuseki integration remains a human opt-in test, so runtime credentials, connectivity and the exact Fuseki parser behaviour are not evidenced by default tests.
- Immutable graphs require future retention/orphan diagnostics; rollback intentionally does not reclaim storage.
- The non-official research namespace may migrate before publication.
