# Auditoria de Concorrência — Prompt 6 (2026-07-18)

Auditoria dos limites transacionais REAIS do código commitado (0aff9ca…d7abf42),
produzida ANTES de qualquer alteração, como exigido pelo §3 do Prompt 6.
Nenhuma regra de negócio foi alterada durante a auditoria.

---

## 1. Descoberta estrutural central (afeta tudo o resto)

**Cada classe `*Database` cria a sua própria instância de `MySQLDatabase`, e cada
instância detém UMA única `mysql.Connection` partilhada por todos os pedidos do
processo** ([mysqlDatabase.ts](../../back/utils/mysqlDatabase.ts)).

Consequências demonstradas pela leitura do código:

1. **Transações entrelaçam-se.** `beginTransaction()` emitido por um fluxo B
   enquanto o fluxo A tem uma transação aberta NA MESMA conexão faz o MySQL
   executar `BEGIN`, que **comita implicitamente** a transação de A a meio.
   Afeta: `modelVersionDatabase.reserveVersion/activateVersion`,
   `inventoryDatabase.saveInventorySnapshot/deleteInventoryForVersion`,
   `nonModelledAssetDatabase.projectRegistration/projectMovement`,
   `sensorDatabase`. O `SELECT … FOR UPDATE` do versionamento (Prompt 2) é
   correto em SQL, mas **dentro de um único processo Node nunca serializa dois
   uploads**: ambos usam a mesma conexão, e locks de linha são por conexão.
2. **`SELECT … FOR UPDATE` intra-processo é um no-op de serialização** — a
   conexão que pediria o lock já o detém.
3. **`GET_LOCK` intra-processo seria igualmente inútil** — locks nomeados do
   MySQL são reentrantes por conexão.

> Correção proposta (secção 8): substituir a conexão única por um
> **pool mysql2** (`createPool`), com transações em conexões DEDICADAS obtidas
> por `getConnection()`. Só então `FOR UPDATE`, `GET_LOCK` e o isolamento
> transacional passam a valer tanto entre processos como entre pedidos
> concorrentes do mesmo processo.

---

## 2. Mapa das transações atuais

| Fluxo | Fronteira transacional atual | Observação |
|---|---|---|
| Criar reserva (`reservationDatabase.createReservation`) | **NENHUMA** — 7+ queries autocommit soltas | corrida check→insert (secção 4.1) |
| check-in / checkout / cancelamento | **NENHUMA** — SELECT depois UPDATE sem condição de estado no UPDATE (checkout/cancel) | corridas de transição (secção 4.2) |
| `markExpiredReservationsAsNoShow` | autocommit, mas os UPDATEs têm condição de estado (`WHERE status='approved' …`, `WHERE status='in_use' …`) | CAS por natureza — **seguro** |
| `reserveVersion` (upload) | transação + `FOR UPDATE` em `models` + `UNIQUE(model_id, version_number)` + 1 retry em dup-key | correta em SQL; anulada intra-processo pela conexão única |
| `activateVersion` | transação + `FOR UPDATE` na versão e no modelo; só `processing` ativa | idem |
| `saveInventorySnapshot` / `deleteInventoryForVersion` | transação | idem |
| Resolução de `asset_reconciliation_cases` (rota) | **NENHUMA** — check `open` → criar asset → criar binding → retirar → `markCaseResolved` (o UPDATE final tem `WHERE status='open'`, mas os efeitos já aconteceram) | corrida de dupla resolução (secção 4.3) |
| Registo não modelado | operação criada ANTES do grafo (correto); mas `findOperationByKey`→`createOperation` é check→insert sem proteção além do UNIQUE; `ER_DUP_ENTRY` rebenta como 500 em vez de convergir | secção 4.4 |
| Movimento não modelado | leitura da corrente no grafo → escrita no grafo → projeção SQL; **sem serialização por ativo** | dois movimentos simultâneos criam DUAS correntes no grafo (secção 4.5) |
| Retry de sync (`resumeOperation`) | sem lock; dois retries simultâneos executam ambos (ASK-guarded evita triplos duplicados, mas `attempt_count` incrementa 2× e a fase SQL corre 2×) | secção 4.6 |
| `applySafe` da reconciliação | sem lock; duas execuções simultâneas intercalam correções | secção 4.7 |
| Projeções 5B (`projectRegistration`/`projectMovement`) | transação + inserts idempotentes por UUID | corretas em SQL; entrelaçáveis pela conexão única |

