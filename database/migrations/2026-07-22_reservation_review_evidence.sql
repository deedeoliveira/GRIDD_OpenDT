-- Prompt 7H correction: immutable submission evidence remains linked through
-- reservation_semantic_evidence_links. This table records manager-session
-- review evidence separately; it never replaces or deletes that snapshot.
CREATE TABLE `reservation_manager_evidence_reviews` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `review_uuid` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `reservation_id` INT NOT NULL,
  `evidence_run_id` BIGINT NOT NULL,
  `manager_application_account_id` BIGINT NOT NULL,
  `manager_session_uuid` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `actor_link_id` BIGINT NULL,
  `institutional_artifact_id` BIGINT NULL,
  `model_version_id` INT NULL,
  `materialisation_id` BIGINT NULL,
  `structural_validation_run_id` BIGINT NULL,
  `policy_artifact_id` BIGINT NOT NULL,
  `reservation_input_hash` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `status` ENUM('current','stale','expired','session_ended') NOT NULL DEFAULT 'current',
  `stale_reason` VARCHAR(100) NULL,
  `reviewed_at` DATETIME(3) NOT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_reservation_manager_review_uuid` (`review_uuid`),
  KEY `idx_reservation_manager_review_current` (`reservation_id`,`manager_application_account_id`,`manager_session_uuid`,`status`,`expires_at`),
  CONSTRAINT `fk_reservation_review_reservation` FOREIGN KEY (`reservation_id`) REFERENCES `res_reservations` (`id`),
  CONSTRAINT `fk_reservation_review_evidence` FOREIGN KEY (`evidence_run_id`) REFERENCES `semantic_evidence_runs` (`id`),
  CONSTRAINT `fk_reservation_review_manager` FOREIGN KEY (`manager_application_account_id`) REFERENCES `application_accounts` (`id`),
  CONSTRAINT `fk_reservation_review_actor_link` FOREIGN KEY (`actor_link_id`) REFERENCES `actor_institutional_links` (`id`),
  CONSTRAINT `fk_reservation_review_institutional_artifact` FOREIGN KEY (`institutional_artifact_id`) REFERENCES `semantic_artifacts` (`id`),
  CONSTRAINT `fk_reservation_review_model_version` FOREIGN KEY (`model_version_id`) REFERENCES `model_versions` (`id`),
  CONSTRAINT `fk_reservation_review_materialisation` FOREIGN KEY (`materialisation_id`) REFERENCES `model_version_semantic_materialisations` (`id`),
  CONSTRAINT `fk_reservation_review_structural_run` FOREIGN KEY (`structural_validation_run_id`) REFERENCES `semantic_validation_runs` (`id`),
  CONSTRAINT `fk_reservation_review_policy_artifact` FOREIGN KEY (`policy_artifact_id`) REFERENCES `semantic_artifacts` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
