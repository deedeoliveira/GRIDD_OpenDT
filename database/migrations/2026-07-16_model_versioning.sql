-- Migration: versionamento de modelos e ficheiros IFC imutáveis (Prompt 2)
--
-- Acrescenta a model_versions os metadados de versão e ficheiro, e a models a
-- referência explícita à versão corrente. NÃO toca em res_reservations, no
-- ENUM de estados das reservas, em entities/assets nem em ficheiros no disco.
--
-- Estados de versão (versionamento, não política):
--   processing = upload recebido, processamento ainda não concluído
--   active     = versão válida e corrente
--   failed     = processamento não concluído (nunca pode ser corrente)
--   archived   = versão válida, histórica, não corrente (ficheiro CONTINUA recuperável)
--
-- Nota de dependência: models.current_version_id -> model_versions.id e
-- model_versions.model_id -> models.id formam uma referência mútua. Não é
-- circular na criação porque current_version_id é NULL até à ativação da
-- primeira versão (INSERT do model -> INSERT da versão -> UPDATE do model).
--
-- Aplicar com: cd back && npx tsx scripts/runSqlFile.ts ../database/migrations/2026-07-16_model_versioning.sql
-- Rollback:    2026-07-16_model_versioning_rollback.sql

ALTER TABLE `model_versions`
  ADD COLUMN `version_number` INT NULL AFTER `model_id`,
  ADD COLUMN `status` ENUM('processing','active','failed','archived') NOT NULL DEFAULT 'processing' AFTER `version_number`,
  ADD COLUMN `storage_key` VARCHAR(500) NULL,
  ADD COLUMN `original_filename` VARCHAR(500) NULL,
  ADD COLUMN `file_hash` CHAR(64) NULL,
  ADD COLUMN `file_size` BIGINT NULL,
  ADD COLUMN `created_by` VARCHAR(100) NULL,
  ADD COLUMN `activated_at` DATETIME NULL,
  ADD COLUMN `failure_reason` TEXT NULL;

-- Unicidade do número por modelo. Linhas ainda por backfill têm NULL,
-- que o MySQL não considera em UNIQUE — o backfill preenche depois.
ALTER TABLE `model_versions`
  ADD UNIQUE KEY `uq_model_version_number` (`model_id`, `version_number`);

ALTER TABLE `models`
  ADD COLUMN `current_version_id` INT NULL,
  ADD CONSTRAINT `fk_models_current_version`
    FOREIGN KEY (`current_version_id`) REFERENCES `model_versions` (`id`)
    ON DELETE SET NULL;
