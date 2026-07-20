# Prompt 7C — IDS validation implementation report

## Insertion points

The real upload entry is `handleModelUpload`. Its existing
`model_requirements_preflight` ran after IfcOpenShell inventory extraction and
before entities, spaces, assets and activation. Failures already marked the new
version failed, cleaned its temporary/promoted data and preserved the previous
current version. The provider insertion point was
`modelRequirementsProvider.ts`; the Python stack was `back/python`.

The 7B1 registry already reserved `ids_profile`, but assumed every revision had
a non-null named graph and `graph_verified` activation. Prompt 7C generalizes
this with `graph_backed|file_executed`, nullable graph identity, executor
metadata and file verification.

## Implementation

- Genuine executor: IfcTester 0.8.4 with IfcOpenShell 0.8.4.post1, pinned in the
  project venv requirements. `IfcOpenShellIdsValidationProvider` calls a
  bounded Python process and returns sanitized normalized JSON.
- Governed profile: `oswadt-ifc4-model-requirements-v1.ids`, public synthetic,
  IDS/XML, version 1.0.0. It requires an IFC4 `IfcSpace` Reference matching
  `R-000`, an EQP-prefixed Tag for applicable furnishing equipment, and
  ObjectType on applicable building element proxies.
- Composition: IDS and project rules retain separate source fields. Duplicate
  Reference is intentionally a project rule and demonstrates why IDS
  completeness is not cross-instance uniqueness.
- Reports: normalized run/result tables store provenance, modes, statuses and
  bounded messages; never IFC/XML bodies, secrets, SQL, SPARQL or stacks.
- Demo: three allowlisted real IFC fixtures, a feature-gated POST API, CLI,
  idempotent dry-run/execute setup and `/ids-demo`.

## Non-goals

No IFC-to-RDF, BOT/BEO/ifcOWL materialization, SHACL execution, semantic
eligibility, reservation policy, approval, authentication, authorization,
manager editing UI or arbitrary IDS/IFC upload was added.
