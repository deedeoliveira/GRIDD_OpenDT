/*
Purpose of this script is to populate the MySQL database with mock data for testing and development purposes.

1. `npm install`
2. `npm run dev`
*/

const mysql = require('mysql2/promise');

const SENSORS_ID = ["2p5zTdAoL4fu1$itMvy02k", "2p5zTdAoL4fu1$itMvy05S", "2p5zTdAoL4fu1$itMvy0UE"];
const CHANNELS_CONFIG = {
    'temperature': {
        'min': 0,
        'max': 100
    },
    'humidity': {
        'min': 0,
        'max': 100
    },
    'pressure': {
        'min': 0,
        'max': 100
    },
    'air_quality': {
        'min': 0,
        'max': 100
    },
    'decibel_meter': {
        'min': 0,
        'max': 100
    },
    'timestamp': {
        'min': Date.now() - 1000 * 60 * 60 * 24 * 90,
        'max': Date.now()
    }
}

function randomValue(channel) {
    const config = CHANNELS_CONFIG[channel];
    if (!config) throw new Error(`Unknown channel: ${channel}`);
    return (Math.random() * (config.max - config.min) + config.min).toFixed(2);
}

async function main() {
    const connection = await mysql.createConnection({
        host: 'localhost',
        port: 3336,
        user: 'root',
        password: 'root',
        database: 'digital_twin'
    });

    connection.config.namedPlaceholders = true;

    for (let i = 0; i < 1_000_000; i++) {
        if (i % 10_000 === 0) {
            console.log(`Processing record ${i}`);
        }

        const sensorId = SENSORS_ID[Math.floor(Math.random() * SENSORS_ID.length)];
        const timestamp = Date.now() - Math.floor(Math.random() * 1000 * 60 * 60 * 24 * 180);

        const randomMultiplier = 1 + Math.random() * 1 - 0.5;

        const data = {
            sensor_id: sensorId,
            timestamp: new Date(timestamp),
            temperature: randomValue('temperature') * randomMultiplier,
            humidity: randomValue('humidity') * randomMultiplier,
            pressure: randomValue('pressure') * randomMultiplier,
            air_quality: randomValue('air_quality') * randomMultiplier,
            decibel_meter: randomValue('decibel_meter') * randomMultiplier,
        };

        const query = `
            INSERT INTO sensors_data (sensor_id, timestamp, temperature, humidity, pressure, air_quality, decibel_meter)
            VALUES (:sensor_id, :timestamp, :temperature, :humidity, :pressure, :air_quality, :decibel_meter)
        `;

        await connection.execute(query, data);
    }

    connection.end();
}

main();