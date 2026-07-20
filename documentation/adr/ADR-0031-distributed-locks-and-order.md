# ADR-0031 — Locks nomeados, ordem global de aquisição e convergência idempotente (5B e casos)

- **Estado**: aceite (Prompt 6, 2026-07-18)
- **Contexto**: as operações de ativos não modelados atravessam DOIS sistemas
  sem transação conjunta (MySQL ↔ Fuseki). Uma transação SQL não cobre a
  janela SQL→grafo→SQL: dois movimentos simultâneos do mesmo ativo liam a
  mesma atribuição corrente e deixavam o GRAFO com duas correntes; dois
  retries da mesma operação executavam ambos; a resolução do mesmo caso de
  reconciliação podia criar dois assets.

## Decisão

1. **Locks nomeados do MySQL (`GET_LOCK`)** em conexões dedicadas do pool
   serializam secções críticas que atravessam I/O externo:
   - `oswadt.nm_asset.{assetId}` — movimento (e retoma de movimento) do mesmo
     ativo; a leitura da corrente no grafo acontece DENTRO do lock;
   - `oswadt.sync_op.{operation_uuid}` — retomadas da mesma operação; o estado
     é RELIDO dentro do lock (completed ⇒ devolve o resultado sem incrementar
     attempt_count nem tocar no grafo/SQL — "no máximo uma retomada efetiva");
   - `oswadt.reconciliation.apply` — execuções de apply-safe; cada correção
     revalida o estado antes de escrever (um caso que deixe de ser seguro
     entre report e apply não é aplicado).
2. **Ordem GLOBAL de aquisição** (prevenção de deadlock):
   `nm_asset → sync_op → (transação SQL: assets → res_reservations /
   asset_location_assignments / semantic_sync_operations)`. Nunca adquirir um
   nível anterior depois de um posterior. Timeouts explícitos (10 s/30 s);
   timeout ⇒ erro controlado `lock_timeout`, sem retry automático.
3. **Convergência em vez de erro nas corridas de idempotência**: colisão no
   UNIQUE (operation_type, idempotency_key) faz o perdedor RELER a operação
   vencedora e convergir (mesmo payload) ou receber 409 (payload divergente).
4. **managerCode imposto pela base**: UNIQUE funcional
   `uq_assets_graph_manager_code` (`CASE WHEN source='graph' THEN
   UPPER(TRIM(asset_code)) END`) — migration 2026-07-18. O duplicate key na
   projeção traduz-se em 409 `duplicate_manager_code` e a operação perdedora
   fica `failed_terminal`; o recurso órfão do grafo fica para o relatório de
   reconciliação (decisão humana — nunca apagado automaticamente).
5. **Resolução de casos de ativos modelados**: transação única com
   `SELECT … FOR UPDATE` na linha do caso (`resolveCaseTransactionally`);
   efeitos (asset/binding/retirada) e marcação partilham a transação; a
   resolução concorrente perdedora recebe 409 com o estado atual; casos
   resolvidos nunca são alterados.

## Consequências

- Duas correntes no grafo tornam-se improváveis por construção no deployment
  atual (um MySQL partilhado); múltiplos deployments sem MySQL comum ficam
  fora do âmbito (registado como limitação).
- `GET_LOCK` ocupa uma conexão do pool durante o I/O ao grafo — pool
  dimensionado (10) e timeouts do grafo curtos.
- Não há transação distribuída e isso continua a NUNCA ser alegado (I-GLOBAL);
  a ordem "operação SQL → grafo → verificação → projeção" com retry
  idempotente mantém-se (ADR-0027).
- Testes: tests/concurrency/nonModelledRace.test.ts e uploadAndCaseRace.test.ts.
