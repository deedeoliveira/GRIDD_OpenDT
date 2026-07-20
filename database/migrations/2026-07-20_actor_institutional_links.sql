-- Controlled actor-to-institutional-agent links (Prompt 7B2).
-- Manual application only. Contains no seeds and changes no reservation table.

CREATE TABLE `actor_institutional_links` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `link_uuid` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `actor_key` VARCHAR(255) NOT NULL,
  `actor_key_normalized` VARCHAR(255) NOT NULL,
  `institutional_agent_uri` VARCHAR(1000) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `institutional_dataset_artifact_id` BIGINT NOT NULL,
  `link_type` ENUM('represents_institutional_actor') NOT NULL,
  `status` ENUM('pending','verified','suspended','revoked','superseded') NOT NULL DEFAULT 'pending',
  `valid_from` DATETIME NULL,
  `valid_to` DATETIME NULL,
  `verified_at` DATETIME NULL,
  `verification_source` VARCHAR(100) NULL,
  `superseded_at` DATETIME NULL,
  `revoked_at` DATETIME NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `current_verified_key` VARCHAR(400) GENERATED ALWAYS AS (
    CASE
      WHEN `status` = 'verified' AND `superseded_at` IS NULL AND `revoked_at` IS NULL
      THEN CONCAT(`actor_key_normalized`, '|', `link_type`)
      ELSE NULL
    END
  ) STORED,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_actor_institutional_link_uuid` (`link_uuid`),
  UNIQUE KEY `uq_actor_institutional_current_verified` (`current_verified_key`),
  KEY `idx_actor_institutional_actor_history` (`actor_key_normalized`, `link_type`, `created_at`),
  KEY `idx_actor_institutional_artifact` (`institutional_dataset_artifact_id`),
  CONSTRAINT `fk_actor_institutional_dataset_artifact`
    FOREIGN KEY (`institutional_dataset_artifact_id`) REFERENCES `semantic_artifacts` (`id`),
  CONSTRAINT `chk_actor_institutional_validity`
    CHECK (`valid_to` IS NULL OR `valid_from` IS NULL OR `valid_to` > `valid_from`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- MySQL 8 generated-column uniqueness preserves history while ensuring at
-- most one stored current verified link per normalized actor key and type.
