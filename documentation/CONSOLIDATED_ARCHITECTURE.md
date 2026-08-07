# OSWADT — Arquitetura Consolidada (Prompt 7D, 2026-07-20)

Visão viva do protótipo após os Prompts 0–6, 7B1 e 7B2. Fontes de verdade: código,
migrations, testes, ADRs (0001–0039), MANUAL_TESTS.md. Secção final descreve
o trabalho semântico FUTURO — nada aí está implementado.

> ## ⚠️ Modelo definitivo IFC4x3 (ADR-0052) — autoritativo
>
> As secções abaixo que descrevem `Pset_SpaceCommon.Reference` como identidade/código
> transitório, o índice `uq_spaces_scope_code` como constraint de *Reference*, o
> **espaço-como-ativo** e `assets.space_id` como localização de equipamento estão
> **SUPERSEDIDAS** por [ADR-0052](./adr/ADR-0052-ifc4x3-space-semantics.md). O modelo
> implementado e autoritativo é:
>
> | Camada | Fonte de verdade |
> | --- | --- |
> | Perfil IFC | **IFC4x3-only** (allowlist precisa; IFC4/IFC2X3 rejeitados nos 3 pontos de entrada: intake controlado, upload inicial, rota legada de sensores) |
> | Espaço persistente | `spaces` — identidade `linked_model_id + IfcSpace.GlobalId` (exata, case-sensitive); `inventory_code` (de IfcSpace.Name), `long_name` (de IfcSpace.LongName) |
> | Reference | **ignorada** em todo o runtime (nunca identidade, código, display, validação, RDF, IDS, SHACL) |
> | Manifestação de espaço | `space_bindings` — snapshots `inventory_code_snapshot` / `long_name_snapshot` por versão |
> | Ativo persistente | `assets` — apenas `equipment`/`tool`; identidade e ciclo de vida; **um IfcSpace nunca é ativo** |
> | Localização de equipamento modelado | `asset_bindings.space_id` (específica da versão; localização corrente = binding da versão corrente). `assets.space_id` foi **removido** |
> | Localização de ativo não-modelado/grafo | `asset_location_assignments` (autoridade do grafo) |
> | Reservas | apenas equipamento/ferramentas; **um espaço nunca é recurso reservável** (rejeitado na descoberta, criação e aprovação); sem `reservation_zone` |
> | Governança semântica | IDS `oswadt-ifc4-model-requirements` v1.1.0 (IFC4x3 + IfcSpace.Name), mapping RDF v1.1.0 (`project:inventoryCode`/`project:longName`), SHACL v1.1.0 — versões/hashes no `semantic-artifacts-public-manifest.json` |
>
> Dados operacionais existentes exigem **migração/reset + re-ingestão** (ADR-0052).
> `IfcSpatialZone` permanece uma etapa dedicada futura.

## Arquitetura geral

```mermaid
flowchart LR
    FE[Next.js front :3000] -->|HTTP| BE[Express back :3001]
    BE -->|pool mysql2| DB[(MySQL digital_twin :3336)]
    BE -->|SPARQL HTTP| FUSEKI[(Fuseki 5.6.0 :3030\noswadt-dev / oswadt-test)]
    BE -->|extração IFC| PY[Flask + IfcOpenShell :3002]
    BE --> STORE[/cdn_resources storage/]
    subgraph autoridade
      DB
      FUSEKI
    end
```

O frontend NUNCA escreve diretamente no grafo nem nas tabelas de projeção —
toda a alteração passa pelos serviços do backend (guardado por teste).

## 15.1 Model Versioning (Prompt 2; ADR-0001..0004)

- `linked_models` = federação; `models` = linha lógica persistente;
  `model_versions` = revisões imutáveis (ficheiro por versão, hash, tamanho,
  storage_key; nunca sobrescrito).
- A corrente é EXPLÍCITA: `models.current_version_id` — nunca "o maior id".
- Estados: `processing → active → archived`; `processing → failed` (failed
  nunca é corrente; archived recuperável).
- Falha em qualquer etapa: compensações apagam inventário/ficheiro/bindings da
  versão falhada; a versão anterior CONTINUA corrente; linha `failed`
  preservada para diagnóstico.
- Concorrência (P2 + P6): `version_number` reservado em transação dedicada com
  `FOR UPDATE` em `models` + UNIQUE(model_id, version_number); ativação
  serializada; ver ADR-0030 (fundação pool).

