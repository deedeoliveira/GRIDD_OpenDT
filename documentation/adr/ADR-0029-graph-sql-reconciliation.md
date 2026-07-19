# ADR-0029 — Estratégia de reconciliação grafo–SQL

- **Estado**: aceite (Prompt 5B, 2026-07-18)
- **Contexto**: sem transação distribuída (ADR-0027), grafo e projeção SQL
  podem divergir. A divergência tem de ser DETETÁVEL e a correção tem de
  distinguir casos seguros de casos que exigem decisão humana.

## Decisão

`GraphSqlReconciliationService` compara autoridade (grafo) e projeção para
os ativos não modelados e classifica:

| Finding | Seguro? |
|---|---|
| graph_asset_missing_sql_projection | ✅ recriar projeção a partir do grafo |
| missing_location_projection | ✅ projetar a localização inequívoca |
| current_location_mismatch (grafo com UMA corrente) | ✅ alinhar SQL |
| incomplete_sync_operation (exceto pending_graph) | ✅ retomar operação |
| sql_projection_missing_graph_asset | ❌ linha SQL ≠ prova semântica |
| semantic_uri_mismatch / asset_uuid_mismatch | ❌ conflito de identidade |
| multiple_current_graph_locations | ❌ autoridade inconsistente |
| multiple_current_sql_locations | ❌ (o esquema deveria impedir) |
| orphan_location_projection | ❌ fechar histórico podia esconder problema |

- **modo relatório** (GET /api/semantic/reconciliation/report): só leitura,
  nunca escreve em lado nenhum;
- **modo aplicação segura** (POST .../apply-safe): aplica APENAS os ✅, é
  idempotente (2.ª execução → nada a aplicar) e NUNCA altera o grafo;
  ativos SQL cuja origem não é o grafo nem sequer são considerados;
- casos ❌ são apenas reportados — corrigir automaticamente poderia apagar
  histórico ou mascarar conflitos de identidade;
- execução por endpoint/script administrativo; SEM scheduler obrigatório e
  NUNCA por pedido de reserva.

## Consequências

- A recuperação após falha parcial é possível sem intervenção na BD à mão;
- decisões humanas ficam com trilho auditável (findings com detalhe);
- limitação documentada: os endpoints administrativos não têm autenticação
  (a aplicação não tem sistema de auth — risco herdado e registado).
