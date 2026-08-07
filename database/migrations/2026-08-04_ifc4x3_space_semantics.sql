-- Migration: IFC4x3 space semantics (ADR-0052)
--
-- Breaking semantic migration. Flips the space projection to IFC4x3 institutional
-- semantics and removes the legacy space-as-asset model:
--   A. spaces.name  -> spaces.long_name        (rename, data preserved)
--                     inventory_code now sourced from IfcSpace.Name (runtime change);
--                     long_name now sourced from IfcSpace.LongName.
--   B. space_bindings.name_snapshot removed     (ambiguous; the Name IS the inventory
--                     code and is already captured by inventory_code_snapshot;
--                     long_name_snapshot captures IfcSpace.LongName).
--   C. legacy space assets removed              (asset_type='space' + all dependents,
--                     in verified FK order) and asset_type ENUM contracted to
--                     ('equipment','tool').
--   D. legacy assets.space_id removed            (fk_assets_space, uq_assets_space, then
--                     the column) — it belonged to the removed one-space-asset-per-space
--                     model; modelled equipment location lives in asset_bindings.space_id.
--
-- TRUTHFULNESS (ADR-0052 "Consequences"): the rename moves spaces.name data into
-- spaces.long_name but does NOT convert old Reference-derived inventory codes into
-- IfcSpace.Name values. Existing operational rows require RE-INGESTION/RESET after
-- this migration; no backfill from old Reference values is attempted.
--
-- Space PERSISTENT IDENTITY (linked_model_id + ifc_global_id) and its unique index
-- uq_spaces_linked_model_ifc_global_id are untouched. uq_spaces_scope_code is retained
-- as the institutional inventory-code uniqueness constraint (same columns).
--
-- NOT applied to digital_twin in this task. Synthetic research data only; the space
-- asset/reservation removals below are intentional and auditable.
--
-- Aplicar:  cd back && npx tsx scripts/runSqlFile.ts ../database/migrations/2026-08-04_ifc4x3_space_semantics.sql
-- Rollback: 2026-08-04_ifc4x3_space_semantics_rollback.sql (structural only; deleted
--           legacy space assets/reservations are NOT restored — synthetic data)

-- ---------------------------------------------------------------------------
-- A. spaces.name -> spaces.long_name
-- ---------------------------------------------------------------------------
ALTER TABLE `spaces`
  CHANGE COLUMN `name` `long_name` VARCHAR(255) DEFAULT NULL;

-- ---------------------------------------------------------------------------
-- B. space_bindings: drop the now-ambiguous name_snapshot
-- ---------------------------------------------------------------------------
ALTER TABLE `space_bindings`
  DROP COLUMN `name_snapshot`;

-- ---------------------------------------------------------------------------
-- C. Legacy space-asset cleanup (FK-ordered; only asset_type='space')
--    Dependency graph (child -> parent):
--      reservation_semantic_evidence_links -> res_reservations
--      reservation_decisions               -> res_reservations
--      reservation_manager_evidence_reviews-> res_reservations
--      res_reservations                    -> assets
--      semantic_evidence_findings          -> semantic_evidence_runs
--      semantic_evidence_runs              -> assets
--      reservation_management_scopes       -> assets
--      asset_bindings                      -> assets
--      asset_reconciliation_cases          -> assets (resolved_asset_id)
--      asset_location_assignments          -> assets
--      legacy_asset_mapping                -> assets (persistent_asset_id)
-- ---------------------------------------------------------------------------

-- Reservation-level dependents of reservations that point at legacy space assets.
DELETE FROM `reservation_semantic_evidence_links`
 WHERE `reservation_id` IN (
   SELECT r.id FROM `res_reservations` r
   JOIN `assets` a ON a.id = r.asset_id
  WHERE a.asset_type = 'space');

DELETE FROM `reservation_decisions`
 WHERE `reservation_id` IN (
   SELECT r.id FROM `res_reservations` r
   JOIN `assets` a ON a.id = r.asset_id
  WHERE a.asset_type = 'space');

