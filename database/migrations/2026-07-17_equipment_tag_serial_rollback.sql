-- Rollback da revisão do Prompt 4 (Tag/serial).
ALTER TABLE asset_bindings
    DROP COLUMN serial_snapshot,
    DROP COLUMN object_type_snapshot;

ALTER TABLE assets
    DROP COLUMN serial_number;
