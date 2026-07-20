-- Prompt 7C: executable IDS artifacts and normalized model-requirements reports.
-- Manual application only. This migration does not register profiles, load
-- graphs, validate IFC files, or change models/reservations.

ALTER TABLE `semantic_artifacts`
  ADD COLUMN `storage_mode` ENUM('graph_backed','file_executed') NOT NULL DEFAULT 'graph_backed' AFTER `semantic_uri`,
  MODIFY COLUMN `named_graph_uri` VARCHAR(1000) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN `executor_metadata_json` JSON NULL AFTER `named_graph_uri`,
  MODIFY COLUMN `validation_status` ENUM('not_validated','integrity_validated','graph_verified','file_verified','failed') NOT NULL DEFAULT 'not_validated';

ALTER TABLE `semantic_artifact_load_operations`
  MODIFY COLUMN `status` ENUM('pending_validation','validated','pending_graph','graph_written','file_validated','pending_activation','completed','failed_retryable','failed_terminal') NOT NULL DEFAULT 'pending_validation';

CREATE TABLE `model_requirement_validation_runs` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `run_uuid` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `model_version_id` INT NULL,
  `source_kind` ENUM('upload','demo','cli','automated_test') NOT NULL,
  `file_sha256` CHAR(64) NOT NULL,
  `ifc_schema` VARCHAR(100) NULL,
  `ids_profile_artifact_id` BIGINT NULL,
  `ids_profile_version` VARCHAR(100) NULL,
  `ids_profile_sha256` CHAR(64) NULL,
  `validation_mode` ENUM('disabled','report_only','required') NOT NULL,
  `overall_status` ENUM('pass','fail','error') NOT NULL,
  `ids_status` ENUM('pass','fail','error','not_evaluated') NOT NULL,
  `project_rules_status` ENUM('pass','fail','error','not_evaluated') NOT NULL,
  `executor_name` VARCHAR(200) NULL,
  `executor_version` VARCHAR(100) NULL,
  `started_at` DATETIME(3) NOT NULL,
  `completed_at` DATETIME(3) NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_model_requirement_run_uuid` (`run_uuid`),
  KEY `idx_model_requirement_run_version` (`model_version_id`, `created_at`),
  KEY `idx_model_requirement_run_profile` (`ids_profile_artifact_id`, `created_at`),
  CONSTRAINT `fk_model_requirement_run_version` FOREIGN KEY (`model_version_id`) REFERENCES `model_versions` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_model_requirement_run_profile` FOREIGN KEY (`ids_profile_artifact_id`) REFERENCES `semantic_artifacts` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `model_requirement_validation_results` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `validation_run_id` BIGINT NOT NULL,
  `source` ENUM('ids','project_rule') NOT NULL,
  `requirement_id` VARCHAR(200) NOT NULL,
  `requirement_name` VARCHAR(500) NOT NULL,
  `status` ENUM('pass','fail','warning','not_evaluated') NOT NULL,
  `severity` ENUM('info','warning','error') NOT NULL,
  `entity_type` VARCHAR(200) NULL,
  `entity_guid` VARCHAR(64) NULL,
  `property_set` VARCHAR(300) NULL,
  `property_name` VARCHAR(300) NULL,
  `expected_value` VARCHAR(1000) NULL,
  `actual_value` VARCHAR(1000) NULL,
  `message` VARCHAR(1000) NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_model_requirement_result_run` (`validation_run_id`, `source`, `status`),
  CONSTRAINT `fk_model_requirement_result_run` FOREIGN KEY (`validation_run_id`) REFERENCES `model_requirement_validation_runs` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- storage_mode/named_graph consistency and current-pointer eligibility remain
-- transactional domain invariants because they cross artifact/family rows.
