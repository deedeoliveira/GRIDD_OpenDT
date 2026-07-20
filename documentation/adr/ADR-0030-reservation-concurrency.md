# ADR-0030 — Concorrência das reservas: transação única com lock por asset e transições compare-and-set

- **Estado**: aceite (Prompt 6, 2026-07-18)
- **Contexto**: a auditoria (CONCURRENCY_AUDIT.md) confirmou duas famílias de
  corrida: (1) verificar disponibilidade → inserir reserva fora de qualquer
  transação — dois pedidos simultâneos podiam ambos passar as verificações;
  (2) transições de estado com SELECT-depois-UPDATE sem condição de estado no
  UPDATE — duas transições incompatíveis podiam ambas "vencer". Além disso,
  a conexão MySQL única partilhada anulava qualquer FOR UPDATE intra-processo
  e entrelaçava transações de fluxos diferentes.

## Decisão

1. **Pool de conexões** (`mysql2.createPool`) substitui a conexão única.
   Transações correm SEMPRE em conexões dedicadas (`withTransaction`); a
   fachada `connection` continua a servir queries avulsas.
2. **createReservation é uma transação única com lock por asset**: a PRIMEIRA
   instrução é `SELECT … FROM assets WHERE id=:id … FOR UPDATE`, serializando
   todas as criações de reserva do mesmo asset (intra e inter-processo) sem
   bloquear ativos diferentes. Lifecycle, gating 5B, conflitos (asset e ator),
   snapshot e INSERT acontecem dentro dessa fronteira; o commit liberta o lock.
   A regra "lock primeiro" é de correção: em REPEATABLE READ o snapshot fixa-se
   na primeira leitura — bloqueando primeiro, as leituras seguintes veem tudo o
   que o detentor anterior comitou.
3. **Estados bloqueantes preservados** (auditados, não alterados):
   `approved/in_use/no_show` bloqueiam terceiros; `pending` bloqueia apenas o
   próprio ator. A verificação definitiva de terceiros pertence à futura
   transição pending→approved.
4. **Transições por compare-and-set**: `UPDATE … WHERE id=:id AND status IN
   (estados esperados)` + verificação de `affectedRows`. O perdedor de uma
   corrida recebe o MESMO erro da execução sequencial. A máquina de estados
   NÃO mudou.
5. **Ponto de extensão para aprovação futura**:
   `approvePendingWithinTransaction` (não exposto; sem endpoint/role/portal)
   revalida conflitos sob o mesmo lock por asset e faz o CAS pending→approved.
6. **Deadlocks**: retry automático limitado (2 extra, backoff 25 ms×n) APENAS
   para 1213; lock wait timeout (1205) e erros de negócio nunca são repetidos;
   erros controlados sem detalhes internos do MySQL.

## Consequências

- Reserva dupla eliminada NA BASE (não no frontend, não em memória, não por
  mutex de processo único).
- O validador de política corre antes da transação (validação pura de input);
  conflitos temporais correm dentro. Latência do lock limitada à transação.
- Ativos diferentes nunca se serializam entre si (lock por linha).
- Testes: tests/concurrency/reservationRace.test.ts (fake com emulação de
  locks InnoDB) + scripts/concurrencyProbe.ts (HTTP real).
