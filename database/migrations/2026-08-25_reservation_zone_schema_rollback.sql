-- Rollback da migration 2026-08-25_reservation_zone_schema.sql
--
-- ⚠️ AVISOS:
--  - Qualquer identidade de ReservationZone, bindings, referências N:M e o
--    registo de GUID já persistidos são PERDIDOS — o esquema anterior não
--    os representa. Faz backup antes se precisares de os preservar.
--  - NÃO apaga spaces, assets, models, model_versions, linked_models,
--    entities, res_reservations, nem qualquer artefacto semântico/UI.
--  - Ordem inversa à das FKs criadas na migration: ambas
--    reservation_zone_bindings e reservation_zone_guid_registry dependem de
--    reservation_zones (mas não uma da outra), por isso a ordem relativa
--    entre elas é indiferente desde que ambas sejam removidas antes de
--    reservation_zones e depois dos seus próprios dependentes
--    (reservation_zone_space_references depende de
--    reservation_zone_bindings).

DROP TABLE `reservation_zone_space_references`;

DROP TABLE `reservation_zone_bindings`;

DROP TABLE `reservation_zone_guid_registry`;

DROP TABLE `reservation_zones`;
