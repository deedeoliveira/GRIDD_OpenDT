# --------------------------------------
# CREATE
# --------------------------------------
CREATE TABLE `linked_models` (
	`id` int NOT NULL AUTO_INCREMENT,
    `name` varchar(200),
    PRIMARY KEY(`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `models` (
	`id` int NOT NULL AUTO_INCREMENT,
    `name` varchar(200),
    `linked_parent_id` int DEFAULT NULL,
    KEY `linked_parent_idx` (`linked_parent_id`),
    CONSTRAINT `fk_m_linked_parent` FOREIGN KEY(`linked_parent_id`) REFERENCES `linked_models` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    PRIMARY KEY(`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

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
  CONSTRAINT `fk_s_model_id` FOREIGN KEY (`model_id`) REFERENCES `models` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

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

CREATE TABLE `sensors_channels` (
  `sensor_id` int NOT NULL,
  `channel_id` varchar(50) NOT NULL,
  KEY `sensor_id_idx` (`sensor_id`),
  KEY `channel_id_idx` (`channel_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

#DROP TABLE `sensors_channels`;

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

# --------------------------------------
# POPULATE
# --------------------------------------
INSERT INTO `channels` (
	`id`,
    `name`,
    `description`,
    `type`,
    `unit`,
    `min`,
    `max`
) VALUES
	("airQuality",	"Air Quality",		"Air quality measurement",			"double",	"AQI",	"-55",	"1100"),
	("decibel",		"Decibel Meter",	"Sound level measurement",			"double",	"dB",	"19",	"110"),
	("humidity",	"Humidity",			"Relative humidity percentage",		"double",	"%",	"97",	"106"),
	("pressure",	"Pressure",			"Pressure measurement",				"double",	"hPa",	"5",	"60"),
	("temp",		"Temperature",		"Temperature in degrees Celsius",	"double",	"°C",	"15",	"30");