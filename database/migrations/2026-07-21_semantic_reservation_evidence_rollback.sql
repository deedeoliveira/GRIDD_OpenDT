-- Scoped Prompt 7F rollback. Historical named graphs are intentionally retained.
DROP TABLE IF EXISTS `reservation_semantic_evidence_links`;
DROP TABLE IF EXISTS `semantic_evidence_findings`;
DROP TABLE IF EXISTS `semantic_evidence_runs`;
-- The additive semantic_policy ENUM value is retained so immutable registry
-- history remains representable after the feature tables are removed.
