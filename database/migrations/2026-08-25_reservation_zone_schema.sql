-- Migration: RZ-2A1 — persistent identity storage for ReservationZone (schema only)
--
-- Scope: SCHEMA ONLY. No DB helper modules, no application wiring, no
-- persistence logic are part of this slice. Creates exactly four tables:
--  - reservation_zones: persistent identity for a ReservationZone
--    (IfcSpatialZone, PredefinedType=RESERVATION). Identity is the
--    app-minted reservation_zone_uuid; IFC GlobalId is manifestation
--    evidence, NOT persistent-resource identity (see registry table below).
--  - reservation_zone_bindings: how a persistent zone appears in a concrete
--    model_version (raw ifc_entity_id is file-local, scoped by
--    model_version_id — no entities.id FK; see A1-ENTITY-UNIQUE).
--  - reservation_zone_space_references: N:M derived rows resolving a
--    binding's referencedSpaceGlobalIds evidence against official spaces.
--  - reservation_zone_guid_registry: authoritative, lineage-scoped
--    ownership of an IFC GlobalId to a single reservation_zone_id, across
--    absence/retirement/new versions (NOT a "current manifestation"
--    pointer).
--
-- Frozen decisions: A1-GUID-REGISTRY=YES, A1-CURRENT-NAME=YES,
-- A1-LINEAGE-FK=linked_models(id), A1-ENTITY-UNIQUE=UNIQUE(model_version_id,
-- ifc_entity_id). No ifc_guid column on reservation_zones, no
-- binding_status, no UNIQUE(model_version_id, ifc_guid), no Name index, no
-- reconciliation table, no reservation FK — all deferred.
--
-- DDL corrections applied (from the two final narrow audits):
--  A. current_name / name_snapshot are NOT NULL — a persisted row represents
--     an ACCEPTED identity/binding; null-Name evidence stays observable only
--     at RZ-1 extraction time and must never reach these columns.
--  B. No redundant standalone KEY(model_version_id) on
--     reservation_zone_bindings — UNIQUE(model_version_id, ifc_entity_id)
--     already covers that leftmost prefix.
--  C. reservation_zone_guid_registry.ifc_guid is CHAR(22) CHARACTER SET
--     ascii COLLATE ascii_bin NOT NULL, matching the canonical
--     spaces.ifc_global_id precedent, since registry rows are the
--     authoritative ownership key. Its CHECK constraint reuses the exact
--     compressed-IFC-GUID validity expression established for
--     spaces.ifc_global_id in back/scripts/migrations/spaceGlobalId.ts
--     (chk_spaces_ifc_global_id_format), adapted only for the new
--     column/constraint name.
--  D. reservation_zone_bindings.ifc_guid is VARCHAR(100) CHARACTER SET
--     ascii COLLATE ascii_bin NOT NULL — manifestation evidence, wider than
--     the registry column, matching the space_bindings/asset_bindings
--     ifc_guid width convention. No case-folding/normalisation.
--  E. referenced_space_global_ids_snapshot is TEXT NOT NULL, no SQL
--     DEFAULT — application persistence must explicitly serialise "[]" when
--     extraction confirmed zero references; this migration only enforces
--     fail-closed NOT NULL.
--  F. reservation_zone_space_references has UNIQUE(binding_id, space_id)
--     and no redundant standalone KEY(binding_id).
--
-- V2 correction (registry cross-lineage integrity gap):
--  G. reservation_zones gains UNIQUE(linked_model_id, id) (uq_rz_lineage_id),
--     making the standalone idx_rz_linked_model redundant (removed — the
--     composite UNIQUE already serves linked_model_id-only lookups via its
--     leftmost prefix).
--  H. reservation_zone_guid_registry's independent fk_rzgr_zone FK is
--     replaced by a composite fk_rzgr_zone_lineage FK: (linked_model_id,
--     reservation_zone_id) -> reservation_zones(linked_model_id, id). This
--     makes a lineage-mismatched registry row (registry.linked_model_id !=
--     the referenced zone's linked_model_id) structurally un-insertable.
--     The separate fk_rzgr_linked_model FK (linked_model_id ->
--     linked_models(id)) is removed as redundant: fk_rzgr_zone_lineage
--     already requires linked_model_id to match a reservation_zones row,
--     and reservation_zones.linked_model_id is itself already FK-validated
--     against linked_models(id) by fk_rz_linked_model.
--
-- V3 correction (explicit FK-support indexes, physical-schema ambiguity):
--  I. reservation_zone_space_references gains an explicit
--     KEY idx_rzsr_space (space_id). Without it, MySQL silently
--     auto-creates its own unnamed support index for fk_rzsr_space
--     (InnoDB names it after the constraint itself) because
--     uq_rzsr_binding_space(binding_id, space_id) cannot serve a
--     space_id-only lookup — space_id is not its leftmost prefix. The
--     explicit index removes that implicit/engine-decided physical
--     dependency and makes the FK-support index an intentional, named,
--     reviewable part of the schema. No behavioural change; no new
--     redundancy (uq_rzsr_binding_space's leading column is binding_id,
--     not space_id).
--  J. reservation_zone_guid_registry gains an explicit
--     KEY idx_rzgr_zone_lineage (linked_model_id, reservation_zone_id),
--     for the same reason: fk_rzgr_zone_lineage's own FK columns were
--     previously served only by an implicit auto-created support index,
--     since uq_rzgr_model_guid(linked_model_id, ifc_guid) diverges at
--     column 2 (ifc_guid vs reservation_zone_id) and cannot serve this
--     FK. No behavioural change; no new redundancy.
--
-- NÃO toca em: spaces, assets, models, model_versions, linked_models,
-- entities, res_reservations, reservas/UI/artefactos semânticos.
--
-- Aplicar:  cd back && npx tsx scripts/runSqlFile.ts ../database/migrations/2026-08-25_reservation_zone_schema.sql
-- Rollback: 2026-08-25_reservation_zone_schema_rollback.sql

CREATE TABLE `reservation_zones` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `reservation_zone_uuid` CHAR(36) NOT NULL,
  `linked_model_id` INT NOT NULL,
  `current_name` VARCHAR(255) NOT NULL,
  `status` ENUM('active','absent','retired') NOT NULL DEFAULT 'active',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `retired_at` DATETIME DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_rz_uuid` (`reservation_zone_uuid`),
  UNIQUE KEY `uq_rz_lineage_id` (`linked_model_id`, `id`),
  CONSTRAINT `fk_rz_linked_model` FOREIGN KEY (`linked_model_id`)
    REFERENCES `linked_models` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `reservation_zone_bindings` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `reservation_zone_id` INT NOT NULL,
  `model_version_id` INT NOT NULL,
  `ifc_entity_id` INT NOT NULL,
  `ifc_guid` VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `name_snapshot` VARCHAR(255) NOT NULL,
  `referenced_space_global_ids_snapshot` TEXT NOT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_rzb_zone_version` (`reservation_zone_id`, `model_version_id`),
  UNIQUE KEY `uq_rzb_version_entity` (`model_version_id`, `ifc_entity_id`),
  KEY `idx_rzb_guid` (`ifc_guid`),
  CONSTRAINT `fk_rzb_zone` FOREIGN KEY (`reservation_zone_id`) REFERENCES `reservation_zones` (`id`),
  CONSTRAINT `fk_rzb_version` FOREIGN KEY (`model_version_id`) REFERENCES `model_versions` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `reservation_zone_space_references` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `binding_id` INT NOT NULL,
  `space_id` INT NOT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_rzsr_binding_space` (`binding_id`, `space_id`),
  KEY `idx_rzsr_space` (`space_id`),
  CONSTRAINT `fk_rzsr_binding` FOREIGN KEY (`binding_id`) REFERENCES `reservation_zone_bindings` (`id`),
  CONSTRAINT `fk_rzsr_space` FOREIGN KEY (`space_id`) REFERENCES `spaces` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `reservation_zone_guid_registry` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `linked_model_id` INT NOT NULL,
  `ifc_guid` CHAR(22) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `reservation_zone_id` INT NOT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_rzgr_model_guid` (`linked_model_id`, `ifc_guid`),
  KEY `idx_rzgr_zone_lineage` (`linked_model_id`, `reservation_zone_id`),
  CONSTRAINT `chk_rzgr_ifc_guid_format`
    CHECK (`ifc_guid` IS NULL OR `ifc_guid` REGEXP '^[0-9A-Za-z_$]{22}$'),
  CONSTRAINT `fk_rzgr_zone_lineage` FOREIGN KEY (`linked_model_id`, `reservation_zone_id`)
    REFERENCES `reservation_zones` (`linked_model_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
