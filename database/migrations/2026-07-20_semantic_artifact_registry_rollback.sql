-- Rollback for the governed Semantic Artifact Registry (Prompt 7B1).
-- Removes only schema introduced by this stage. It never touches Fuseki graphs.

ALTER TABLE `semantic_artifact_families`
  DROP FOREIGN KEY `fk_semantic_family_current_artifact`;

DROP TABLE `semantic_artifact_load_operations`;
DROP TABLE `semantic_artifacts`;
DROP TABLE `semantic_artifact_families`;
