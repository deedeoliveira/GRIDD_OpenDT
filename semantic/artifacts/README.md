# Governed semantic artefacts

This directory contains the public and synthetic subset of the UMinho institutional semantic package approved for this research prototype.

The institutional ontology is a **research artefact**. It is non-official and is not published, approved, or maintained by the University of Minho. Its namespace is a research namespace, the release is draft, and it may be migrated before thesis publication.

Turtle is the only runtime serialization in this stage. The source Turtle files are copied byte-for-byte and are immutable. Their hashes, sizes, triple counts, privacy classifications, and activation rules are recorded in `semantic-artifacts-public-manifest.json`.

Directory roles:

- `runtime/`: artefacts allowed to be loaded and operationally activated by the local CLI;
- `test/`: synthetic test-only artefacts; these are never activated;
- the public manifest describes only this approved subset.

The structural shapes are governed RDF artefacts, but this stage does **not** execute SHACL and does not claim SHACL validation. The negative fixture may only be loaded into a unique `/graph/test/...` graph by tests. Private demonstration data, private queries, validation rows, legacy mappings, RDF/XML serializations, and real-person data are prohibited here.

Authority is split deliberately: the immutable Turtle file is the source payload, SQL governs lifecycle and activation, and Fuseki holds an immutable version-specific query copy. Activation rollback moves the SQL pointer and never deletes a historical graph.
