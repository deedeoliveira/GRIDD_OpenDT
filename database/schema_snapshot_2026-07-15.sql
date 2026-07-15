-- Snapshot do esquema real da BD de desenvolvimento (SHOW CREATE TABLE)
-- Extraído em 2026-07-15 (etapa de baseline / correção do estado overdue)

CREATE TABLE `assets` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  `asset_type` enum('space','equipment','tool') NOT NULL,
  `reservable` tinyint(1) DEFAULT '1',
  `model_entity_id` int DEFAULT NULL,
  `model_version_id` int NOT NULL,
  `current_space_entity_id` int DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `model_entity_id` (`model_entity_id`),
  KEY `current_space_entity_id` (`current_space_entity_id`),
  KEY `idx_assets_space_version` (`current_space_entity_id`,`model_version_id`),
  KEY `idx_assets_model_version` (`model_version_id`),
  CONSTRAINT `assets_ibfk_1` FOREIGN KEY (`model_entity_id`) REFERENCES `entities` (`id`),
  CONSTRAINT `assets_ibfk_2` FOREIGN KEY (`current_space_entity_id`) REFERENCES `entities` (`id`),
  CONSTRAINT `fk_assets_model_version` FOREIGN KEY (`model_version_id`) REFERENCES `model_versions` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=34 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `channels` (
  `id` varchar(50) NOT NULL,
  `name` varchar(50) DEFAULT NULL,
  `description` varchar(255) DEFAULT NULL,
  `type` varchar(50) NOT NULL,
  `unit` varchar(50) NOT NULL,
  `min` float NOT NULL,
  `max` float NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `entities` (
  `id` int NOT NULL AUTO_INCREMENT,
  `guid` varchar(100) NOT NULL,
  `name` varchar(255) DEFAULT NULL,
  `ifc_type` varchar(100) DEFAULT NULL,
  `entity_type` enum('space','element') NOT NULL,
  `model_version_id` int NOT NULL,
  `parent_id` int DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_guid_version` (`guid`,`model_version_id`),
  KEY `parent_id` (`parent_id`),
  KEY `guid` (`guid`),
  KEY `model_version_id` (`model_version_id`),
  CONSTRAINT `entities_ibfk_1` FOREIGN KEY (`model_version_id`) REFERENCES `model_versions` (`id`),
  CONSTRAINT `entities_ibfk_2` FOREIGN KEY (`parent_id`) REFERENCES `entities` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=40 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `linked_models` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(200) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `model_versions` (
  `id` int NOT NULL AUTO_INCREMENT,
  `model_id` int NOT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `description` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `model_id` (`model_id`),
  CONSTRAINT `model_versions_ibfk_1` FOREIGN KEY (`model_id`) REFERENCES `models` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=8 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `models` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(200) DEFAULT NULL,
  `linked_parent_id` int DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `linked_parent_idx` (`linked_parent_id`),
  CONSTRAINT `fk_m_linked_parent` FOREIGN KEY (`linked_parent_id`) REFERENCES `linked_models` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `res_reservations` (
  `id` int NOT NULL AUTO_INCREMENT,
  `asset_id` int NOT NULL,
  `actor_id` varchar(100) NOT NULL,
  `start_time` datetime NOT NULL,
  `end_time` datetime NOT NULL,
  `status` enum('pending','approved','rejected','cancelled','in_use','no_show','completed') DEFAULT 'pending',
  `requested_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `approved_at` datetime DEFAULT NULL,
  `approved_by` varchar(100) DEFAULT NULL,
  `checkin_time` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `asset_id` (`asset_id`),
  KEY `actor_id` (`actor_id`),
  KEY `status` (`status`),
  KEY `start_time` (`start_time`),
  KEY `end_time` (`end_time`),
  KEY `idx_reservations_asset_time` (`asset_id`,`start_time`,`end_time`,`status`),
  CONSTRAINT `res_reservations_ibfk_1` FOREIGN KEY (`asset_id`) REFERENCES `assets` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=17 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `sensors` (
  `id` int NOT NULL AUTO_INCREMENT,
  `guid` varchar(100) DEFAULT NULL,
  `room_id` varchar(100) DEFAULT NULL,
  `model_id` int NOT NULL,
  `name` varchar(500) DEFAULT NULL,
  `x` float DEFAULT NULL,
  `y` float DEFAULT NULL,
  `z` float DEFAULT NULL,
  `status` varchar(50) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `fk_s_model_id` (`model_id`),
  CONSTRAINT `fk_s_model_id` FOREIGN KEY (`model_id`) REFERENCES `models` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `sensors_channels` (
  `sensor_id` int NOT NULL,
  `channel_id` varchar(50) NOT NULL,
  KEY `sensor_id_idx` (`sensor_id`),
  KEY `channel_id_idx` (`channel_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `sensors_data` (
  `sensor_id` int DEFAULT NULL,
  `timestamp` datetime DEFAULT NULL,
  `temperature` float DEFAULT NULL,
  `humidity` float DEFAULT NULL,
  `pressure` float DEFAULT NULL,
  `air_quality` float DEFAULT NULL,
  `decibel_meter` float DEFAULT NULL,
  `occupant` int DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

