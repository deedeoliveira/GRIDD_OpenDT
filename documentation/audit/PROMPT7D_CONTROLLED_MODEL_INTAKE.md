# Prompt 7D — Controlled model intake implementation audit

## Baseline and insertion points

Baseline was branch `main`, HEAD `3ff93f9fe9872e0da094ba3c6f14da588f81bb36`, aligned with `origin/main`, with only `.claude/settings.local.json` untracked. The measured suite contained 523 tests. Five initially failed because the existing venv referenced a removed Python 3.12 installation; Python 3.12.8 was restored and the same venv again loaded IfcOpenShell 0.8.4.post1 and IfcTester 0.8.4.

The real upload is `POST /api/model/upload` → `handleModelUpload` → immutable file promotion → extraction → composed IDS/project rules → entities → persistent spaces/assets/bindings → activation. The real administrative dashboard existed but contained only placeholder text, so `/dashboard` was selected rather than creating an isolated demo route.

Prompt 7B1/7B2/7C tables were present locally before implementation. MySQL and the Node/frontend services were available; Fuseki and Python Flask were not listening at baseline.

## Implemented boundaries

- `POST /api/model-intake/preflight`: multipart IFC plus active/uploaded IDS; no persistence of model/domain/graph/reservation state.
- `POST /api/model-intake/models/:modelId/versions`: explicit version creation after server-side hash confirmation and repeated validation.
- Run/report/Turtle downloads and version semantic summary/resources/Turtle/report GET endpoints.
- Backend-only N3 Turtle generation and parsing; frontend is a renderer/client.
- Declarative governed mapping, SQL lifecycle record and immutable model-version graph.
- Stable `models.model_uuid` and `model_versions.version_uuid`; IFC GUID remains manifestation evidence.

The frontend does not contain Fuseki endpoints, SPARQL or Python routes. Reservation services/tables are absent from the implementation and migration.

## Automated evidence

| Teste ou grupo | O que está sendo testado em linguagem comum | Resultado |
|---|---|---|
| Upload IFC | Um ficheiro IFC selecionado é recebido como multipart, reconhecido como IFC4 e tem nome, tamanho e hash calculados no servidor. | PASS |
| Upload IDS | Um IDS temporário é realmente aberto pelo IfcTester e não é tratado como artefacto governado. | PASS |
| Mudança de IDS | Mantendo V1, mudar apenas IDS altera hash, requisitos e o resultado esperado. | PASS |
| Requirements visíveis | A lista mostra classe aplicável, propriedade/atributo, cardinalidade e pattern extraídos do XML recebido. | PASS |
| Segurança XML e cleanup | DTD/entities são rejeitados pelo boundary real e os temporários de teste são removidos. | PASS |
| Preview sem persistência | A ação está separada da criação; usa identidades `candidate` e não chama upload/versionamento. | PASS |
| Criação explícita | Só a segunda ação chama o pipeline real e compara novamente hashes. | PASS |
| RDF backend | Turtle é produzido e analisado com N3; hash e contagem correspondem aos bytes reais. | PASS |
| Mapping governado | Manifesto, hash, JSON, allowlists, exclusões e `file_executed` sem graph próprio são verificados. | PASS |
| Graph e falha | Graph é escrito/contado/verificado; falha required não completa; retry não sobrescreve. | PASS |
| V1/V2 | Graphs e manifestações mudam, enquanto UUIDs persistentes simulados permanecem os mesmos e V1 fica intacto. | PASS |
| Frontend/backend | File pickers e FormData reais consomem hashes/requisitos/RDF do backend, sem Fuseki/Python direto. | PASS |
| Isolamento | Migration/código não tocam reservas, actor links, graph institucional, graph non-modelled ou SHACL. | PASS |
| Regressão completa | Os 523 testes anteriores mais 15 novos testes executam juntos. | PASS — 538/538 |

## Local preparation and executor smoke

The scoped 7D forward migration was applied locally only after the automated suite, backend/frontend typechecks, frontend build and public-manifest validation passed. The rollback remains available and was not applied. `model-intake:setup` completed in dry-run and explicit execute modes; it activated the governed mapping and did not apply migrations, create model versions, reset graphs or delete data.

The executor then exercised the same multipart API used by the frontend with the committed synthetic walkthrough inputs:

- V1 preflight passed with 39 preview triples, one space and one asset. Explicit creation produced model version 4 and an immutable 40-triple named graph.
- V2 preflight passed with 39 preview triples, one space and one asset. Explicit creation produced model version 5 and a different immutable 40-triple named graph.
- V1 and V2 preserve the same persistent space and asset UUIDs for `R-101` and `EQP-DEMO-001`; their IFC GUIDs and manifestation URIs differ by version.
- Remote queries confirmed that the V1 graph still contains its V1 GUID and no V2 GUID after V2 activation. Version 5 is current and version 4 is archived, not overwritten.
- Turtle/report downloads returned HTTP 200, the intake temporary directory was empty, and the reservation count remained 1 before and after the smoke.

The first V1 creation attempt reserved version 3 and wrote/verified its unique graph, then failed before completion because the version snapshot omitted `storage_key`. Compensation preserved current version 2, marked version 3 `failed` and its semantic lifecycle `failed_retryable`, and removed its promoted file/bindings. The SQL read was corrected; no graph was overwritten or deleted. The successful V1/V2 smoke above used fresh version/graph identities.

The executor smoke proves technical readiness but is not the researcher's walkthrough. The services remain running for that separate controlled walkthrough.

## Explicit non-claims

This implementation does not provide full ifcOWL, geometry RDF, SHACL execution, semantic eligibility, authorization, approval, authentication, reservation decisions, sensor ingestion, maintenance workflows or public IDS publication.

Functional walkthrough results must be recorded separately after the researcher controls the inputs. No commit is permitted before that confirmation.
