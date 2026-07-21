-- Prompt 7E rollback: SQL schema only. Historical model/report graphs are never deleted.
DROP TABLE IF EXISTS `semantic_validation_results`;
DROP TABLE IF EXISTS `semantic_validation_runs`;
