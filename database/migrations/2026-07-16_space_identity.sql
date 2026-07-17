-- Migration: identidade persistente dos espaços (Prompt 3)
--
-- Cria:
--  - spaces: identidade persistente de um espaço físico/operacional, baseada
--    no código de inventário (convenção do projeto: Pset_SpaceCommon.Reference).
--    Independente de GUID IFC, versão, entity.id, nome e geometria.
--  - space_bindings: como um espaço persistente aparece numa model_version
--    concreta (liga espaço → versão → entity, com snapshots).
--  - linked_models.spatial_authority_model_id: modelo autoritativo para o
--    inventário espacial dentro da federação (NULL = regra por omissão:
--    quando a federação tem exatamente um model, esse model é a autoridade;
--    com vários models e NULL, nenhuma autoridade é assumida — ADR-0006).
--
-- Âmbito de unicidade provisório (ADR-0005): UNIQUE(linked_model_id,
-- inventory_code_normalized) — o mesmo código em federações diferentes
-- não colide.
--
-- NÃO toca em: entities, assets, res_reservations, model_versions,
-- storage_key, ficheiros IFC, ENUM de reservas.
--
-- Aplicar:  cd back && npx tsx scripts/runSqlFile.ts ../database/migrations/2026-07-16_space_identity.sql
-- Rollback: 2026-07-16_space_identity_rollback.sql

CREATE TABLE `spaces` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `space_uuid` CHAR(36) NOT NULL,
  `inventory_code` VARCHAR(200) NOT NULL,
  `inventory_code_normalized` VARCHAR(200) NOT NULL,
  `linked_model_id` INT NOT NULL,
  `name` VARCHAR(255) DEFAULT NULL,
  `semantic_uri` VARCHAR(500) DEFAULT NULL,
  `status` ENUM('active','absent','retired') NOT NULL DEFAULT 'active',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `retired_at` DATETIME DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_spaces_uuid` (`space_uuid`),
  UNIQUE KEY `uq_spaces_scope_code` (`linked_model_id`, `inventory_code_normalized`),
  CONSTRAINT `fk_spaces_linked_model` FOREIGN KEY (`linked_model_id`)
    REFERENCES `linked_models` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `space_bindings` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `space_id` INT NOT NULL,
  `model_version_id` INT NOT NULL,
  `entity_id` INT NOT NULL,
  `ifc_guid` VARCHAR(100) NOT NULL,
  `inventory_code_snapshot` VARCHAR(200) NOT NULL,
  `name_snapshot` VARCHAR(255) DEFAULT NULL,
  `long_name_snapshot` VARCHAR(255) DEFAULT NULL,
  `binding_status` VARCHAR(20) NOT NULL DEFAULT 'active',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_binding_entity` (`entity_id`),
  UNIQUE KEY `uq_binding_space_version` (`space_id`, `model_version_id`),
  KEY `idx_bindings_version` (`model_version_id`),
  CONSTRAINT `fk_bindings_space` FOREIGN KEY (`space_id`) REFERENCES `spaces` (`id`),
  CONSTRAINT `fk_bindings_version` FOREIGN KEY (`model_version_id`) REFERENCES `model_versions` (`id`),
  CONSTRAINT `fk_bindings_entity` FOREIGN KEY (`entity_id`) REFERENCES `entities` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE `linked_models`
  ADD COLUMN `spatial_authority_model_id` INT DEFAULT NULL,
  ADD CONSTRAINT `fk_lm_spatial_authority` FOREIGN KEY (`spatial_authority_model_id`)
    REFERENCES `models` (`id`) ON DELETE SET NULL;
