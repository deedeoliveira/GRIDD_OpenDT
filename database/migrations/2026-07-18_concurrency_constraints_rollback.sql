-- Rollback: remove o UNIQUE funcional de managerCode (Prompt 6)
--
-- AVISO (não destrutivo para DADOS, mas destrutivo para GARANTIAS): remover
-- este índice reabre a corrida de registo simultâneo com o mesmo managerCode
-- (§8.2 do Prompt 6) — a aplicação volta a depender apenas da verificação
-- prévia por SELECT. Nenhuma linha de dados é apagada ou alterada.
--
-- Aplicar: cd back && npx tsx scripts/runSqlFile.ts ../database/migrations/2026-07-18_concurrency_constraints_rollback.sql

ALTER TABLE `assets`
  DROP KEY `uq_assets_graph_manager_code`;
