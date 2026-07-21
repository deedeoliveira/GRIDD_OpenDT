# Prompt 7E — Governed SHACL execution and structural validation

## Baseline

Implementation began on `main` at
`de593bd2a424d68507e59f5f77480dcdbe524896`, aligned with `origin/main`.
The working tree contained only untracked `.claude/`, which remains outside
Git. The measured baseline was 538 passing tests. Python was 3.12.8 with
IfcOpenShell/IfcTester 0.8.4; pySHACL was not present before this prompt.

## Implemented evidence path

The real `/dashboard` controlled-intake workspace now adds **Semantic graph
validation** after RDF preview. The researcher selects governed shapes or a
temporary Turtle file. The backend computes hashes, extracts constraints from
those bytes and executes pinned pySHACL 0.40.0 against the generated RDF.

IDS, project rules and SHACL are rendered as separate evidence layers. SHACL
results expose severity, focus node, path, value, message, source shape and
constraint component. JSON, SHACL report Turtle and validated data Turtle are
downloadable. The frontend has no Python, Fuseki or SPARQL endpoint.

## Governance and persistence

The model shape set is the immutable public artifact
`oswadt-model-rdf-structural-shapes` 1.0.0 (`shacl_shapes`, `graph_backed`,
public, activatable and non-test). It is distinct from the unchanged UMinho
institutional shape set 1.1. The forward/rollback migration adds normalized
`semantic_validation_runs` and `semantic_validation_results`; SQL stores no
complete RDF payload. Persistent model runs also write one immutable,
run-scoped report graph.

Temporary shapes are local/dev only, receive backend hashes, pass Turtle and
meta-SHACL checks, never enter the registry/Fuseki/current pointer and cannot
authorize activation in `required` mode. Request cleanup removes their files.

## Executable results

| Teste ou grupo | O que está sendo testado em linguagem comum | Resultado |
|---|---|---|
| pySHACL real | Dados e shapes Turtle reais são executados pelo pySHACL 0.40.0, incluindo pass, violation e warning. | PASS |
| Shapes governadas | O RDF de `model-v1.ifc` satisfaz o contrato estrutural público da plataforma. | PASS |
| Shapes temporárias | O mesmo RDF falha quando cada manifestação passa a exigir `dcterms:description`. | PASS — 2 resultados |
| Mudança das shapes | Só o hash/constraints das shapes mudam; o hash dos dados permanece igual e o resultado muda. | PASS |
| Constraints visíveis | Target, path, cardinalidade, tipo/classe/node kind, pattern, severidade e mensagem vêm do backend. | PASS |
| Resultado explicável | Focus node, path, constraint component, severidade e mensagem são normalizados. | PASS |
| Preview sem persistência | A rota de preview não cria model version, model graph, report graph ou linha SQL. | PASS |
| Required | Não conformidade ocorre antes do graph PUT e não alcança ativação/current pointer. | PASS |
| Report only | Um resultado governado não conforme é preservado sem bloquear a materialização. | PASS |
| Pacote institucional | Ontology + fixture positiva passa; ao acrescentar a fixture negativa surgem exatamente sete resultados. | PASS — 0/7 |
| Segurança | Imports, Turtle inválido, graph URI/path/comando/URL do cliente, traversal, symlink e tamanho são guardados. | PASS |
| Isolamento | Não há chamada de reservas, eligibility, actor links ou graph institucional ativo no fluxo de model RDF. | PASS |
| Teste vertical | IFC + IDS reais geram RDF real, seguido por governed pass e temporary fail via pySHACL. | PASS |

Final automated verification: 558/558 backend tests passed; backend and
frontend TypeScript checks passed; the production frontend build passed; the
public artifact manifest validated all eight entries.

## Local preparation and executor smoke

After automated verification, the scoped 7E forward migration was applied
locally. The ignored `back/.env` enables `required` mode and temporary shapes
for the walkthrough. Setup passed in dry-run and explicit modes; two repeated
explicit runs converged on artifact ID 7 and the same immutable shapes graph.
Setup applied no migration, created no model version, reset no graph and did
not load the institutional negative fixture.

The executor then used the real dashboard file inputs:

- A: governed shapes 1.0.0, 22 visible constraints, `conforms=true`, zero
  results.
- B: same data hash, temporary shapes hash
  `8e38d5aae8c96670da37f56a85ecac880e73031143e0f9fc1416f421dab25b1b`,
  `conforms=false`, two manifestation results with focus node,
  `dcterms:description` path and message.
- C: restored governed shapes; version 8 became current only after real final
  RDF validation. Model graph and immutable report graph were displayed and
  all three downloads returned HTTP 200.

Reservation count remained 1 before and after the smoke. Backend, frontend,
Fuseki and MySQL were left listening for the separate researcher walkthrough.

Researcher-controlled functional walkthrough passed. Cryptographic integrity and graph immutability were verified automatically and through executor-level integration checks, not independently inspected by the researcher.

## Scientific boundary

IDS checks information requirements. Project rules check project-specific
conditions. SHACL checks RDF structure and quality. None of these layers is an
authentication, authorization, eligibility, reservability, availability,
approval, temporal-conflict or reservation-transaction decision.

Building list/registration, persistent building onboarding, creation of the
first model line and first IFC/version from the building page are recorded as
future product scope, not as Prompt 7E implementation.