```mermaid
sequenceDiagram
    participant U as Upload
    participant V as model_versions
    participant P as Python/IfcOpenShell
    participant M as models
    U->>V: reservar versão (tx + FOR UPDATE em models)
    U->>U: promover ficheiro (imutável, hash verificado)
    U->>P: extração sobre o ficheiro DA VERSÃO
    U->>U: model_requirements_preflight
    U->>V: inventário + identidades + bindings
    U->>M: ativação (tx): nova=active, anterior=archived, current_version_id=nova
    Note over U: falha em qualquer etapa ⇒ compensa; corrente anterior intacta
```

## 15.2 Model Information Requirements (Prompt 4/5A; ADR-0016..0018)

- `model_requirements_preflight` com validadores modulares, perfil IFC4:
  modelo espacial autoritativo com IfcSpace; `Pset_SpaceCommon.Reference`
  válido e não duplicado; `Tag` EQP- para equipamentos geridos, não duplicada;
  regras específicas de IfcBuildingElementProxy (ObjectType só é relevante em
  proxies).
- Falha de requisitos ≠ decisão de política (fronteiras separadas, guardadas
  por teste). Prompt 7C compõe este perfil local com uma camada IDS genuína;
  regras não expressáveis em IDS permanecem aqui.

## 15.3 Persistent Space Identity (Prompt 3; ADR-0005..0009)

- `spaces` = identidade persistente (space_uuid); `space_bindings` =
  representação por model_version.
- **Stage 0B (ADR-0051): a identidade persistente é `linked_model_id +
  IfcSpace.GlobalId`** (byte-exact/case-sensitive) — `spaceIdentityService` e o
  preview de model-intake resolvem por GlobalId (`findByScopeAndGlobalId`),
  preservando `spaces.id`/`space_uuid` e os bindings históricos. Mesmo GlobalId +
  Reference diferente = mesmo espaço (só a Reference administrativa corrente é
  atualizada — mas se a nova Reference pertencer a **outro** espaço a atualização é
  bloqueada antes de qualquer `UPDATE`). GlobalId diferente + mesma Reference =
  identidade diferente, ainda **bloqueada** pela restrição legada transitória
  `uq_spaces_scope_code` (`TransitionalReferenceCollisionError`), sem fallback por
  Reference. A validade completa do GlobalId (`^[0-9A-Za-z_$]{22}$`, sem trimming,
  validador partilhado `utils/ifcGlobalId.ts`) é verificada na aplicação **antes**
  de qualquer escrita; o `CHECK` do Stage 0A é a defesa final. Erros de chave
  duplicada mysql2 são classificados por `code`/`errno`/`sqlState`+nome do índice
  (`utils/mysqlDuplicateKey.ts`): só o índice canónico é corrida de identidade, só
  `uq_spaces_scope_code` é colisão de Reference, qualquer outro é re-lançado. Uma
  pré-condição de esquema (Stage 0A) falha com erro operacional preciso se a coluna
  canónica/índice faltarem — nunca corre migração nem faz fallback; a capacidade é
  cacheada **por base de dados selecionada** (`SELECT DATABASE()`), com verificação
  EXACTA da forma (coluna char(22) ascii_bin, CHECK aplicado, índices canónico e
  legado) partilhada entre escrita e preview (`utils/spaceCanonicalSchema.ts`) —
  ABSENT e CONFLICTING bloqueiam, só EXACT é cacheado, sem autorizar outra base nem
  esconder inconsistências por-âmbito. A deteção de GlobalId duplicado usa uma lista
  lossless `spaceOccurrences` (o Python extrai todos os psets e não nomeia nenhum;
  o dicionário por-GlobalId colapsaria duplicados). **Ambos** os caminhos de extração
  a emitem — o controlado (CLI `ifc_extract.py`) e o **ordinário** (Flask `main.py` →
  `fetchInventory`/`preprocessService`); para escrita a lista é **obrigatória**
  (`preflightSpaceOccurrences` bloqueia com `lossless_space_occurrences_missing` e
  nada é persistido; o dicionário colapsado nunca é aceite como prova de unicidade).
  O preflight puro de GlobalId corre **antes de `saveInventorySnapshot`**, pelo que um
  GlobalId duplicado não gera sequer `INSERT INTO entities`. O preview mostra TODOS os
  candidatos com códigos estáveis na precedência `invalid_globalid` >
  `duplicate_candidate_globalid` > `missing_reference` > esquema/integridade >
  `existing`/`new`/`transitional_reference_collision` — a falha de esquema **veda** os
  lookups mas nunca **esconde** um erro local do candidato. `createBinding` é
  `INSERT…SELECT` juntando `spaces → model_versions → models`: insere só com igualdade
  byte-a-byte binding↔canónico **e** cadeia `models.linked_parent_id =
  spaces.linked_model_id` coincidente (zero linhas → `canonical_inconsistency` com
  causa diagnosticada). Alterações de Reference numa reutilização são race-safe (dup
  traduzido pelo **catch real do serviço**) e protegidas por um lock cooperativo do
  MySQL com âmbito no `linked_model` (`GET_LOCK`, conexão dedicada — nunca mutex de
  processo) mantido desde antes da mutação até à compensação; linked_models diferentes
  são independentes, o mesmo linked_model serializa. A restauração é condicional (0
  linhas = "mudança mais recente venceu"; falha de restauração é registada como
  integridade de compensação no motivo da versão). Verificado num esquema MySQL
  descartável por `scripts/spaceGlobalIdRuntimeSelfTest.ts` (cadeia do binding, corrida
  de UPDATE via serviço, lock; nunca seleciona `digital_twin`; limpeza fatal incl.
  pool) e por um fixture Python real com dois IfcSpace de GlobalId idêntico.
