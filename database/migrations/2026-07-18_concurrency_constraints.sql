-- Migration: restrições de concorrência (Prompt 6; CONCURRENCY_AUDIT.md §5)
--
-- ÚNICA alteração: UNIQUE funcional que impõe NA BASE a unicidade do código
-- do gestor entre ativos NÃO modelados (source='graph'), com a MESMA
-- normalização usada pela aplicação (UPPER(TRIM())). Fecha a corrida §8.2:
-- dois registos simultâneos com o mesmo managerCode e chaves de idempotência
-- diferentes — a verificação prévia por SELECT não chega; agora o segundo
-- INSERT falha com duplicate key, que a aplicação traduz para 409
-- duplicate_manager_code.
--
-- A expressão devolve NULL para ativos modelados/espaciais (source≠'graph') e
-- para ativos sem código — NULLs múltiplos são permitidos num UNIQUE, pelo que
-- NADA muda para ativos modelados, espaços ou ativos sem managerCode.
--
-- Requer MySQL 8.0.13+ (índices funcionais). Nenhuma linha é modificada.
-- NOTA: falha se já existirem duplicados em source='graph' — nesse caso
-- resolver primeiro os duplicados (reconciliação/decisão humana), nunca
-- apagar automaticamente.
--
-- Aplicar:  cd back && npx tsx scripts/runSqlFile.ts ../database/migrations/2026-07-18_concurrency_constraints.sql
-- Rollback: 2026-07-18_concurrency_constraints_rollback.sql

ALTER TABLE `assets`
  ADD UNIQUE KEY `uq_assets_graph_manager_code`
  ((CASE WHEN `source` = 'graph' THEN UPPER(TRIM(`asset_code`)) END));
