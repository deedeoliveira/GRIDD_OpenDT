-- Migration: ativos não modelados — projeção SQL do grafo operacional (Prompt 5B)
--
-- O grafo operacional passa a ser a AUTORIDADE da existência/identidade/tipo/
-- localização dos ativos NÃO modelados; estas tabelas são a projeção
-- operacional (reservas, listagens, UI) e o controlo de sincronização.
-- NADA é removido; ativos modelados, bindings e reservas ficam intocados.
--
--  - assets ganha asset_subtype (tipo livre do não modelado, ex.
--    "PortableEquipment"); source='graph' identifica projeções do grafo.
--  - asset_location_assignments: projeção das atribuições TEMPORAIS de
--    localização (histórico nunca sobrescrito; UMA corrente por ativo,
--    garantida pela coluna gerada current_marker + UNIQUE).
--    is_current é DERIVADO de valid_to (gerado) — nunca escrito à mão.
--  - semantic_sync_operations: workflow de sincronização grafo→SQL com
--    idempotência (UNIQUE operation_type + idempotency_key) e retry.
--    NÃO é autoridade do ativo — apenas do estado da operação.
--
-- Aplicar:  cd back && npx tsx scripts/runSqlFile.ts ../database/migrations/2026-07-17_non_modelled_assets.sql
-- Rollback: 2026-07-17_non_modelled_assets_rollback.sql
--   (o rollback SQL NÃO remove recursos RDF já escritos no grafo)

ALTER TABLE `assets`
  ADD COLUMN `asset_subtype` VARCHAR(100) NULL;

CREATE TABLE `asset_location_assignments` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `assignment_uuid` CHAR(36) NOT NULL,
  `semantic_assertion_uri` VARCHAR(500) NOT NULL,
  `asset_id` INT NOT NULL,
  `space_id` INT NOT NULL,
  `source` VARCHAR(30) NOT NULL,
  `valid_from` DATETIME NOT NULL,
  `valid_to` DATETIME NULL,
  `observed_at` DATETIME NULL,
  `confidence` DECIMAL(4,3) NULL,
  `provenance_activity_uri` VARCHAR(500) NULL,
  `is_current` TINYINT(1) GENERATED ALWAYS AS (IF(`valid_to` IS NULL, 1, 0)) STORED,
  `current_marker` TINYINT GENERATED ALWAYS AS (IF(`valid_to` IS NULL, 1, NULL)) STORED,
  `projection_status` ENUM('projected','stale') NOT NULL DEFAULT 'projected',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_ala_uuid` (`assignment_uuid`),
  UNIQUE KEY `uq_ala_one_current` (`asset_id`, `current_marker`),
  KEY `idx_ala_asset` (`asset_id`, `valid_from`),
  KEY `idx_ala_space` (`space_id`),
  CONSTRAINT `fk_ala_asset` FOREIGN KEY (`asset_id`) REFERENCES `assets` (`id`),
  CONSTRAINT `fk_ala_space` FOREIGN KEY (`space_id`) REFERENCES `spaces` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `semantic_sync_operations` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `operation_uuid` CHAR(36) NOT NULL,
  `idempotency_key` VARCHAR(200) NOT NULL,
  `operation_type` ENUM('register_asset','move_asset') NOT NULL,
  `payload_hash` CHAR(64) NOT NULL,
  `asset_uuid` CHAR(36) NULL,
  `asset_uri` VARCHAR(500) NULL,
  `location_assignment_uuid` CHAR(36) NULL,
  `location_assignment_uri` VARCHAR(500) NULL,
  `closed_assignment_uuid` CHAR(36) NULL,
  `payload_json` TEXT NULL,
  `status` ENUM('pending_graph','graph_written','pending_sql_projection','completed','failed_retryable','failed_terminal') NOT NULL DEFAULT 'pending_graph',
  `attempt_count` INT NOT NULL DEFAULT 1,
  `last_error_code` VARCHAR(60) NULL,
  `last_error_message` TEXT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `completed_at` DATETIME NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sso_uuid` (`operation_uuid`),
  UNIQUE KEY `uq_sso_idempotency` (`operation_type`, `idempotency_key`),
  KEY `idx_sso_asset_status` (`asset_uuid`, `status`),
  KEY `idx_sso_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
