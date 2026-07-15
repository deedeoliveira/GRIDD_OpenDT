-- Migration: adiciona o estado 'overdue' ao ENUM de res_reservations.status
--
-- Contexto (2026-07-15): reservas in_use cujo end_time já passou passam a ser
-- marcadas como 'overdue' pelo backend (update lazy, junto do no_show).
-- O checkout aceita in_use e overdue e leva ambas a completed.
-- O ENUM atual está registado em ../schema_snapshot_2026-07-15.sql.

ALTER TABLE `res_reservations`
  MODIFY COLUMN `status` ENUM(
    'pending',
    'approved',
    'rejected',
    'cancelled',
    'in_use',
    'no_show',
    'completed',
    'overdue'
  ) DEFAULT 'pending';