- **Correções v3:** a lista lossless é obrigatória em `persistSpaceIdentities` (não só
  no orquestrador) via um validador partilhado que reconcilia EXATAMENTE o conjunto de
  GlobalIds das ocorrências com o dos candidatos e exige entity ids distintos
  (`lossless_space_occurrences_inconsistent`); nunca `occurrences ?? candidates`. A
  precedência do preview corre ANTES de qualquer acesso à BD — a pré-condição de
  esquema é obtida preguiçosamente e só quando algum candidato precisa de resolução
  (zero queries caso contrário); `checkConnection` está DENTRO do try controlado. Cada
  ocorrência tem `ifcEntityId` e URIs de manifestação/candidato distintas mesmo com
  GlobalId partilhado, e storey por ocorrência (`storeyName` na lista lossless). O nome
  do lock inclui um hash do `SELECT DATABASE()` real (esquemas distintos com o mesmo
  `linked_model` id não colidem; ≤64 chars). `withNamedLock` distingue timeout (0) de
  erro (NULL), exige RELEASE_LOCK=1 e DESTRÓI a conexão dedicada se a libertação falhar
  (nunca devolve ao pool um lock ainda seguro); o erro do callback é preservado; sucesso
  do callback + falha de libertação após ativação não aciona compensação de negócio. O
  restauro de Reference é um compare-and-swap da projeção COMPLETA (raw + normalizado +
  nome), nunca sobrepondo uma alteração mais recente. A corrida real de UPDATE usa uma
  barreira genuína de duas conexões (hook de teste após o pré-check real); os testes de
  lock usam barreiras deterministas. **Limitação honesta:** o journal de compensação é
  em memória por chamada (mantido sob o lock até à compensação), não durável — um crash
  duro entre a mudança e a compensação deixaria a projeção administrativa alterada até
  ao próximo upload autoritativo reconciliar; a identidade (id/uuid/GlobalId) nunca está
  em risco.
- **Correções v4:** um erro na QUERY de GET_LOCK (ou resultado NULL) tem desfecho
  DESCONHECIDO — a conexão dedicada é DESTRUÍDA (nunca devolvida ao pool) e é lançado
  `lock_error` distinto do timeout, com causa sanitizada (sem segredos); um timeout (0)
  devolve a conexão, destruindo-a só se `release()` falhar. O nome do lock é derivado NA
  própria conexão que segura o GET_LOCK (`withNamedLock` aceita uma factory que a recebe;
  `withReferenceLock` usa `referenceLockNameFactory`), garantindo que o esquema que
  delimita o lock e a sessão que o segura são a mesma conexão. O erro do callback é sempre
  primário e nunca substituído: valores não-Error são normalizados (original em `cause`) e
  uma falha simultânea de libertação anexa metadados (`lockReleaseFailed`,
  `lockReleaseErrorCode`, mensagem sanitizada). O restauro de Reference é BYTE-EXACT
  (`BINARY`), independente da collation case/accent-insensitive da tabela — uma alteração
  mais recente só de maiúsculas/acentos já não é sobreposta. O validador lossless verifica
  a FORMA de cada ocorrência (objeto; `entityId` inteiro positivo; campos opcionais bem
  tipados) antes de a desreferenciar, produzindo `lossless_space_occurrences_inconsistent`
  (nunca `TypeError`), e corre no INÍCIO de `persistSpaceIdentities`, antes de qualquer
  acesso à BD. O endpoint Flask ordinário constrói o corpo por `build_inventory_payload`,
  a mesma função que o teste invoca. O teste de lock de dois esquemas usa duas conexões
  REALMENTE selecionadas em esquemas distintos.
