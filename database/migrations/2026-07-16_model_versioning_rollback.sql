-- Rollback da migration 2026-07-16_model_versioning.sql
--
-- Restaura o esquema anterior à etapa (model_versions: id, model_id,
-- created_at, description; models sem current_version_id).
--
-- ⚠️ AVISOS:
--  - Os metadados novos (version_number, status, storage_key, original_filename,
--    file_hash, file_size, created_by, activated_at, failure_reason) são
--    PERDIDOS e não podem ser representados no esquema anterior. Faz backup
--    antes se precisares de os preservar.
--  - Este rollback NÃO apaga ficheiros IFC (nem os históricos em
--    models/<id>/versions/... nem os legados) — rollback de banco não é
--    autorização para apagar armazenamento.
--  - Este rollback NÃO toca em res_reservations: o ENUM de estados (incluindo
--    'overdue'), as reservas e as suas foreign keys ficam intactos.
--
-- Aplicar com: cd back && npx tsx scripts/runSqlFile.ts ../database/migrations/2026-07-16_model_versioning_rollback.sql

ALTER TABLE `models` DROP FOREIGN KEY `fk_models_current_version`;

ALTER TABLE `models` DROP COLUMN `current_version_id`;

ALTER TABLE `model_versions` DROP INDEX `uq_model_version_number`;

ALTER TABLE `model_versions`
  DROP COLUMN `version_number`,
  DROP COLUMN `status`,
  DROP COLUMN `storage_key`,
  DROP COLUMN `original_filename`,
  DROP COLUMN `file_hash`,
  DROP COLUMN `file_size`,
  DROP COLUMN `created_by`,
  DROP COLUMN `activated_at`,
  DROP COLUMN `failure_reason`;
