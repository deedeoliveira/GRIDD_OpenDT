-- Governed Semantic Artifact Registry (Prompt 7B1).
-- Manual application only; this migration does not load RDF or modify existing data.

CREATE TABLE `semantic_artifact_families` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `family_uuid` CHAR(36) NOT NULL,
  `artifact_type` ENUM('ontology','bridge_vocabulary','shacl_shapes','institutional_dataset','test_fixture','ids_profile','ifc_rdf_mapping','validation_report') NOT NULL,
  `family_key` VARCHAR(200) NOT NULL,
  `name` VARCHAR(300) NOT NULL,
  `semantic_uri` VARCHAR(1000) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `privacy_policy` ENUM('public_research_artifact','synthetic_runtime_data','synthetic_test_only','private_local','requires_manual_review') NOT NULL,
  `current_artifact_id` BIGINT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_semantic_family_uuid` (`family_uuid`),
  UNIQUE KEY `uq_semantic_family_key` (`family_key`),
  UNIQUE KEY `uq_semantic_family_type_uri` (`artifact_type`, `semantic_uri`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `semantic_artifacts` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `artifact_uuid` CHAR(36) NOT NULL,
  `family_id` BIGINT NOT NULL,
  `semantic_version` VARCHAR(100) NOT NULL,
  `source_filename` VARCHAR(500) NOT NULL,
  `repository_relative_path` VARCHAR(1000) NOT NULL,
  `byte_size` BIGINT NOT NULL,
  `sha256` CHAR(64) NOT NULL,
  `media_type` VARCHAR(100) NOT NULL,
  `serialization` VARCHAR(50) NOT NULL,
  `semantic_uri` VARCHAR(1000) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `named_graph_uri` VARCHAR(1000) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `lifecycle_status` ENUM('staged','validated','active','superseded','retired','failed') NOT NULL DEFAULT 'staged',
  `validation_status` ENUM('not_validated','integrity_validated','graph_verified','failed') NOT NULL DEFAULT 'not_validated',
  `validation_summary_json` JSON NULL,
  `source_package_name` VARCHAR(300) NOT NULL,
  `source_package_version` VARCHAR(100) NOT NULL,
  `source_release_status` VARCHAR(100) NOT NULL,
  `privacy_classification` ENUM('public_research_artifact','synthetic_runtime_data','synthetic_test_only','private_local','requires_manual_review') NOT NULL,
  `predecessor_artifact_id` BIGINT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `validated_at` DATETIME NULL,
  `activated_at` DATETIME NULL,
  `superseded_at` DATETIME NULL,
  `retired_at` DATETIME NULL,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_semantic_artifact_uuid` (`artifact_uuid`),
  UNIQUE KEY `uq_semantic_artifact_family_version` (`family_id`, `semantic_version`),
  UNIQUE KEY `uq_semantic_artifact_graph_uri` (`named_graph_uri`),
  UNIQUE KEY `uq_semantic_artifact_family_hash` (`family_id`, `sha256`),
  CONSTRAINT `fk_semantic_artifact_family` FOREIGN KEY (`family_id`) REFERENCES `semantic_artifact_families` (`id`),
  CONSTRAINT `fk_semantic_artifact_predecessor` FOREIGN KEY (`predecessor_artifact_id`) REFERENCES `semantic_artifacts` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE `semantic_artifact_families`
  ADD CONSTRAINT `fk_semantic_family_current_artifact`
  FOREIGN KEY (`current_artifact_id`) REFERENCES `semantic_artifacts` (`id`);

CREATE TABLE `semantic_artifact_load_operations` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `operation_uuid` CHAR(36) NOT NULL,
  `idempotency_key` VARCHAR(300) NOT NULL,
  `artifact_id` BIGINT NOT NULL,
  `operation_type` ENUM('load_and_activate','load_without_activation','activate_existing','rollback_activation') NOT NULL,
  `status` ENUM('pending_validation','validated','pending_graph','graph_written','pending_activation','completed','failed_retryable','failed_terminal') NOT NULL DEFAULT 'pending_validation',
  `payload_hash` CHAR(64) NOT NULL,
  `attempt_count` INT NOT NULL DEFAULT 0,
  `previous_artifact_id` BIGINT NULL,
  `error_code` VARCHAR(100) NULL,
  `error_message` VARCHAR(1000) NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `started_at` DATETIME NULL,
  `graph_written_at` DATETIME NULL,
  `activated_at` DATETIME NULL,
  `completed_at` DATETIME NULL,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_semantic_load_operation_uuid` (`operation_uuid`),
  UNIQUE KEY `uq_semantic_load_idempotency_key` (`idempotency_key`),
  KEY `idx_semantic_load_artifact_status` (`artifact_id`, `status`),
  CONSTRAINT `fk_semantic_load_artifact` FOREIGN KEY (`artifact_id`) REFERENCES `semantic_artifacts` (`id`),
  CONSTRAINT `fk_semantic_load_previous_artifact` FOREIGN KEY (`previous_artifact_id`) REFERENCES `semantic_artifacts` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Same-family/current eligibility is a transactional domain invariant because
-- MySQL cannot express the required cross-table predicate as a foreign key.
