-- Scoped rollback for Prompt 7G schema only. It never deletes reservations, evidence or graphs.
ALTER TABLE `semantic_evidence_runs` DROP FOREIGN KEY `fk_evidence_application_account`, DROP INDEX `idx_evidence_application_account`, DROP COLUMN `identity_assurance`, DROP COLUMN `identity_provider`, DROP COLUMN `account_uuid_snapshot`, DROP COLUMN `application_account_id`;
ALTER TABLE `res_reservations` DROP FOREIGN KEY `fk_reservation_application_account`, DROP INDEX `idx_reservation_application_account`, DROP COLUMN `application_account_id`;
ALTER TABLE `actor_institutional_links` DROP FOREIGN KEY `fk_actor_link_application_account`, DROP INDEX `idx_actor_link_application_account`, DROP COLUMN `application_account_id`;
DROP TABLE `application_sessions`;
DROP TABLE `application_accounts`;
