-- Prompt 4 (revisão) — identidade de equipamentos por IfcElement.Tag (EQP-)
-- e serial number como evidência separada da instância física.
--
-- Expand-and-contract: apenas ADIÇÃO de colunas NULLABLE.
--  - assets.serial_number: evidência da instância física do ativo persistente
--    (separada de asset_code, que passa a conter EXCLUSIVAMENTE o código
--    institucional derivado de IfcElement.Tag);
--  - asset_bindings.serial_snapshot: serial observado naquela versão;
--  - asset_bindings.object_type_snapshot: ObjectType do IfcBuildingElementProxy
--    (classificação informativa do modelador — NUNCA identidade).

ALTER TABLE assets
    ADD COLUMN serial_number VARCHAR(255) NULL AFTER asset_code;

ALTER TABLE asset_bindings
    ADD COLUMN serial_snapshot VARCHAR(255) NULL AFTER asset_code_snapshot,
    ADD COLUMN object_type_snapshot VARCHAR(255) NULL AFTER type_snapshot;
