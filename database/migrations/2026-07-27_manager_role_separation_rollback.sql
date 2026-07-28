-- ATOMIC, guard-first rollback of the additive manager-role separation.
--
-- Reverses the catalogue change ONLY when safe. It never uses CASCADE and never
-- deletes a role assignment. The transformation runs inside a single transaction;
-- runSqlFile.ts issues an explicit ROLLBACK on any error, so a failure leaves the
-- catalogue EXACTLY as it was before the rollback attempt.
--
-- SAFETY MODEL (verified on a disposable database, see
-- back/scripts/migrationSelfTest.ts):
--   * If any bim_manager grant exists, the first guard forces error 1242 BEFORE
--     anything is renamed or deleted, and the transaction rolls back. Nothing
--     changes: operational_manager stays operational_manager and bim_manager and
--     its grant are untouched. Revoke/remove those grants manually first.
--   * The DELETE of bim_manager is additionally protected by the RESTRICT foreign
--     key application_account_roles.fk_account_role_role (no ON DELETE clause), a
--     final backstop that itself refuses to drop a role with dependent grants.
--   * Historical reservation_decisions.manager_role_snapshot rows are immutable
--     VARCHAR snapshots and are deliberately NOT referenced or rewritten here.
--
-- Rollback after operational use may still require manual intervention (e.g. new
-- operational_manager decisions have already been recorded). Never touch the
-- archived backup/tag baseline.

START TRANSACTION;

-- Guard 1: refuse to roll back while any bim_manager grant exists (explicit,
-- before any change). Forces error 1242 -> whole transaction rolls back.
SELECT (SELECT 1 UNION SELECT 2) AS abort_bim_manager_has_active_or_historical_grants
FROM (SELECT 1) AS guard
WHERE (SELECT COUNT(*) FROM application_account_roles ar
       JOIN application_roles r ON r.id = ar.application_role_id
       WHERE r.normalized_role_key = 'bim_manager') > 0;

-- Guard 2: refuse if a reservation_manager row already exists alongside
-- operational_manager (would collide on the rename below).
SELECT (SELECT 1 UNION SELECT 2) AS abort_dual_reservation_and_operational_manager
FROM (SELECT 1) AS guard
WHERE (SELECT COUNT(*) FROM application_roles
       WHERE normalized_role_key IN ('reservation_manager', 'operational_manager')) > 1;

-- Rename operational_manager -> reservation_manager IN PLACE (id/grants preserved).
UPDATE application_roles
SET role_key = 'reservation_manager',
    normalized_role_key = 'reservation_manager',
    display_label = 'Reservation manager'
WHERE normalized_role_key = 'operational_manager';

-- Remove bim_manager. Guarded above to have no grants; the RESTRICT foreign key
-- is the final backstop.
DELETE FROM application_roles WHERE normalized_role_key = 'bim_manager';

COMMIT;