- A `Pset_SpaceCommon.Reference` continua a ser extraída e **transitoriamente
  obrigatória** (IDS/esquema atuais), guardada como metadado administrativo
  corrente e snapshot de versão; já **não** identifica o espaço. Reference nunca
  determina reservabilidade.
- Espaços ausentes da versão corrente → `absent` (nunca apagados).
- **Identidade-alvo aprovada (ADR-0051): `linked_model_id + IfcSpace.GlobalId`**,
  comparação byte-exact/case-sensitive. A **Stage 0A** apenas acrescenta a base de
  esquema — coluna canónica `spaces.ifc_global_id` (`CHAR(22) ascii_bin`), índice
  único `uq_spaces_linked_model_ifc_global_id` e backfill determinístico a partir
  de `space_bindings.ifc_guid` — sem trocar a autoridade em runtime. **O runtime
  continua a resolver por Reference** até etapas posteriores; Reference passa a
  metadado administrativo opcional.
- Executor de migração (`back/scripts/migrations/spaceGlobalId.ts`): DDL não é
  transacional (o `ALTER TABLE` faz commit implícito), por isso a segurança de
  restart exige **verificação EXATA de metadados** (coluna/índice/CHECK
  classificados ABSENT/EXACT/CONFLICTING — nomes iguais com forma diferente são
  recusados, nunca substituídos). O **backfill é atómico** (preflight completo de
  conflitos antes do primeiro UPDATE, escrita set-based numa transação). A CLI
  (`runSpaceGlobalIdMigration.ts`) exige `--confirm-database`==`DB_NAME`==`SELECT
  DATABASE()` e `--maintenance-confirmed`, recusa esquemas de sistema, e usa um
  advisory lock que só impede executores duplicados. **O backend tem de ser
  parado** durante a migração (a coluna permanece NULLable na Stage 0A). O
  rollback recusa artefactos com o nome esperado mas forma inesperada.

## 15.4 Persistent Asset Identity (Prompt 4; ADR-0010..0015)

- `assets` = identidade persistente (asset_uuid); `asset_bindings` =
  representação por versão (GUID, snapshots).
- Equipamentos modelados: `Tag` EQP- = código institucional (asset_code);
  SerialNumber = evidência secundária; Manufacturer não é identidade; GUID =
  rastreabilidade.
- Ambiguidade → `asset_reconciliation_cases` (decisão humana). (P6) A
  resolução é transacional com lock na linha do caso — duas resoluções
  simultâneas nunca criam dois assets (ADR-0031 §5).
- Lifecycle: presente na corrente=active; ausente=absent; retired só humano.

```mermaid
flowchart TB
    subgraph identidade persistente
      A[assets\nasset_uuid, Tag, serial]
      S[spaces\nspace_uuid, Reference]
    end
    subgraph por versão
      AB[asset_bindings\nGUID + snapshots]
      SB[space_bindings]
      E[entities]
    end
    A --- AB --- E
    S --- SB --- E
    AB -->|localização do modelado| S
```

## 15.5 Location

- **Modelados**: localização corrente derivada do binding da versão CORRENTE
  (space_id do binding). Mudar de espaço entre versões NUNCA muda asset_id.
- **Não modelados**: `asset_location_assignments` — atribuições temporais
  (valid_from/valid_to); UMA corrente por ativo garantida por coluna gerada +
  UNIQUE; fechar = escrever valid_to, nunca apagar histórico (ADR-0028).
- Movimento (P6): serializado por ativo (`GET_LOCK oswadt.nm_asset.{id}`) —
  grafo e SQL nunca divergem em nº de correntes por corrida.
- Sensores como fonte de localização: FUTURO (fonte 'sensor_inference'
  reservada, rejeitada pela API).

