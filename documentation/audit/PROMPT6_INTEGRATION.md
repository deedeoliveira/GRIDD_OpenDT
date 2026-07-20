# PROMPT 6 — Avaliação Final de Integração (2026-07-18)

Avaliação honesta do estado do protótipo após os Prompts 0–6. Preparação
arquitetural NUNCA é apresentada como implementação funcional. Referências:
CONCURRENCY_AUDIT.md, CONSOLIDATED_ARCHITECTURE.md, ADR-0001..0031,
MANUAL_TESTS.md §21, suite de 416 testes.

## Completely implemented

- **Versionamento de modelos**: linha lógica + revisões imutáveis + corrente
  explícita + estados + compensações + concorrência (FOR UPDATE + UNIQUE +
  pool de transações dedicadas). Testes: versioning/, concurrency/.
- **Identidade persistente de espaços**: spaces/space_bindings, Reference via
  provider, estados active/absent, preflight espacial estrito.
- **Identidade persistente de ativos modelados**: assets/asset_bindings, Tag
  EQP-, serial secundário, lifecycle, casos de reconciliação com resolução
  transacional protegida contra dupla resolução (P6).
- **Ativos não modelados (5B)**: grafo operacional autoridade + projeção SQL,
  identidade por asset_uuid/URI, registo e movimento idempotentes, histórico
  temporal com UMA corrente garantida (BD + serialização por ativo), gating de
  reservas 100% SQL, produção protegida (base .local/credenciais default
  rejeitadas antes de escrever).
- **Reservas**: máquina de estados completa (incl. overdue/no_show/checkout
  obrigatório/regra 24 h/P14), snapshots, continuidade por asset_id, criação
  ATÓMICA com lock por asset, transições compare-and-set, retry limitado de
  deadlocks, ponto de extensão pending→approved (interno, sem workflow).
- **Concorrência**: auditoria completa; pool de conexões (correção estrutural:
  a conexão única entrelaçava transações e anulava locks intra-processo);
  ordem global de locks; UNIQUE funcional de managerCode; convergência
  idempotente em corridas de chave; 37 testes de corrida/integração + sonda
  HTTP real (scripts/concurrencyProbe.ts).
- **Grafo (fundação 5A)**: Fuseki 5.6.0 reproduzível, GraphClient/provider,
  URIs, named graphs, salvaguardas anti-CLEAR/DROP, datasets dev/test,
  health checks, isolamento de falhas.
- **Sincronização grafo–SQL**: máquina de estados, idempotency keys, payload
  hashes, retries (agora serializados — no máximo uma retomada efetiva),
  verificação pós-escrita, reconciliação report/apply-safe (serializada e
  revalidada), limpeza direcionada.
- **Observabilidade mínima**: logs estruturados policy_evaluation,
  graph_operation, model_upload_failure e (P6) eventos de concorrência com
  correlationId; sem credenciais/payloads/queries completas.

## Partially implemented

- **Localização**: modelados por binding corrente + não modelados por
  assignments = completo; fontes `sensor_inference`/`external_system` apenas
  RESERVADAS no esquema (a API rejeita-as).
- **Políticas**: arquitetura de providers completa; mas só existe o provider
  legado (IFC heurístico + undetermined para não modelados). O provider
  "institucional real" é futuro.
- **Reconciliação grafo–SQL**: casos seguros automatizados; casos não seguros
  só reportados (por desenho — decisão humana pendente de interface melhor).
- **Segurança**: guardas de produção do grafo + sanitização de erros +
  ausência de secrets em logs = implementado; **autenticação/autorização da
  API = inexistente** (endpoints administrativos abertos — limitação
  documentada desde P4/5B).
- **Observabilidade**: logs estruturados sim; correlação ponta-a-ponta e
  agregação = não (sem plataforma externa, por decisão).
- **UI**: viewer/dashboard/reservas de estudante funcionais; SEM interface
  para: resolução de casos, registo/movimento de não modelados, retry/
  reconciliação (tudo via Bruno/curl — aceite para protótipo).

## Not implemented

- Ontologia definitiva; IFC-to-RDF; IFC-OWL/BOT/Brick/SAREF; SHACL; provider
  ontológico de políticas; IDS (upload/execução); ingestão de sensores para
  localização; inferência de localização; aprovação por gestor (nem endpoint
  nem UI — apenas o contrato transacional interno); autenticação; portal
  administrativo; transação distribuída MySQL↔Fuseki (impossível com estas
  tecnologias — nunca alegada).

## Deferred (com ponto de inserção preparado)

- pending→approved transacional → `approvePendingWithinTransaction` (ADR-0030).
- Materialização RDF por model_version → convenções em namedGraphs.ts.
- IDS → substituirá/estenderá validadores do model_requirements_preflight.
- Sensores → colunas confidence/observed_at/source já no esquema 5B.
- Migração do vocabulário operational-v1 → plano exigido no prompt ontológico.
- Cleanup do legado → LEGACY_CLEANUP_PLAN.md (classificado, não executado).

## Known limitations

1. Sem transação distribuída: janelas grafo↔SQL existem; mitigadas por ordem
   de escrita + idempotência + locks + reconciliação; visíveis em
   projection-status.
2. A serialização 5B por GET_LOCK pressupõe UM MySQL partilhado por todos os
   deployments do backend — múltiplos backends com MySQLs distintos ficariam
   sem proteção (fora do âmbito do protótipo).
3. `pending` não bloqueia terceiros (regra preservada conscientemente): duas
   pendings sobrepostas de atores diferentes coexistem até uma aprovação
   futura revalidar — comportamento documentado, não é bug.
4. Endpoints administrativos sem autenticação (risco aceite e registado).
5. `sensorDatabase` tem interpolação direta de channelIds (legado pré-P0;
   primeiro item do plano de cleanup).
6. O UNIQUE funcional exige MySQL 8.0.13+; a base de desenvolvimento cumpre.
7. Logs de concorrência vão para stdout (sem rotação/agregação).

## Avaliação por área (resumo)

| Área | Estado |
|---|---|
| Versionamento | completo |
| Espaços | completo |
| Ativos modelados | completo (UI de casos: em falta) |
| Ativos não modelados | completo no âmbito 5B/6 |
| Reservas | completo (aprovação = futuro documentado) |
| Concorrência | completo no âmbito auditado |
| Grafo | fundação completa; conteúdo semântico = provisório |
| Sincronização | completo |
| Localização | modelados+manual completo; sensores futuros |
| Políticas | arquitetura completa; provider real futuro |
| IDS | não implementado |
| Ontologias | não implementado (decisão da tese pendente) |
| SHACL | não implementado |
| Sensores (localização) | não implementado |
| UI | parcial (fluxos administrativos via Bruno) |
| Segurança | parcial (sem auth; guardas de produção OK) |
| Produção | NÃO pronto para produção (protótipo de investigação) |