**Isolation level**: default InnoDB `REPEATABLE READ` (nunca alterado pelo
código). `SELECT … FOR UPDATE` é locking read (lê a versão mais recente).
Nota RR: o snapshot de leituras consistentes é fixado na PRIMEIRA leitura
não-locking da transação — por isso a regra "o lock do asset é a PRIMEIRA
instrução da transação" (secção 6) não é estilo, é correção.

**Tratamento atual de deadlocks**: inexistente (nenhum código trata 1213).
**Duplicate-key**: tratado apenas em `reserveVersion` (1 retry). Nos restantes
fluxos, `ER_DUP_ENTRY` propaga como erro 500 genérico.
**Retries internos existentes**: apenas o backstop de `reserveVersion`.

---

## 3. Invariantes a garantir

1. **I-RES-1**: nunca duas reservas aceites para o mesmo asset em intervalos
   incompatíveis (estados bloqueantes: `approved`, `in_use`, `no_show` — ver 4.1).
2. **I-RES-2**: `pending` NÃO bloqueia outros atores (comportamento atual
   documentado — preservado); bloqueia o PRÓPRIO ator (`hasActorConflict`
   conta `pending`+`approved`).
3. **I-RES-3**: cada transição de estado tem exatamente um vencedor
   (cancelar vs iniciar, checkout vs overdue, checkout duplo…).
4. **I-VER-1**: `version_number` único por modelo; UMA corrente
   (`models.current_version_id`); `failed` nunca corrente.
5. **I-CASE-1**: um `asset_reconciliation_case` é resolvido no máximo uma vez;
   uma resolução produz no máximo um asset e um binding.
6. **I-NM-1**: mesma `registrationKey`+payload ⇒ UMA operação, UM asset_uuid,
   UMA URI, UMA projeção, UMA representação RDF (mesmo sob corrida).
7. **I-NM-2**: `managerCode` (quando presente) único no âmbito `source='graph'`
   — imposto pela BASE, não só por consulta prévia.
8. **I-NM-3**: UMA localização corrente por ativo — no SQL (já garantido por
   `uq_ala_one_current`) **e no grafo** (hoje só verificado a posteriori).
9. **I-NM-4**: um retry concorrente produz no máximo UMA retomada efetiva;
   `attempt_count` conta reexecuções reais.
10. **I-GLOBAL**: MySQL e Fuseki NÃO têm transação distribuída — nenhuma
    correção pode alegar atomicidade conjunta; a ordem "SQL operação →
    grafo → verificação → projeção SQL" com retry idempotente mantém-se.

---

## 4. Condições de corrida encontradas

### 4.1 Reserva dupla (OBRIGATÓRIA — §4.1) — **CONFIRMADA**
`createReservation` executa `hasApprovedConflict` e `hasActorConflict` como
queries soltas e só depois o INSERT. Dois pedidos simultâneos intercalam nos
`await`: ambos veem 0 conflitos, ambos inserem. A janela existe intra-processo
(intercalação async) e inter-processo. Não há nenhum UNIQUE que impeça
sobreposição temporal (intervalos não são igualdade).

**Estados bloqueantes reais (auditados)**: `approved`, `in_use`, `no_show`
bloqueiam qualquer ator (`hasApprovedConflict`); `pending` NÃO bloqueia
terceiros; `pending`+`approved` bloqueiam o próprio ator. `approved` existe
hoje apenas por via administrativa/dados (não há fluxo de aprovação) — regra
preservada tal-e-qual.

### 4.2 Transições de estado — **CONFIRMADAS**
- `checkOut`: UPDATE final **sem** condição de estado → duas chamadas
  simultâneas "vencem" ambas; overdue lazy vs checkout intercalam.
- `cancelReservation`: UPDATE final sem condição → cancelar vs check-in
  simultâneos podem produzir `cancelled` sobre `in_use`.
- `checkIn`: UPDATE sem recondicionar `status='approved'` → check-in vs
  no_show lazy, check-in duplo (o guard `checkin_time` é lido fora).

### 4.3 Resolução dupla de caso (§7) — **CONFIRMADA**
Duas resoluções simultâneas do mesmo caso passam ambas o check `status==='open'`
e criam DOIS assets (`confirm_as_new_asset`) e tentam DOIS bindings (o segundo
morre no `uq_ab_entity`, tarde demais) e podem retirar dois ativos
(`confirm_replacement`). O `WHERE status='open'` do `markCaseResolved` chega
depois dos efeitos.

