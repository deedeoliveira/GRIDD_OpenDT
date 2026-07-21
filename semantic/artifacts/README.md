# Governed semantic artefacts

This directory contains the public and synthetic subset of the UMinho institutional semantic package approved for this research prototype.

The institutional ontology is a **research artefact**. It is non-official and is not published, approved, or maintained by the University of Minho. Its namespace is a research namespace, the release is draft, and it may be migrated before thesis publication.

The five source Turtle files remain byte-for-byte immutable. Prompt 7C adds one
public synthetic IDS/XML profile. Prompt 7D adds one public declarative JSON
IFC-to-RDF mapping profile. Hashes, sizes, storage modes, privacy
classifications and activation rules are recorded in the public manifest.

Directory roles:

- `runtime/`: artefacts allowed to be operationally activated by their governed loader/executor;
- `test/`: synthetic test-only artefacts; these are never activated;
- the public manifest describes only this approved subset.

The structural shapes are governed RDF artefacts, but this stage does **not** execute SHACL and does not claim SHACL validation. The negative fixture may only be loaded into a unique `/graph/test/...` graph by tests. Private demonstration data, private queries, validation rows, legacy mappings, RDF/XML serializations, and real-person data are prohibited here.

Authority is split deliberately: the immutable Turtle file is the source payload, SQL governs lifecycle and activation, and Fuseki holds an immutable version-specific query copy. Activation rollback moves the SQL pointer and never deletes a historical graph.

Storage is explicit: RDF artifacts are `graph_backed`; IDS and IFC-to-RDF
mapping profiles are `file_executed` and have no named graph. IDS is opened by
IfcTester. The mapping JSON is validated against a strict declarative allowlist
and cannot contain arbitrary executable code. Both are selected through SQL
family current pointers and neither source file is sent to Fuseki.
