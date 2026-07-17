-- Rollback da migration 2026-07-17_asset_identity.sql
--
-- ⚠️ AVISOS:
--  - As identidades persistentes já criadas, os bindings, os casos de
--    reconciliação, o mapeamento legado e os snapshots das reservas são
--    PERDIDOS — o esquema anterior não os representa. Faz backup antes.
--  - PRESERVA: reservas (linhas e ENUM com overdue), ficheiros IFC, versões,
--    spaces/space_bindings, schema restante.
--  - As reservas que tenham sido re-apontadas para ativos persistentes
--    mantêm o asset_id apontado — este rollback NÃO desfaz o re-mapeamento
--    de dados (limitação documentada; usa o backup do backfill se precisares
--    de reverter dados).
--  - model_version_id volta a NOT NULL: só é possível se não existirem
--    linhas persistentes com NULL — remove-as ou repõe o backup primeiro.

ALTER TABLE `res_reservations`
  DROP COLUMN `asset_binding_id_at_booking`,
  DROP COLUMN `model_version_id_at_booking`,
  DROP COLUMN `asset_name_snapshot`,
  DROP COLUMN `space_id_at_booking`,
  DROP COLUMN `space_code_snapshot`;

DROP TABLE `legacy_asset_mapping`;

DROP TABLE `asset_reconciliation_cases`;

DROP TABLE `asset_bindings`;

ALTER TABLE `assets`
  DROP FOREIGN KEY `fk_assets_space`;

ALTER TABLE `assets`
  DROP FOREIGN KEY `fk_assets_linked_model`;

ALTER TABLE `assets`
  DROP INDEX `uq_assets_uuid`,
  DROP INDEX `uq_assets_space`,
  DROP INDEX `idx_assets_scope_code`,
  DROP COLUMN `asset_uuid`,
  DROP COLUMN `asset_code`,
  DROP COLUMN `semantic_uri`,
  DROP COLUMN `space_id`,
  DROP COLUMN `linked_model_id`,
  DROP COLUMN `source`,
  DROP COLUMN `lifecycle_status`,
  DROP COLUMN `updated_at`,
  DROP COLUMN `retired_at`;

ALTER TABLE `assets`
  MODIFY COLUMN `model_version_id` INT NOT NULL;