DELETE FROM `reservation_manager_evidence_reviews`
 WHERE `reservation_id` IN (
   SELECT r.id FROM `res_reservations` r
   JOIN `assets` a ON a.id = r.asset_id
  WHERE a.asset_type = 'space');

-- The reservations of legacy space assets themselves.
DELETE r FROM `res_reservations` r
   JOIN `assets` a ON a.id = r.asset_id
  WHERE a.asset_type = 'space';

-- Asset-level dependents of legacy space assets.
DELETE f FROM `semantic_evidence_findings` f
   JOIN `semantic_evidence_runs` sr ON sr.id = f.evidence_run_id
   JOIN `assets` a ON a.id = sr.asset_id
  WHERE a.asset_type = 'space';

DELETE sr FROM `semantic_evidence_runs` sr
   JOIN `assets` a ON a.id = sr.asset_id
  WHERE a.asset_type = 'space';

DELETE ms FROM `reservation_management_scopes` ms
   JOIN `assets` a ON a.id = ms.asset_id
  WHERE a.asset_type = 'space';

DELETE ab FROM `asset_bindings` ab
   JOIN `assets` a ON a.id = ab.asset_id
  WHERE a.asset_type = 'space';

DELETE arc FROM `asset_reconciliation_cases` arc
   JOIN `assets` a ON a.id = arc.resolved_asset_id
  WHERE a.asset_type = 'space';

DELETE ala FROM `asset_location_assignments` ala
   JOIN `assets` a ON a.id = ala.asset_id
  WHERE a.asset_type = 'space';

DELETE lam FROM `legacy_asset_mapping` lam
   JOIN `assets` a ON a.id = lam.persistent_asset_id
  WHERE a.asset_type = 'space';

-- The legacy space assets themselves. Equipment/tool assets and every dependent of a
-- non-space asset are untouched. Modelled equipment location is NOT held on the assets
-- row: it lives in asset_bindings.space_id (per model version) and is unaffected here;
-- the legacy assets.space_id column is dropped in step D below.
DELETE FROM `assets` WHERE `asset_type` = 'space';

-- Contract the enum so a space asset can never be created again (architecture guard
-- at the schema level). Safe only now that no row is asset_type='space'.
ALTER TABLE `assets`
  MODIFY COLUMN `asset_type` ENUM('equipment','tool') NOT NULL;

-- ---------------------------------------------------------------------------
-- D. Remove the legacy assets.space_id column (ADR-0052 §F location model).
--
--    assets.space_id + uq_assets_space + fk_assets_space were introduced by
--    2026-07-17_asset_identity.sql for the one-space-asset-per-space model
--    (`space_id (1:1 quando o ativo É um espaço)`). That model is gone: a space is
--    no longer an asset, and MODELLED equipment location is version-specific in
--    `asset_bindings.space_id` (current location = the current model-version binding),
--    while non-modelled/graph assets use `asset_location_assignments.space_id`. The
--    persistent `assets` row deliberately holds NO IFC-version-specific location, so
--    this column is now always NULL and must be removed rather than repurposed.
--
--    Runs AFTER the space-asset cleanup above (which relied on space_id to identify and
--    delete the legacy rows). Dropped in safe MySQL order: FK first (a UNIQUE index that
--    backs an FK cannot be dropped while the FK exists), then the unique index, then the
--    column. asset_bindings.space_id, asset_location_assignments.space_id,
--    asset_reconciliation_cases.space_id, the reservation space snapshots, spaces.id and
--    space_bindings are all UNTOUCHED.
-- ---------------------------------------------------------------------------
ALTER TABLE `assets`
  DROP FOREIGN KEY `fk_assets_space`;
ALTER TABLE `assets`
  DROP INDEX `uq_assets_space`;
ALTER TABLE `assets`
  DROP COLUMN `space_id`;
