-- Additive manager-role separation (BIM vs operational). ATOMIC catalogue change.
--
-- The schema already supports multiple roles per account through
-- application_account_roles; this migration only adjusts the role CATALOGUE.
-- It renames the legacy reservation_manager role row IN PLACE to the canonical
-- operational_manager, preserving its application_role_id and therefore every
-- existing application_account_roles grant, and inserts bim_manager if absent.
--
-- reservation_management_scopes and all existing scope rows are intentionally
-- left untouched: they remain in the schema as dormant future-granularity
-- infrastructure. Operational-manager authority is GLOBAL for this phase. This
-- supersedes the mandatory per-asset scope requirement of ADR-0046 (see ADR-0050).
--
-- ATOMICITY: the transformation runs inside a single transaction. runSqlFile.ts
-- executes every statement on one connection and, on any error, issues an
-- explicit ROLLBACK before closing — so a failure below leaves the catalogue
-- EXACTLY as before (no partial insert or rename). All statements are DML, so
-- the transaction is not broken by an implicit DDL commit.
--
-- DUAL-STATE FAILURE: the explicit guard below (not the UNIQUE constraint) forces
-- an error when both reservation_manager and operational_manager already exist,
-- rolling the whole transaction back before any change. Resolve such a state
-- manually (decide the authoritative row, repoint
-- application_account_roles.application_role_id off the redundant row, remove it)
-- before re-running.
--
-- APPLICATION: verify on a disposable database first (see
-- back/scripts/migrationSelfTest.ts). Before applying to the active
-- development/demo database, create a fresh backup and review the plan; the
-- archived post-presentation backup/tag baseline must remain untouched.

-- Informational (read-only) snapshot of the current role catalogue for review.
SELECT id, role_key, normalized_role_key, display_label
FROM application_roles
WHERE normalized_role_key IN ('reservation_manager', 'operational_manager');

START TRANSACTION;

-- Explicit dual-state guard, independent of the UNIQUE constraint. When both the
-- legacy and canonical rows already exist the correlated scalar subquery in the
-- SELECT list is evaluated for the single passing row and returns two rows,
-- raising MySQL error 1242 ("Subquery returns more than 1 row"). The whole
-- transaction then rolls back. When the state is valid (count <= 1) the WHERE
-- yields no rows, the failing subquery is never evaluated, and nothing happens.
SELECT (SELECT 1 UNION SELECT 2) AS abort_dual_reservation_and_operational_manager
FROM (SELECT 1) AS guard
WHERE (SELECT COUNT(*) FROM application_roles
       WHERE normalized_role_key IN ('reservation_manager', 'operational_manager')) > 1;

-- Rename reservation_manager -> operational_manager IN PLACE (id preserved, all
-- grants preserved). No-op when already migrated.
UPDATE application_roles
SET role_key = 'operational_manager',
    normalized_role_key = 'operational_manager',
    display_label = 'Operational Manager'
WHERE normalized_role_key = 'reservation_manager';

-- Insert canonical bim_manager only if absent (idempotent).
INSERT IGNORE INTO application_roles (role_key, normalized_role_key, display_label)
VALUES ('bim_manager', 'bim_manager', 'BIM Manager');

COMMIT;
