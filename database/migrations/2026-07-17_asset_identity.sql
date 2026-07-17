-- Migration: identidade persistente dos ativos e continuidade das reservas (Prompt 4)
--
-- Expand-and-contract: NADA é removido nesta etapa. As colunas legadas de
-- assets (model_entity_id, model_version_id, current_space_entity_id,
-- reservable) são preservadas; model_version_id passa a NULLABLE porque um
-- ativo persistente não pertence a uma versão.
--
--  - assets ganha identidade persistente: asset_uuid, asset_code, semantic_uri
--    (nullable, nunca inventada), space_id (1:1 quando o ativo É um espaço),
--    linked_model_id (âmbito), source, lifecycle_status
--    (active|absent|pending_reconciliation|retired — separado da projeção de
--    reservabilidade `reservable`), updated_at, retired_at.
--  - asset_bindings: como um ativo aparece numa model_version concreta.
--  - asset_reconciliation_cases: casos ambiguous/unresolved para decisão humana.
--  - legacy_asset_mapping: relatório persistente do backfill (expand-and-contract).
--  - res_reservations ganha snapshots NULLABLE do contexto no momento da
--    reserva (binding, versão, nome, espaço, código) — sem tocar em estados,
--    ENUM (overdue), FKs existentes ou regras.
--
-- Aplicar:  cd back && npx tsx scripts/runSqlFile.ts ../database/migrations/2026-07-17_asset_identity.sql
-- Rollback: 2026-07-17_asset_identity_rollback.sql

ALTER TABLE `assets`
  MODIFY COLUMN `model_version_id` INT NULL,
  ADD COLUMN `asset_uuid` CHAR(36) NULL,
  ADD COLUMN `asset_code` VARCHAR(200) NULL,
  ADD COLUMN `semantic_uri` VARCHAR(500) NULL,
  ADD COLUMN `space_id` INT NULL,
  ADD COLUMN `linked_model_id` INT NULL,
  ADD COLUMN `source` VARCHAR(50) NOT NULL DEFAULT 'ifc',
  ADD COLUMN `lifecycle_status` ENUM('active','absent','pending_reconciliation','retired') NOT NULL DEFAULT 'active',
  ADD COLUMN `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  ADD COLUMN `retired_at` DATETIME NULL;

ALTER TABLE `assets`
  ADD UNIQUE KEY `uq_assets_uuid` (`asset_uuid`),
  ADD UNIQUE KEY `uq_assets_space` (`space_id`),
  ADD KEY `idx_assets_scope_code` (`linked_model_id`, `asset_code`),
  ADD CONSTRAINT `fk_assets_space` FOREIGN KEY (`space_id`) REFERENCES `spaces` (`id`),
  ADD CONSTRAINT `fk_assets_linked_model` FOREIGN KEY (`linked_model_id`) REFERENCES `linked_models` (`id`);

CREATE TABLE `asset_bindings` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `asset_id` INT NOT NULL,
  `model_version_id` INT NOT NULL,
  `model_entity_id` INT NOT NULL,
  `space_id` INT DEFAULT NULL,
  `space_entity_id` INT DEFAULT NULL,
  `ifc_guid` VARCHAR(100) NOT NULL,
  `asset_code_snapshot` VARCHAR(200) DEFAULT NULL,
  `name_snapshot` VARCHAR(255) DEFAULT NULL,
  `type_snapshot` VARCHAR(100) DEFAULT NULL,
  `binding_status` VARCHAR(20) NOT NULL DEFAULT 'active',
  `reconciliation_status` ENUM('resolved','pending','failed') NOT NULL DEFAULT 'resolved',
  `reconciliation_method` VARCHAR(50) DEFAULT NULL,
  `reconciliation_confidence` VARCHAR(20) DEFAULT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_ab_entity` (`model_entity_id`),
  UNIQUE KEY `uq_ab_asset_version` (`asset_id`, `model_version_id`),
  KEY `idx_ab_version` (`model_version_id`),
  KEY `idx_ab_guid` (`ifc_guid`),
  CONSTRAINT `fk_ab_asset` FOREIGN KEY (`asset_id`) REFERENCES `assets` (`id`),
  CONSTRAINT `fk_ab_version` FOREIGN KEY (`model_version_id`) REFERENCES `model_versions` (`id`),
  CONSTRAINT `fk_ab_entity` FOREIGN KEY (`model_entity_id`) REFERENCES `entities` (`id`),
  CONSTRAINT `fk_ab_space` FOREIGN KEY (`space_id`) REFERENCES `spaces` (`id`),
  CONSTRAINT `fk_ab_space_entity` FOREIGN KEY (`space_entity_id`) REFERENCES `entities` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `asset_reconciliation_cases` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `model_version_id` INT NOT NULL,
  `model_entity_id` INT NOT NULL,
  `ifc_guid` VARCHAR(100) NOT NULL,
  `name_snapshot` VARCHAR(255) DEFAULT NULL,
  `type_snapshot` VARCHAR(100) DEFAULT NULL,
  `space_id` INT DEFAULT NULL,
  `candidates_json` TEXT,
  `status` ENUM('open','resolved_link','resolved_new','resolved_replacement','ignored','failed') NOT NULL DEFAULT 'open',
  `resolved_asset_id` INT DEFAULT NULL,
  `resolved_by` VARCHAR(100) DEFAULT NULL,
  `resolved_at` DATETIME DEFAULT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_arc_entity` (`model_entity_id`),
  KEY `idx_arc_version_status` (`model_version_id`, `status`),
  CONSTRAINT `fk_arc_version` FOREIGN KEY (`model_version_id`) REFERENCES `model_versions` (`id`),
  CONSTRAINT `fk_arc_entity` FOREIGN KEY (`model_entity_id`) REFERENCES `entities` (`id`),
  CONSTRAINT `fk_arc_asset` FOREIGN KEY (`resolved_asset_id`) REFERENCES `assets` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `legacy_asset_mapping` (
  `legacy_asset_id` INT NOT NULL,
  `persistent_asset_id` INT DEFAULT NULL,
  `mapping_method` VARCHAR(50) DEFAULT NULL,
  `mapping_status` ENUM('mapped','ambiguous','unrecoverable') NOT NULL,
  `confidence` VARCHAR(20) DEFAULT NULL,
  `notes` TEXT,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`legacy_asset_id`),
  CONSTRAINT `fk_lam_persistent` FOREIGN KEY (`persistent_asset_id`) REFERENCES `assets` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE `res_reservations`
  ADD COLUMN `asset_binding_id_at_booking` INT DEFAULT NULL,
  ADD COLUMN `model_version_id_at_booking` INT DEFAULT NULL,
  ADD COLUMN `asset_name_snapshot` VARCHAR(255) DEFAULT NULL,
  ADD COLUMN `space_id_at_booking` INT DEFAULT NULL,
  ADD COLUMN `space_code_snapshot` VARCHAR(200) DEFAULT NULL;
