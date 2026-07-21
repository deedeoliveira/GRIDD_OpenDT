# Controlled model intake — researcher walkthrough

The technical executor prepares migrations, MySQL, Fuseki, Python/IfcTester, mapping activation, flags and both application services. The researcher performs no SQL, SPARQL, migration, seed, lock, retry or table inspection.

Open `http://localhost:3000/dashboard`. The four public synthetic examples are in `documentation/demo-inputs/model-intake/`, but the page does not select them automatically.

| Teste ou grupo | O que está sendo testado em linguagem comum | Resultado |
|---|---|---|
| A — controlar IFC e IDS | Select an existing model line, choose `model-v1.ifc` and `ids-reference-required.ids`, run **Validate and preview**, and confirm the displayed filenames/hashes, extracted requirements, IDS PASS, project rules PASS, spaces/assets and backend RDF correspond to those files. | A executar pela investigadora |
| B — alterar somente IDS | Keep `model-v1.ifc`, choose `ids-reference-and-extra-property.ids`, confirm the IDS hash/list changes, and observe failure for the deliberately absent Department property. | A executar pela investigadora |
| C — criar V1 | Return to the passing IDS, run preview, read the warning and explicitly click **Create model version**. Observe version UUID/number, active-after-verification status, graph URI, triple count and persistent identities. | A executar pela investigadora |
| D — criar V2 | Choose `model-v2-same-identities.ifc`, preview and explicitly create it. Compare V1/V2: new version and graph, same persistent space/asset UUIDs, different manifestations/GUIDs, changed label/storey context and preserved V1. | A executar pela investigadora |

In every step confirm that preview never creates a version, no version is created without the explicit button, and the permanent notice makes no eligibility, authorization, approval or reservation claim.

If a result differs, stop before commits and report the visible step, selected filenames and displayed correlation/run UUID. Do not expose IFC/IDS bodies, credentials or local paths.
