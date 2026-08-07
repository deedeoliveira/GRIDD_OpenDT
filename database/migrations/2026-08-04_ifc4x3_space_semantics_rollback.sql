-- Rollback: IFC4x3 space semantics (ADR-0052) — STRUCTURAL ONLY.
--
-- Reverts the schema SHAPE changes only. It does NOT and CANNOT restore:
--   - deleted legacy space assets, their bindings/reconciliation/location rows, or the
--     reservations that pointed at them (intentionally removed synthetic data);
--   - the old per-row `assets.space_id` values (the column is recreated empty/NULL);
--   - old Reference-derived inventory codes or the pre-rename spaces.name contents.
-- Those values are not recoverable from schema alone; re-ingestion is the supported
-- recovery path. This rollback makes NO data-restorative claim.
--
-- Aplicar: cd back && npx tsx scripts/runSqlFile.ts ../database/migrations/2026-08-04_ifc4x3_space_semantics_rollback.sql

-- D. Structurally restore the legacy assets.space_id column, its unique index and FK
--    (reverse of forward step D). The column is recreated NULL for every existing row —
--    the historical 1:1 space-asset values are NOT reconstructed. Column first, then the
--    UNIQUE index, then the FK (an FK requires its backing unique index to exist).
ALTER TABLE `assets`
  ADD COLUMN `space_id` INT NULL;
ALTER TABLE `assets`
  ADD UNIQUE KEY `uq_assets_space` (`space_id`);
ALTER TABLE `assets`
  ADD CONSTRAINT `fk_assets_space` FOREIGN KEY (`space_id`) REFERENCES `spaces` (`id`);

-- C. Re-widen the asset_type enum to include the legacy 'space' member.
ALTER TABLE `assets`
  MODIFY COLUMN `asset_type` ENUM('space','equipment','tool') NOT NULL;

-- B. Re-add space_bindings.name_snapshot (nullable; historical data not restored).
ALTER TABLE `space_bindings`
  ADD COLUMN `name_snapshot` VARCHAR(255) DEFAULT NULL AFTER `inventory_code_snapshot`;

-- A. spaces.long_name -> spaces.name
ALTER TABLE `spaces`
  CHANGE COLUMN `long_name` `name` VARCHAR(255) DEFAULT NULL;
