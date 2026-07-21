-- Prompt 7F: cross-domain semantic evidence in non-binding shadow mode.
-- Manual application only. This migration does not create/cancel reservations,
-- load graphs, activate policies or alter temporal conflict semantics.

ALTER TABLE `semantic_artifact_families`
  MODIFY COLUMN `artifact_type` ENUM(
    'ontology','bridge_vocabulary','shacl_shapes','institutional_dataset',
    'test_fixture','ids_profile','ifc_rdf_mapping','validation_report','semantic_policy'
  ) NOT NULL;

CREATE TABLE `semantic_evidence_runs` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `run_uuid` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `actor_key_normalized` VARCHAR(255) NOT NULL,
  `asset_id` INT NOT NULL,
  `asset_uuid` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `requested_start` DATETIME(3) NOT NULL,
  `requested_end` DATETIME(3) NOT NULL,
  `actor_link_id` BIGINT NULL,
  `institutional_artifact_id` BIGINT NULL,
  `model_version_id` INT NULL,
  `materialisation_id` BIGINT NULL,
  `structural_validation_run_id` BIGINT NULL,
  `policy_artifact_id` BIGINT NOT NULL,
  `evidence_graph_uri` VARCHAR(1000) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `policy_report_graph_uri` VARCHAR(1000) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `evidence_graph_sha256` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `policy_report_sha256` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `actor_evidence_status` ENUM('available','unavailable','indeterminate') NOT NULL,
  `resource_evidence_status` ENUM('available','unavailable','indeterminate') NOT NULL,
  `structural_status` ENUM('conforms','nonconformant','missing','indeterminate') NOT NULL,
  `shadow_eligibility_outcome` ENUM('eligible','not_eligible','indeterminate') NOT NULL,
  `sql_availability_status` ENUM('available','conflict') NOT NULL,
  `status` ENUM('completed','failed','expired') NOT NULL DEFAULT 'completed',
  `response_json` JSON NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `completed_at` DATETIME(3) NOT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `error_code` VARCHAR(100) NULL,
  `error_message` VARCHAR(1000) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_semantic_evidence_run_uuid` (`run_uuid`),
  UNIQUE KEY `uq_semantic_evidence_graph_uri` (`evidence_graph_uri`),
  UNIQUE KEY `uq_semantic_policy_report_graph_uri` (`policy_report_graph_uri`),
  KEY `idx_semantic_evidence_inputs` (`actor_key_normalized`, `asset_id`, `requested_start`, `requested_end`),
  KEY `idx_semantic_evidence_expiry` (`status`, `expires_at`),
  CONSTRAINT `fk_semantic_evidence_asset` FOREIGN KEY (`asset_id`) REFERENCES `assets` (`id`),
  CONSTRAINT `fk_semantic_evidence_actor_link` FOREIGN KEY (`actor_link_id`) REFERENCES `actor_institutional_links` (`id`),
  CONSTRAINT `fk_semantic_evidence_institutional_artifact` FOREIGN KEY (`institutional_artifact_id`) REFERENCES `semantic_artifacts` (`id`),
  CONSTRAINT `fk_semantic_evidence_model_version` FOREIGN KEY (`model_version_id`) REFERENCES `model_versions` (`id`),
  CONSTRAINT `fk_semantic_evidence_materialisation` FOREIGN KEY (`materialisation_id`) REFERENCES `model_version_semantic_materialisations` (`id`),
  CONSTRAINT `fk_semantic_evidence_structural_run` FOREIGN KEY (`structural_validation_run_id`) REFERENCES `semantic_validation_runs` (`id`),
  CONSTRAINT `fk_semantic_evidence_policy_artifact` FOREIGN KEY (`policy_artifact_id`) REFERENCES `semantic_artifacts` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE `semantic_evidence_findings` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `evidence_run_id` BIGINT NOT NULL,
  `focus_node` TEXT NULL,
  `result_path` TEXT NULL,
  `result_value` TEXT NULL,
  `source_shape` TEXT NULL,
  `constraint_component` TEXT NULL,
  `severity` VARCHAR(1000) NULL,
  `message` TEXT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_semantic_evidence_finding_run` (`evidence_run_id`, `id`),
  CONSTRAINT `fk_semantic_evidence_finding_run` FOREIGN KEY (`evidence_run_id`) REFERENCES `semantic_evidence_runs` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `reservation_semantic_evidence_links` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `reservation_id` INT NOT NULL,
  `evidence_run_id` BIGINT NOT NULL,
  `snapshot_sha256` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `linked_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_reservation_semantic_evidence_reservation` (`reservation_id`),
  UNIQUE KEY `uq_reservation_semantic_evidence_run` (`evidence_run_id`),
  CONSTRAINT `fk_reservation_semantic_evidence_reservation` FOREIGN KEY (`reservation_id`) REFERENCES `res_reservations` (`id`),
  CONSTRAINT `fk_reservation_semantic_evidence_run` FOREIGN KEY (`evidence_run_id`) REFERENCES `semantic_evidence_runs` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
