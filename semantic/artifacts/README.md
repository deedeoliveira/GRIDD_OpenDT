# Governed semantic artefacts

This directory contains the public and synthetic subset of the UMinho institutional semantic package approved for this research prototype.

The institutional ontology is a **research artefact**. It is non-official and is not published, approved, or maintained by the University of Minho. Its namespace is a research namespace, the release is draft, and it may be migrated before thesis publication.

The five institutional source Turtle files remain byte-for-byte immutable.
Prompt 7E adds a sixth, independently versioned public Turtle shape set for
minimal model RDF; it does not modify the UMinho 1.1 shapes. Prompt 7C adds one
public synthetic IDS/XML profile. Prompt 7D adds one public declarative JSON
IFC-to-RDF mapping profile. Hashes, sizes, storage modes, privacy
classifications and activation rules are recorded in the public manifest.

Directory roles:

- `runtime/`: artefacts allowed to be operationally activated by their governed loader/executor;
- `test/`: synthetic test-only artefacts; these are never activated;
- the public manifest describes only this approved subset.

Loading either structural shape set is governance evidence, not SHACL
execution. Prompt 7E separately executes the selected bytes with pinned
pySHACL. The institutional negative fixture may only be combined in isolated
tests and is never loaded into the active institutional graph. Private
demonstration data, private queries, validation rows, legacy mappings, RDF/XML
serializations, and real-person data are prohibited here.

Authority is split deliberately: the immutable Turtle file is the source payload, SQL governs lifecycle and activation, and Fuseki holds an immutable version-specific query copy. Activation rollback moves the SQL pointer and never deletes a historical graph.

Storage is explicit: RDF artifacts are `graph_backed`; IDS and IFC-to-RDF
mapping profiles are `file_executed` and have no named graph. IDS is opened by
IfcTester. The mapping JSON is validated against a strict declarative allowlist
and cannot contain arbitrary executable code. Both are selected through SQL
family current pointers and neither source file is sent to Fuseki.

The model-RDF shapes are `graph_backed` and activatable. They validate stable
model/space/asset identities, version-specific manifestations and provenance,
not geometry, full ifcOWL, authentication, authorization or reservations.
Temporary uploaded shapes are not semantic artifacts: they are hashed,
meta-SHACL checked, executed once and removed without registry/Fuseki changes.

Prompt 7F adds two independent public Turtle releases. The
`project-semantic-evidence` bridge vocabulary defines minimal evidence terms;
`project-reservation-eligibility-shadow` is registered as `semantic_policy`
with `policyLanguage=SHACL` and `policyScope=reservation_eligibility_shadow`.
Both are graph-backed, immutable and activatable. The policy is executed by
pySHACL over per-run minimal evidence; loading it is not policy execution.

The policy never decides temporal availability, authentication, authorization,
approval or reservation lifecycle. It is shadow-only. Evidence ABoxes live in
run-specific graphs and are not registry artifacts or current aliases.
