import dotenv from "dotenv";
dotenv.config();

import mysql from "mysql2/promise";

async function seed() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  const [sensors]: any = await connection.query("SELECT id FROM sensors");

  const now = new Date();
  const rows: any[] = [];

  for (const sensor of sensors) {
    for (let i = 0; i < 24; i++) {
      const timestamp = new Date(now.getTime() - i * 3600 * 1000);

      rows.push([
        sensor.id,
        timestamp,
        20 + Math.random() * 5,        // temperature
        40 + Math.random() * 20,       // humidity
        1000 + Math.random() * 10,     // pressure
        300 + Math.random() * 50,      // air_quality
        30 + Math.random() * 10,       // decibel_meter
        Math.random() > 0.5 ? 1 : 0    // occupant
      ]);
    }
  }

  if (rows.length > 0) {
    await connection.query(
      `INSERT INTO sensors_data 
       (sensor_id, timestamp, temperature, humidity, pressure, air_quality, decibel_meter, occupant)
       VALUES ?`,
      [rows]
    );
  }

  console.log("Mock sensor data inserted successfully.");
  await connection.end();
}

seed().catch(console.error);