### 4.4 Registo não modelado simultâneo (§8.1/8.2) — **CONFIRMADA (2 corridas)**
- Mesma `registrationKey`: `UNIQUE(operation_type, idempotency_key)` impede a
  segunda operação, mas o `ER_DUP_ENTRY` não é traduzido — o cliente recebe
  500 em vez de convergir para a operação existente.
- Mesmo `managerCode`, chaves diferentes: só há consulta prévia
  (`findGraphAssetByManagerCode`) — **não existe restrição na base**; dois
  registos simultâneos criam dois assets com o mesmo código.

### 4.5 Movimentos simultâneos (§8.3) — **CONFIRMADA**
A e B leem a mesma corrente C no grafo; A fecha C e insere N1; B fecha C
(no-op) e insere N2 ⇒ **duas correntes no grafo**. A verificação pós-escrita
de B deteta (`length===1` falha) e marca `failed_retryable`, mas o dano no
grafo (autoridade!) fica feito, exigindo reconciliação manual. O SQL está
protegido (`uq_ala_one_current`), o grafo não.

### 4.6 Retries simultâneos (§8.4) — **CONFIRMADA**
`resumeOperation` não é serializado: dois retries incrementam `attempt_count`
duas vezes e executam a fase de projeção duas vezes (idempotente em dados, mas
"duas retomadas efetivas" viola I-NM-4).

### 4.7 `applySafe` simultâneo (§8.5) — **CONFIRMADA (baixo risco)**
Duas execuções intercalam; cada correção individual é idempotente e revalida o
grafo (`projectGraphLocation` re-consulta; `length!==1` aborta), mas os
`resumeOperation` internos herdam 4.6.

### 4.8 Versionamento (§6) — desenho correto, execução comprometida
`reserveVersion`/`activateVersion` estão corretos em SQL (FOR UPDATE + UNIQUE +
estado `processing` obrigatório + compensações por versão). A única falha real
é a da secção 1 (conexão única). **Não será reimplementado** — apenas passa a
correr em conexões dedicadas do pool.

### 4.9 Verificar-depois-escrever fora de transação (inventário)
`assertSpaceUsable`/`assertMovableAsset` (5B) e o snapshot de reserva leem fora
da fronteira de escrita. Com a serialização por asset (secção 6) e as
verificações refeitas dentro do lock, o risco residual é aceitável e documentado.

---

## 5. Índices e restrições

**Existentes e suficientes:**
- `idx_reservations_asset_time (asset_id, start_time, end_time, status)` — serve o check de conflito;
- `uq_mv (model_id, version_number)`; `uq_ab_entity`; `uq_ab_asset_version`;
- `uq_sso_idempotency (operation_type, idempotency_key)`; `uq_sso_uuid`;
- `uq_ala_uuid`; `uq_ala_one_current (asset_id, current_marker)`;
- `idx_sso_asset_status (asset_uuid, status)` — serve o gating de reservas;
- `uq_arc_entity (model_entity_id)` — backstop do binding duplo.

**Em falta (migration necessária):**
- **UNIQUE funcional para I-NM-2**:
  `UNIQUE KEY uq_assets_graph_manager_code ((CASE WHEN source='graph' THEN UPPER(TRIM(asset_code)) END))`
  — só constrange projeções do grafo (a expressão é NULL para 'ifc'/espacos;
  NULLs múltiplos são permitidos). MySQL 8.0.13+ (a base usa collation 0900 ⇒ 8.0). 

Nenhuma tabela de locks é necessária: linhas de `assets` (FOR UPDATE) +
`GET_LOCK` nomeado cobrem todos os casos com menos infraestrutura.

## 6. Locks necessários e ordem global

| Recurso | Mecanismo | Quem usa |
|---|---|---|
| Reserva por asset | `SELECT … FROM assets WHERE id=:id FOR UPDATE` — **primeira instrução da transação** | createReservation (e o ponto de extensão pending→approved) |
| Transições de reserva | UPDATE condicional (compare-and-set) + `affectedRows` | checkIn/checkOut/cancel |
| Versionamento | FOR UPDATE em `models`/`model_versions` (existente) | reserveVersion/activateVersion |
| Caso de reconciliação | `SELECT … FOR UPDATE` na linha do caso, efeitos e marcação NA MESMA transação | resolução de casos |
| Ativo não modelado (movimento) | `GET_LOCK('oswadt.nm_asset.{assetId}')` em conexão dedicada (cobre a janela SQL→grafo→SQL, que uma transação SQL não cobre) | move + retomas de move |
| Operação de sync | `GET_LOCK('oswadt.sync_op.{operation_uuid}')` + re-leitura do estado DENTRO do lock | resumeOperation (ambos os serviços) |
| apply-safe | `GET_LOCK('oswadt.reconciliation.apply')` | applySafe |

