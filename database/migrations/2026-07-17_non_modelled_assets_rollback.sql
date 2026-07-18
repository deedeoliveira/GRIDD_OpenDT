-- Rollback da migration 2026-07-17_non_modelled_assets.sql (Prompt 5B)
--
-- LIMITES DO ROLLBACK (ler antes de executar):
--  - NÃO apaga reservas, ativos modelados, espaços, ficheiros IFC nem grafos;
--  - NÃO remove os recursos RDF já escritos no grafo operacional — o Fuseki
--    fica com ativos sem projeção SQL (deteção: GraphSqlReconciliationService,
--    finding graph_asset_missing_sql_projection);
--  - PERDE de forma IRREVERSÍVEL: projeções de ativos não modelados que só
--    existam nestas tabelas, histórico de localização projetado e o registo
--    das operações de sincronização (auditoria/idempotência);
--  - reservas de ativos não modelados (source='graph') ficariam a apontar
--    para assets sem localização projetada — só executar em ambiente
--    descartável, nunca contra dados reais com reservas destes ativos.
--
-- Executar: cd back && npx tsx scripts/runSqlFile.ts ../database/migrations/2026-07-17_non_modelled_assets_rollback.sql

DROP TABLE IF EXISTS `semantic_sync_operations`;
DROP TABLE IF EXISTS `asset_location_assignments`;

ALTER TABLE `assets`
  DROP COLUMN `asset_subtype`;
