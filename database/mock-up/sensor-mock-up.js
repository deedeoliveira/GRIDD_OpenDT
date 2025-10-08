/* -----------------------------------
This script reads sensor data from a JSON file and inserts it into a MySQL database.
----------------------------------- */

const mysql = require('mysql2/promise');
const fs = require('fs');
const dotenv = require('dotenv');
dotenv.config();

async function main() {
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME
    });

    connection.config.namedPlaceholders = true;

    const sensors = JSON.parse(fs.readFileSync('sensors.json'));

    const query = `
        INSERT INTO sensors (guid, room_id, model_id, name, x, y, z)
        VALUES (:guid, :room_id, :model_id, :name, :x, :y, :z)
    `;
    
    for (let i = 0; i < sensors.length; i++) {
        connection.execute(query, sensors[i]);
    }

    connection.end();
}

main();