-- Prompt 7G: persistent local/dev application accounts and opaque sessions.
-- Manual application only. No reservation, evidence or graph data is deleted.

CREATE TABLE `application_accounts` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `account_uuid` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `account_key` VARCHAR(255) NOT NULL,
  `normalized_account_key` VARCHAR(255) NOT NULL,
  `display_label` VARCHAR(255) NOT NULL,
  `status` ENUM('active','suspended','disabled') NOT NULL DEFAULT 'active',
  `account_kind` ENUM('human','service') NOT NULL DEFAULT 'human',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `disabled_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_application_account_uuid` (`account_uuid`),
  UNIQUE KEY `uq_application_account_key` (`normalized_account_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `application_sessions` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `session_uuid` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `application_account_id` BIGINT NOT NULL,
  `token_hash` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `status` ENUM('active','expired','revoked') NOT NULL DEFAULT 'active',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `last_seen_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `expires_at` DATETIME(3) NOT NULL,
  `revoked_at` DATETIME(3) NULL,
  `created_by_provider` VARCHAR(100) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_application_session_uuid` (`session_uuid`),
  UNIQUE KEY `uq_application_session_token_hash` (`token_hash`),
  KEY `idx_application_session_active` (`application_account_id`,`status`,`expires_at`),
  CONSTRAINT `fk_application_session_account` FOREIGN KEY (`application_account_id`) REFERENCES `application_accounts` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE `actor_institutional_links`
  ADD COLUMN `application_account_id` BIGINT NULL,
  ADD KEY `idx_actor_link_application_account` (`application_account_id`),
  ADD CONSTRAINT `fk_actor_link_application_account` FOREIGN KEY (`application_account_id`) REFERENCES `application_accounts` (`id`);

ALTER TABLE `res_reservations`
  ADD COLUMN `application_account_id` BIGINT NULL,
  ADD KEY `idx_reservation_application_account` (`application_account_id`),
  ADD CONSTRAINT `fk_reservation_application_account` FOREIGN KEY (`application_account_id`) REFERENCES `application_accounts` (`id`);

ALTER TABLE `semantic_evidence_runs`
  ADD COLUMN `application_account_id` BIGINT NULL,
  ADD COLUMN `account_uuid_snapshot` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN `identity_provider` VARCHAR(100) NULL,
  ADD COLUMN `identity_assurance` VARCHAR(100) NULL,
  ADD KEY `idx_evidence_application_account` (`application_account_id`),
  ADD CONSTRAINT `fk_evidence_application_account` FOREIGN KEY (`application_account_id`) REFERENCES `application_accounts` (`id`);