```mermaid
sequenceDiagram
    participant C as Cliente
    participant L as locationService
    participant G as Grafo (autoridade)
    participant Q as SQL (projeção)
    C->>L: move(movementKey, assetId, newSpaceId)
    L->>L: GET_LOCK nm_asset.{id}
    L->>G: corrente atual? (dentro do lock)
    L->>Q: operação move_asset (pending_graph)
    L->>G: INSERT fecha anterior + nova atribuição (ASK-guardado)
    L->>G: verificação: UMA corrente = a nova
    L->>Q: projeção transacional (fecha + insere)
    L->>L: RELEASE_LOCK
```

## 15.6 Graph and SQL Authority (Prompt 5A/5B; ADR-0019..0029)

- Fuseki 5.6.0 standalone (infrastructure/graph/), datasets `oswadt-dev`
  (TDB2) e `oswadt-test` (memória), auth básica stateless, `/$/ping` anónimo.
- Vocabulário `operational-v1` PROVISÓRIO (não é a ontologia da tese; nada de
  IFC-to-RDF).
- **Autoridade**: para ativos NÃO modelados, o grafo operacional detém
  existência, identidade, tipo, localização, histórico, proveniência; o SQL é
  projeção (reservas/listagens/UI) reconstruível.
- **Matriz** (ADR-0022): modelados/espaços/versões/reservas = SQL autoridade;
  não modelados = grafo autoridade + SQL projeção; sensores = SQL (futuro).
- Sincronização: `semantic_sync_operations` (ADR-0027) — SEM transação
  distribuída (nunca alegada); ordem SQL-op → grafo → verificação → projeção;
  retry idempotente (UUIDs/URIs reutilizados; ASK-guardado).
- Reconciliação (ADR-0029): report read-only; apply-safe idempotente e
  revalidado por correção; o named lock coordena execuções concorrentes do
  próprio apply-safe, mas não serializa globalmente todas as mutações do
  sistema; nunca altera o grafo.

```mermaid
stateDiagram-v2
    [*] --> pending_graph
    pending_graph --> graph_written : escrita + verificação
    pending_graph --> failed_retryable : grafo falhou
    failed_retryable --> graph_written : retry (mesmos UUIDs)
    graph_written --> pending_sql_projection
    pending_sql_projection --> completed : projeção transacional
    pending_sql_projection --> pending_sql_projection : SQL falhou (retry)
    pending_graph --> failed_terminal : decisão terminal
    pending_sql_projection --> failed_terminal : duplicate_manager_code
    completed --> [*]
```

## 15.7 Reservation Consistency (P0/P4/P5B/P6; ADR-0014/0030)

- Continuidade por `asset_id` + snapshots no momento da reserva (binding,
  versão, nome, espaço) — a reserva sobrevive a novas versões do modelo.
- Estados: pending, approved, in_use, rejected, cancelled, completed, overdue,
  no_show; checkout obrigatório; cancelamento de pending livre; regra 24 h só
  para approved; validação de datas; início no passado rejeitado;
  hasActorConflict. **P14 preservado**. Sem aprovação por gestor.
- (P6) Criação atómica: transação única + FOR UPDATE por asset; transições
  CAS; retry só de deadlocks; ponto de extensão pending→approved documentado.

```mermaid
sequenceDiagram
    participant A as Pedido A
    participant B as Pedido B (simultâneo)
    participant DB as MySQL
    A->>DB: BEGIN; SELECT assets FOR UPDATE (lock)
    B->>DB: BEGIN; SELECT assets FOR UPDATE (espera…)
    A->>DB: conflitos bloqueantes? não → INSERT pending; COMMIT (liberta)
    B->>DB: (obtém lock) reavalia conflitos e insere ou rejeita
    Note over A,B: pending de atores distintos não é exclusividade universal; bloqueiam approved/in_use/no_show do ativo e pending/approved do mesmo ator
```

### Limites transacionais (P6)

| Operação | Fronteira |
|---|---|
| createReservation | tx única (lock asset → checks → insert) + retry deadlock |
| check-in/checkout/cancel | CAS (UPDATE condicionado + affectedRows) |
| reserveVersion / activateVersion | tx dedicada + FOR UPDATE (models/version) |
| resolução de caso | tx única + FOR UPDATE na linha do caso |
| registo/movimento 5B | GET_LOCK (asset→operação) + tx SQL por fase |
| apply-safe | GET_LOCK global de reconciliação + revalidação por correção |

## 15.8 Policy Architecture (P1; ADR-0017)

- `ReservabilityEvaluator` + `ReservationRequestValidator` via providers
  configuráveis (`RESERVABILITY_POLICY_PROVIDER` e
  `RESERVATION_VALIDATION_PROVIDER` no `.env`); decisões
  allow/deny/undetermined/error;
  logs `policy_evaluation`.
