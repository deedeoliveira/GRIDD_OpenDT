# ADR-0027 — Máquina de estados da sincronização grafo→SQL e idempotência

- **Estado**: aceite (Prompt 5B, 2026-07-18)
- **Contexto**: MySQL e Fuseki NÃO têm transação conjunta — atomicidade
  distribuída nunca é alegada. É preciso um workflow auditável, retryável e
  idempotente.

## Decisão

Tabela `semantic_sync_operations` (controlo de workflow — NUNCA autoridade
do ativo):

```text
pending_graph → graph_written → pending_sql_projection → completed
                     ↘ failed_retryable (retry) / failed_terminal (humano)
```

- a operação é criada em SQL ANTES da escrita no grafo, com os UUIDs/URIs
  gerados (asset, atribuição, atividade derivada do operation_uuid);
- **idempotência**: UNIQUE (operation_type, idempotency_key); a mesma chave
  com o MESMO payload_hash (SHA-256 canónico) devolve o mesmo resultado /
  retoma a mesma operação; payload diferente → 409; retries reutilizam
  SEMPRE os mesmos UUIDs/URIs, não duplicam triplos (escrita ASK-guardada)
  nem linhas SQL (INSERTs verificados por UUID);
- **falhas**: grafo falha antes de escrever → failed_retryable, NENHUM
  asset/localização SQL é criado, nada fica reservável; grafo escrito e SQL
  falha → pending_sql_projection (o grafo permanece autoridade), projeção
  incompleta nunca fica reservável (gating de reservas consulta as
  operações incompletas); verificação pós-escrita falhada → não projeta;
- cada tentativa incrementa attempt_count e regista last_error_code/message
  SANITIZADOS (sem credenciais, tamanho limitado);
- retry é MANUAL (endpoint /api/semantic/sync/:id/retry e apply-safe da
  reconciliação); sem retry infinito e sem scheduler obrigatório
  (agendamento fica documentado como trabalho futuro).

## Consequências

- A aplicação nunca mostra como concluído o que não foi projetado; a
  reconciliação (ADR-0029) deteta operações incompletas;
- o rollback SQL não remove recursos RDF (documentado na migration).
