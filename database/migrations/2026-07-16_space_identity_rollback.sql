-- Rollback da migration 2026-07-16_space_identity.sql
--
-- ⚠️ AVISOS:
--  - As identidades persistentes (spaces) e as ligações por versão
--    (space_bindings) são PERDIDAS e não podem ser representadas no esquema
--    anterior. Faz backup antes se precisares de as preservar.
--  - NÃO apaga entities, assets, reservas nem ficheiros IFC.
--  - NÃO altera models.current_version_id, storage_key nem o ENUM das
--    reservas (overdue preservado).

ALTER TABLE `linked_models` DROP FOREIGN KEY `fk_lm_spatial_authority`;

ALTER TABLE `linked_models` DROP COLUMN `spatial_authority_model_id`;

DROP TABLE `space_bindings`;

DROP TABLE `spaces`;
