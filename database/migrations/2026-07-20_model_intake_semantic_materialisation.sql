-- Prompt 7D: stable model/version identities and immutable IFC-to-RDF materialisation evidence.
-- Manual application only. This migration does not load a graph, upload a model,
-- alter reservations, or activate a semantic artifact.

ALTER TABLE `models` ADD COLUMN `model_uuid` CHAR(36) NULL AFTER `id`;
UPDATE `models` SET `model_uuid` = UUID() WHERE `model_uuid` IS NULL;
ALTER TABLE `models`
  MODIFY COLUMN `model_uuid` CHAR(36) NOT NULL,
  ADD UNIQUE KEY `uq_models_uuid` (`model_uuid`);

ALTER TABLE `model_versions` ADD COLUMN `version_uuid` CHAR(36) NULL AFTER `id`;
UPDATE `model_versions` SET `version_uuid` = UUID() WHERE `version_uuid` IS NULL;
ALTER TABLE `model_versions`
  MODIFY COLUMN `version_uuid` CHAR(36) NOT NULL,
  ADD UNIQUE KEY `uq_model_versions_uuid` (`version_uuid`);

CREATE TABLE `model_version_semantic_materialisations` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `materialisation_uuid` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `model_version_id` INT NOT NULL,
  `mapping_artifact_id` BIGINT NOT NULL,
  `ids_profile_artifact_id` BIGINT NULL,
  `named_graph_uri` VARCHAR(1000) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `source_file_sha256` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `mapping_version` VARCHAR(100) NOT NULL,
  `status` ENUM('pending','materialising','graph_written','verified','completed','failed_retryable','failed_terminal') NOT NULL DEFAULT 'pending',
  `turtle_sha256` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `triple_count` BIGINT NULL,
  `space_count` INT NULL,
  `asset_count` INT NULL,
  `manifestation_count` INT NULL,
  `started_at` DATETIME(3) NULL,
  `graph_written_at` DATETIME(3) NULL,
  `verified_at` DATETIME(3) NULL,
  `completed_at` DATETIME(3) NULL,
  `error_code` VARCHAR(100) NULL,
  `error_message` VARCHAR(1000) NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_model_materialisation_uuid` (`materialisation_uuid`),
  UNIQUE KEY `uq_model_materialisation_version` (`model_version_id`),
  UNIQUE KEY `uq_model_materialisation_graph` (`named_graph_uri`),
  KEY `idx_model_materialisation_status` (`status`, `updated_at`),
  CONSTRAINT `fk_model_materialisation_version` FOREIGN KEY (`model_version_id`) REFERENCES `model_versions` (`id`),
  CONSTRAINT `fk_model_materialisation_mapping` FOREIGN KEY (`mapping_artifact_id`) REFERENCES `semantic_artifacts` (`id`),
  CONSTRAINT `fk_model_materialisation_ids` FOREIGN KEY (`ids_profile_artifact_id`) REFERENCES `semantic_artifacts` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