- O GraphClient NÃO é provider de política; o provider legado devolve
  `undetermined` para `non_modelled_asset` (⇒ não reservável) — regra
  explícita, nunca alterada em silêncio.
- FUTURO: provider semântico (fora deste prompt).

## 15.9 Failure Recovery

- **Upload**: compensações por etapa; corrente anterior intacta; failed
  preservado; temp sempre limpo. Filesystem e MySQL sem transação conjunta —
  compensação explícita.
- **Grafo em baixo**: fluxos 5B falham com 503 controlado ("the rest of the
  application is unaffected"); modelados, espaços, sensores e reservas já
  projetadas continuam (guardado por teste).
- **Grafo escrito, SQL falha**: operação retomável; retry converge sem
  duplicar; reservas bloqueadas enquanto o sync do ativo estiver incompleto.
- **Deadlock/timeout**: retry limitado (só 1213) com logs estruturados;
  lock_timeout sem retry.
- **Reconciliação**: report → apply-safe (só casos seguros) → resto humano.
- **Reset/limpeza**: resetOperationalData (dry-run default, backup, guardas);
  cleanupNonModelledGraphData (universo 5B, direcionado, idempotente).

```mermaid
flowchart TD
    F[Falha] -->|upload etapa N| C1[compensar: inventário/ficheiro/bindings\ncorrente anterior intacta]
    F -->|Fuseki down| C2[503 controlado nos fluxos 5B\nresto da app intacto]
    F -->|SQL após grafo| C3[pending_sql_projection\nretry idempotente / apply-safe]
    F -->|deadlock 1213| C4[retry limitado + backoff]
    F -->|lock timeout| C5[erro controlado, sem retry]
```

## 15.10 Governed Semantic Artifacts (Prompt 7B1; ADR-0032/0033)

- Cinco ficheiros Turtle aprovados: quatro releases públicas/sintéticas de
  runtime e um fixture negativo sintético, isolado e não ativável. A ontologia
  institucional é um draft de investigação não oficial.
- Autoridade: bytes no ficheiro auditado; identidade/lifecycle/current pointer
  no SQL; cópia consultável num named graph imutável por artifact UUID.
- Registry: `semantic_artifact_families`, `semantic_artifacts` e
  `semantic_artifact_load_operations`; migration manual com rollback dedicado.
- Saga CLI idempotente: integridade → registry → PUT exclusivo → contagem e
  recurso esperado → ativação SQL por row lock/CAS. O operation lock ocupa uma
  conexão dedicada durante I/O; o family lock limita-se à transação curta.
- Rollback move apenas o current pointer para uma revisão elegível; nunca
  apaga ou sobrescreve graph histórico. `/graph/operational` permanece isolado.
- O shape set é RDF governado e carregável. O 7B1 não executa SHACL,
  elegibilidade semântica, IDS ou IFC-to-RDF; actor links e leitura
  institucional foram acrescentados separadamente no 7B2.

## 15.11 Institutional Context (Prompt 7B2; ADR-0034/0035)

- SQL é autoridade dos actor links e respetivo lifecycle/histórico; o graph
  institucional ativo é autoridade de pessoas, identifiers, memberships,
  roles, organizations e supervision. O ABox do link não é RDF.
- `actor_key` é texto não autenticado, nunca URI nem `owl:sameAs`; não altera
  `res_reservations.actor_id`, políticas, conflitos ou aprovação.
- O provider read-only resolve ontology/dataset/bridge pelo registry, executa
  queries parametrizadas e devolve tipos de domínio, não JSON SPARQL cru.
- A API institucional contém apenas GET; feature/demo default off.
  `/semantic-demo` usa exclusivamente a API da aplicação.
- Pending/suspended/revoked/superseded/expired e dataset superseded não usam
  evidência corrente. Student 002 sem supervisor continua contexto válido.
- Implementado: acesso institucional, links SQL e demonstrador sintético.
  Não implementado: authentication, authorization, eligibility, SHACL,
  reservability ou approval.

## 15.12 IDS-based IFC preflight (Prompt 7C; ADR-0036/0037)

- The public IDS profile is governed by the registry as
  `storage_mode=file_executed`; its `named_graph_uri` is null and Fuseki is not
  in its execution path.
- `IfcOpenShellIdsValidationProvider` isolates the application from IfcTester
  0.8.4 and returns normalized results. XML profile loading and IFC evaluation
  are performed by the genuine executor, not by application regexes/parsers.
- `ModelRequirementsValidationService` preserves `source=ids` and
  `source=project_rule`. Disabled preserves prior behaviour, report-only
  records IDS failure without blocking, and required blocks an IDS or project
  rule failure.
- Reports store provenance, modes, statuses and bounded messages without IFC or
  XML bodies, credentials, SQL, SPARQL or stack traces. Upload validation runs
  before inventory, identity, assets, activation and any reservation effect.
- `/api/model-requirements/demo/:scenario` is POST-only, feature-gated and
  allowlists three repository fixtures. `/ids-demo` calls the Node API only.
- Duplicate codes, federation authority, identity continuity, availability,
  reservability, eligibility, approval and reservation transactions remain
  outside IDS.

## 15.13 Controlled model intake and minimal IFC-to-RDF (Prompt 7D; ADR-0038/0039)

- `/dashboard` is the real management workspace: researcher-selected IFC and
  active/uploaded IDS → backend hashes → genuine IDS + separate project rules
  → read-only candidate identities → backend Turtle preview.
- Preview cleans uploaded files and creates no `model_version`, identity,
  binding, named graph or reservation. Creation is a second explicit action
  that receives files again and confirms both hashes.
- `models.model_uuid` and `model_versions.version_uuid` provide stable internal
  identity. `spaces.space_uuid`/`assets.asset_uuid` identify persistent
  resources; IFC GUIDs identify version manifestations only.
- A governed `ifc_rdf_mapping` JSON allowlist selects BOT, BEO, PROV-O,
  DCTerms and minimal project terms. It is `file_executed`, not a graph and not
  executable code.
- Each completed version has one immutable
  `graph/model-version/{modelVersionUuid}`. In required mode local Turtle parse,
  graph PUT, remote triple count and expected version-resource ASK all precede
  SQL activation. SQL current pointers select the active version; historical
  graphs remain intact.
- No geometry, full ifcOWL, SHACL, eligibility, institutional context,
  non-modelled operational data or reservations are materialised.

## 15.14 Governed SHACL execution (Prompt 7E; ADR-0040/0041)

- `SemanticValidationProvider` isolates the application from pinned pySHACL
  0.40.0. Data, shapes and optional ontology are real RDF inputs; normalized
  output includes focus node, path, value, shape/component, severity/message,
  hashes, executor/version and timestamps.
- The model-RDF shape set 1.0.0 is a public, immutable, graph-backed artifact.
  It validates model/version context, persistent space/asset manifestations
  and provenance. The UMinho institutional shapes 1.1 remain unchanged.
- The dashboard displays backend-derived constraints and separate IDS,
  project-rule and SHACL layers. It calls Node multipart APIs only.
- Preview runs are ephemeral. Persistent version runs use normalized SQL rows
  plus `graph/validation/report/{runUuid}`; neither SQL nor logs contain full
  Turtle.
- Disabled preserves 7D; report_only records without blocking; required runs
  before model graph write and only an active governed conformant set permits
  activation. Temporary uploads never decide activation.
- SHACL has no authority over authentication, authorization, eligibility,
  reservability, availability, approval, temporal conflicts or reservations.

## 15.17 Persistent application accounts (Prompt 7G; ADR-0044/0045)

- An application account is not an institutional agent, institutional role or
  actor-link URI. It is a persistent synthetic local record with its own UUID
  and lifecycle status.
- In `local_session`, Node resolves the account server-side from an opaque
  HttpOnly cookie. The browser does not store a token and cannot choose an
  actor in reservation/evidence payloads.
- Account FKs on actor links, new reservations and evidence runs create a
  a local audit boundary. Legacy actor snapshots remain only for disabled-mode
  compatibility.
- Local synthetic login is development-only and startup refuses it in
  production. The server resolves additive **capabilities**
  (`reserveResources`, `bimManagement`, `operationalManagement`) from active
  role grants and account status; the browser cannot choose a capability or a
  role. `applicationArea` remains only a temporary compatibility alias, not an
  authorization authority. Building onboarding remains future work.

## 15.18 Reservation approval and additive manager roles (Prompt 7H; ADR-0046/0047/0050)

- Management roles are additive (ADR-0050). `bim_manager` grants the
  `bimManagement` capability (BIM/model-intake workspace); `operational_manager`
  grants the `operationalManagement` capability (reservation decisions). Every
  active human account also has `reserveResources` for the normal reservation
  workspace, managers included.
- Operational authority is **global** for this phase: `operationalManagement`
  alone permits listing, opening, refreshing evidence, approving, rejecting and
  cancelling any reservation. The `reservation_management_scopes` table is
  retained but dormant future-granularity infrastructure and is never consulted.
  This supersedes the mandatory per-asset scope of ADR-0046.
- The transitional key `reservation_manager` is still recognised as
  `operationalManagement`, but the API, new snapshots and setup normalise the
  role to `operational_manager`. Historical decision snapshots are not rewritten.
- Capabilities are application authorization, never institutional roles or
  semantic policy results. This limited demonstrator boundary is not complete
  production RBAC.
- Pending requests can coexist across actors. Approval locks and rechecks SQL
  availability, appends an audit record, and remains a human decision.

## 15.15 Future semantic extension and building onboarding

Future semantic scope includes evaluation beyond the minimal BOT/BEO mapping,
operational vocabulary migration, sensor ingestion and a separately governed
semantic-policy provider. None is implied by structural SHACL validation.

The current dashboard depends on a pre-existing building and logical model
line. Future manager workflow must add: building list; “Register building”;
persistent building identity and basic/responsible-organization data; first
model line; first IFC/version; and subsequent versions on the building page.
Building registration is not implemented in Prompt 7E.

## 15.16 Cross-domain reservation evidence (Prompt 7F; ADR-0042/0043)

- The real reservation modal has two explicit actions: evidence preview, then
  optional reservation creation. Inputs are actor key, selected asset and
  start/end interval; the backend derives every evidence layer from them.
- `ReservationSemanticEvidenceService` resolves the SQL actor link and current
  institutional graph, persistent asset/current model manifestation, latest
  structural run, real SHACL shadow policy and existing SQL conflict methods.
- Each run persists normalized SQL evidence plus immutable
  `graph/evidence/reservation/{runUuid}` and a separate immutable policy-report
  graph. Neither graph copies personal labels, student number, complete IFC or
  reservation payload.
- Shadow outcomes (`eligible`, `not_eligible`, `indeterminate`) are audit
  evidence only. Missing/failed graph evidence is indeterminate. No semantic
  result changes the reservation transaction or approval lifecycle.
- SQL remains authority for temporal availability: approved/in-use/no-show
  block all actors; pending/approved block the same actor; pending does not
  claim universal exclusivity against third parties.
- Building registration remains future. Prompt 7G will consolidate the final
  manager interface; the current flow assumes pre-existing building/model data.
- Prompt 7I consolidates this as a role-based research demonstrator: existing
  model contexts are selected in the manager area; building onboarding,
  building-owned timezone configuration and production authentication remain
  future work. Presentation uses Europe/Lisbon while storage remains UTC.

## 15.19 Institutional visual language and student workspaces (Prompt 7J-A; ADR-0049)

- Central tokens use UMinho Pantone 207 / `#c5014b` and Pantone 159 / `#e16b03` as documented in the official identity manual. A textual header is used; no unverified logo or font asset is copied into the repository.
- Local login remains server-routed and session-resolved. Visible account numbering is presentation only, never an application or institutional ID.
- Student has three mutually exclusive workspaces: reservation through the current IFC model, reservation from a global persistent-asset catalogue, and management of existing reservations. Manager has two: model management and reservation decisions.
- Viewer selection uses an explicit `linkedModelId` / `modelLineId` / `currentVersionId` contract. Only a current asset binding can turn an IFC selection into a reservable persistent resource.
- The selected-resource panel belongs with the logical-model selection, before the IFC tree/viewer. It remains compact without a selection. A reservable current binding opens the shared accessible reservation dialog; the model path contributes presentation context only and does not duplicate evidence, SQL availability or request creation.
- The global catalogue is a read-only operational projection: current binding = modelled; graph-authoritative projection without current binding = non-modelled; uncertain origin is explicit. One SQL query deduplicates; the browser receives the persistent UUID and the backend resolves the operational ID.
- Both student creation paths reuse the existing evidence and reservation services. SQL availability, lifecycle authority, graph authority and semantic shadow policy are unchanged. Manager filtering/grouping by model remains future 7J-B scope.
- Viewer/model selection is transient workspace state. Returning after changing workspace requires a new logical-model selection, avoiding hidden graphical instances while leaving reservation authority and lifecycle untouched.
