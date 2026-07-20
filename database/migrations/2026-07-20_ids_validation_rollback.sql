-- Roll back Prompt 7C only. Removes normalized IDS validation reports and
-- file-executed registry revisions before restoring the graph-only 7B1 shape.

DROP TABLE `model_requirement_validation_results`;
DROP TABLE `model_requirement_validation_runs`;

UPDATE `semantic_artifact_families` f
JOIN `semantic_artifacts` a ON a.id = f.current_artifact_id
SET f.current_artifact_id = NULL
WHERE a.storage_mode = 'file_executed';

DELETE o FROM `semantic_artifact_load_operations` o
JOIN `semantic_artifacts` a ON a.id = o.artifact_id
WHERE a.storage_mode = 'file_executed';

DELETE FROM `semantic_artifacts` WHERE `storage_mode` = 'file_executed';
DELETE f FROM `semantic_artifact_families` f
LEFT JOIN `semantic_artifacts` a ON a.family_id = f.id
WHERE f.artifact_type = 'ids_profile' AND a.id IS NULL;

ALTER TABLE `semantic_artifact_load_operations`
  MODIFY COLUMN `status` ENUM('pending_validation','validated','pending_graph','graph_written','pending_activation','completed','failed_retryable','failed_terminal') NOT NULL DEFAULT 'pending_validation';

ALTER TABLE `semantic_artifacts`
  MODIFY COLUMN `validation_status` ENUM('not_validated','integrity_validated','graph_verified','failed') NOT NULL DEFAULT 'not_validated',
  DROP COLUMN `executor_metadata_json`,
  MODIFY COLUMN `named_graph_uri` VARCHAR(1000) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  DROP COLUMN `storage_mode`;
