-- Scoped rollback for Prompt 7D. Historical RDF graphs are deliberately not
-- deleted; this SQL only removes the projection introduced by the forward migration.

DROP TABLE IF EXISTS `model_version_semantic_materialisations`;

ALTER TABLE `model_versions`
  DROP INDEX `uq_model_versions_uuid`,
  DROP COLUMN `version_uuid`;

ALTER TABLE `models`
  DROP INDEX `uq_models_uuid`,
  DROP COLUMN `model_uuid`;