**Ordem global de aquisição (deadlock prevention):**
`nm_asset` → `sync_op` → (transação SQL: `assets` → `res_reservations`/`asset_location_assignments`/`semantic_sync_operations`).
Nunca adquirir um lock de nível anterior depois de um posterior. Locks GET_LOCK
têm timeout explícito (segundos) e são libertados em `finally`.

## 7. Estratégia de retry e de deadlock

- **Deadlock (1213 ER_LOCK_DEADLOCK)**: retry automático limitado (máx. 2
  tentativas extra), backoff pequeno (25 ms × tentativa), log estruturado
  `deadlock_detected` + `concurrency_retry`; esgotado ⇒ `concurrency_retry_exhausted` e erro controlado.
- **Lock wait timeout (1205)** e timeout de `GET_LOCK`: SEM retry automático —
  erro controlado imediato (`lock_timeout`), o cliente decide repetir.
- **Duplicate key (1062)**: tratado como CONVERGÊNCIA (mesma key ⇒ reler e
  retomar) ou CONFLITO 409 (managerCode) — nunca retry cego.
- **Nunca retry** para: erros de validação, conflitos de negócio (409), payload
  divergente, configuração insegura, autenticação, erro terminal do grafo.
- Nenhum detalhe interno do MySQL (números de erro, SQL) é exposto ao cliente.

## 8. Alterações propostas (implementadas nesta etapa)

1. `MySQLDatabase` passa a **pool** (`createPool`) mantendo `connection` como
   fachada de execução simples; novo `withTransaction(fn)` entrega uma conexão
   dedicada com begin/commit/rollback/release; novo `withNamedLock(name, fn)`.
   Os utilitários com transações passam a usar `withTransaction`.
2. `createReservation` → transação única com lock por asset (ordem: lock →
   lifecycle/5B gating → validador → conflitos → snapshot → INSERT), erros de
   negócio idênticos aos atuais.
3. Transições → CAS com `affectedRows`; mensagens preservadas.
4. Ponto de extensão interno `approvePendingWithinTransaction` (documentado,
   sem endpoint/botão/role/workflow).
5. Resolução de casos → função transacional em `persistentAssetDatabase` com
   FOR UPDATE; segunda resolução ⇒ 409.
6. Registo 5B: `ER_DUP_ENTRY` na operação ⇒ reler e convergir; migration do
   UNIQUE funcional de managerCode + tradução de 1062 ⇒ 409 `duplicate_manager_code`.
7. Movimento/retry/apply-safe 5B: locks nomeados conforme secção 6, com
   re-leitura do estado dentro do lock (completed ⇒ devolve sem incrementar).
8. Logs estruturados de concorrência (secção 7 + §13 do prompt).

## 9. Riscos

- O pool muda o comportamento de TODAS as queries (antes serializadas de facto
  pela conexão única) — a suite completa (379) é a rede de segurança; os fakes
  de teste passam a emular pool + locks para manter os testes representativos.
- Transação aberta durante a avaliação do validador de política (provider
  potencialmente lento) prolonga a posse do lock por asset — aceite (o provider
  atual é local e síncrono na prática) e documentado; timeout de lock protege.
- `GET_LOCK` durante I/O ao Fuseki mantém uma conexão do pool ocupada pela
  duração do timeout do grafo — dimensionamento do pool documentado (≥ 10).
- O UNIQUE funcional exige MySQL 8.0.13+ — confirmado pelo snapshot (collation
  utf8mb4_0900_ai_ci só existe no 8.0); a migration falha de forma limpa em
  versões antigas, sem efeitos parciais (índice único é a única alteração).
- Grafo continua sem transação com o SQL (I-GLOBAL): duas correntes no grafo
  tornam-se IMPROVÁVEIS (serialização por asset no mesmo deployment), não
  impossíveis (múltiplos deployments sem MySQL partilhado — fora do âmbito).
