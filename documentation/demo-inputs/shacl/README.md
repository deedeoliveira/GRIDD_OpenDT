# Researcher-controlled SHACL inputs

The governed passing shape set is the public immutable artifact
`semantic/artifacts/runtime/oswadt-model-rdf-structural-shapes/1.0.0/oswadt-model-rdf-structural-shapes-v1.ttl`.
Select **Active governed shapes** in the dashboard; the frontend does not load
that repository file directly.

`temporary-manifestation-description-required.ttl` is a synthetic temporary
shape set for the second walkthrough scenario. It adds one visible constraint:
every `project:IfcManifestation` must have exactly one `dcterms:description`.
The current minimal model RDF deliberately does not emit that property, so the
same IFC/IDS preview becomes non-conformant when only this file is selected.

The file picker remains under researcher control. Temporary shapes are parsed,
meta-SHACL checked and executed locally by pySHACL, then removed. They are not
registered, activated or loaded into Fuseki, and cannot decide activation in
`required` mode.
