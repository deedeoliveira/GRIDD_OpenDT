-- Prompt 7H: application authorization, bounded management scopes and append-only decisions.
CREATE TABLE `application_roles` (
  `id` BIGINT NOT NULL AUTO_INCREMENT, `role_key` VARCHAR(100) NOT NULL,
  `normalized_role_key` VARCHAR(100) NOT NULL, `display_label` VARCHAR(255) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`), UNIQUE KEY `uq_application_role_key` (`normalized_role_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE `application_account_roles` (
  `id` BIGINT NOT NULL AUTO_INCREMENT, `application_account_id` BIGINT NOT NULL,
  `application_role_id` BIGINT NOT NULL, `granted_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `granted_by` VARCHAR(100) NOT NULL DEFAULT 'local_synthetic_setup', `revoked_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`), UNIQUE KEY `uq_application_account_role` (`application_account_id`,`application_role_id`),
  CONSTRAINT `fk_account_role_account` FOREIGN KEY (`application_account_id`) REFERENCES `application_accounts` (`id`),
  CONSTRAINT `fk_account_role_role` FOREIGN KEY (`application_role_id`) REFERENCES `application_roles` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE `reservation_management_scopes` (
  `id` BIGINT NOT NULL AUTO_INCREMENT, `scope_uuid` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `application_account_id` BIGINT NOT NULL, `asset_id` INT NOT NULL, `status` ENUM('active','revoked') NOT NULL DEFAULT 'active',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `revoked_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`), UNIQUE KEY `uq_management_scope` (`application_account_id`,`asset_id`,`status`), UNIQUE KEY `uq_management_scope_uuid` (`scope_uuid`),
  CONSTRAINT `fk_management_scope_account` FOREIGN KEY (`application_account_id`) REFERENCES `application_accounts` (`id`),
  CONSTRAINT `fk_management_scope_asset` FOREIGN KEY (`asset_id`) REFERENCES `assets` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE `reservation_decisions` (
  `id` BIGINT NOT NULL AUTO_INCREMENT, `decision_uuid` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `reservation_id` INT NOT NULL, `decision_type` ENUM('approved','rejected','cancelled') NOT NULL,
  `previous_status` VARCHAR(32) NOT NULL, `new_status` VARCHAR(32) NOT NULL,
  `decided_by_application_account_id` BIGINT NOT NULL, `manager_role_snapshot` VARCHAR(100) NOT NULL,
  `management_scope_snapshot` VARCHAR(255) NOT NULL, `semantic_evidence_run_id` BIGINT NULL,
  `semantic_outcome_snapshot` ENUM('eligible','not_eligible','indeterminate') NULL,
  `sql_availability_snapshot` ENUM('available','conflict') NOT NULL, `reason` VARCHAR(1000) NULL,
  `override_acknowledged` TINYINT(1) NOT NULL DEFAULT 0, `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`), UNIQUE KEY `uq_reservation_decision_uuid` (`decision_uuid`), KEY `idx_reservation_decision_reservation` (`reservation_id`),
  CONSTRAINT `fk_decision_reservation` FOREIGN KEY (`reservation_id`) REFERENCES `res_reservations` (`id`),
  CONSTRAINT `fk_decision_account` FOREIGN KEY (`decided_by_application_account_id`) REFERENCES `application_accounts` (`id`),
  CONSTRAINT `fk_decision_evidence` FOREIGN KEY (`semantic_evidence_run_id`) REFERENCES `semantic_evidence_runs` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
