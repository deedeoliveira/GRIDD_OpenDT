import MySQLDatabase from "./mysqlDatabase.ts";
import type { ISensorDatabase } from "../types/database.ts";
import type { Sensor, SensorData, SensorChannel } from "../types/sensors.ts";

class SensorDatabase implements ISensorDatabase {
    private db: MySQLDatabase;
    private static cachedSensors: Map<string, Sensor> = new Map();
    private static cachedTimestamp: Date | null = null;

    constructor() {
        this.db = new MySQLDatabase();
        this.db.connect();
    }

    /**
     * Check if we can use cached values
     */
    #canUseCachedSensors() {
        if (SensorDatabase.cachedTimestamp) {
            const age = new Date() - SensorDatabase.cachedTimestamp;
            // If cached data is less than 10 minutes old, use it
            return age < 10 * 60 * 1000;
        }
        return false;
    }

    /**
     * Get sensors definitions from the database
     * @param id Optional sensor ID to fetch a specific sensor
     * @returns Array of sensors or a single sensor if ID is provided
     */
    async getSensors(id?: string): Promise<Sensor[] | Sensor | Error> {
        await this.db.checkConnection();

        if (this.#canUseCachedSensors() && (id === null || SensorDatabase.cachedSensors.has(id) )) {
            if (id) return SensorDatabase.cachedSensors.get(id) as Sensor;
            else return Array.from(SensorDatabase.cachedSensors.values());
        }

        const [rows] = await this.db.connection.query(`
            SELECT	sensors.id,
                    sensors.guid,
                    sensors.room_id,
                    sensors.x,
                    sensors.y,
                    sensors.z,
                    sensors.status,
                    sensors.name,
                    GROUP_CONCAT(sensors_channels.channel_id) AS 'channels',
                    sensors.model_id
            FROM sensors
            LEFT JOIN sensors_channels
            ON sensors_channels.sensor_id = sensors.id
            ${id ? `WHERE sensors.id = :sensorId` : ''}
            GROUP BY sensors.id
        `, { sensorId: id });

        if (!rows || rows.length === 0) {
            return [];
        }

        if (rows.length > 0)
            rows.forEach((sensor) => {
                sensor.channels = sensor.channels?.split(',')

                SensorDatabase.cachedSensors.set(sensor.id.toString(), sensor);
            });

        if (id === null) {
            SensorDatabase.cachedTimestamp = new Date();
        }

        return id ? SensorDatabase.cachedSensors.get(id) : Array.from(SensorDatabase.cachedSensors.values());
    }

    /**
     * Create a new sensor in the database
     * @param data Sensor data to be created
     * @returns The created sensor
     * @throws Error if the operation fails
     */
    async createSensor(data: Partial<Sensor>): Promise<Sensor | Error> {
        await this.db.checkConnection();

        /* Start a transatction in case one of the queries fail */
        await this.db.connection.beginTransaction();

        try {
            const [result] = await this.db.connection.execute(`
                INSERT INTO sensors (guid, name, x, y, z, status, room_id, model_id)
                VALUES (:guid, :name, :x, :y, :z, :status, :room_id, :model_id)
            `, {
                guid: data.guid ?? null,
                name: data.name ?? null,
                x: data.x ?? null,
                y: data.y ?? null,
                z: data.z ?? null,
                status: data.status ?? null,
                room_id: data.room_id ?? null,
                model_id: data.model_id ?? null
            });

            if (!result || result.insertId === 0) throw new Error('Failed to create sensor');

            const id = (result as any).insertId;
            
            if (data.channels && data.channels.length > 0) {
                const channel_insert_command = `
                    INSERT INTO sensors_channels (sensor_id, channel_id)
                    VALUES ${data.channels.map((channelId) => `('${id}', '${channelId}')`).join(', ')}
                `;

                try {
                    await this.db.connection.execute(channel_insert_command);
                } catch (error) {
                    await this.db.connection.rollback();
                    throw error;
                }
            }

            await this.db.connection.commit();
        
            SensorDatabase.cachedSensors.set(id as string, {id, ...data} as Sensor);

            return {id, ...data} as Sensor;
        } catch (error) {
            await this.db.connection.rollback();
            throw error;
        }
    }

    /**
     * Update a sensor in the database
     * @param id ID of the sensor to update
     * @param data Sensor data to update
     * @returns The updated sensor
     * @throws Error if the operation fails
     */
    async updateSensor(id: string, data: Partial<Sensor>): Promise<Sensor | Error> {
        await this.db.checkConnection();

        const existingSensor = await this.getSensors(id) as Sensor;

        if (!existingSensor || (existingSensor instanceof Array && existingSensor.length === 0)) {
            throw new Error(`Sensor with ID ${id} not found`);
        }

        const updatedSensor = { ...existingSensor, ...data };
        
        await this.db.connection.beginTransaction();

        try {
            await this.db.connection.execute(`
                UPDATE sensors
                SET guid = :guid,
                    name = :name,
                    x = :x,
                    y = :y,
                    z = :z,
                    status = :status,
                    room_id = :room_id,
                    model_id = :model_id
                WHERE id = :id
            `, {
                id: id,
                guid: updatedSensor.guid,
                name: updatedSensor.name,
                x: updatedSensor.x,
                y: updatedSensor.y,
                z: updatedSensor.z,
                status: updatedSensor.status,
                room_id: updatedSensor.room_id,
                model_id: updatedSensor.model_id,
                old_id: id
            });

            if (existingSensor.channels.sort().toString() !== (data.channels ?? existingSensor.channels ?? []).sort().toString()) {
                try {
                    await this.db.connection.execute(`
                        DELETE FROM sensors_channels
                        WHERE sensor_id = :sensor_id
                    `, {
                        sensor_id: id
                    });

                    await this.db.connection.execute(`
                        INSERT INTO sensors_channels (sensor_id, channel_id)
                        VALUES ${ (data.channels ?? []).map((channelId) => `(${id}, ${channelId})`).join(', ') }
                    `);
                } catch (error) {
                    await this.db.connection.rollback();
                    throw error;
                }
            }
        } catch (error) {
            await this.db.connection.rollback();
            throw error;
        }

        await this.db.connection.commit();

        SensorDatabase.cachedSensors.set(id as string, updatedSensor as Sensor);

        return updatedSensor as Sensor;
    }

    /**
     * Delete a sensor from the database
     * @param id ID of the sensor to delete
     * @returns The deleted sensor
     * @throws Error if the operation fails
     */
    async deleteSensor(id: string): Promise<Sensor | Error> {
        await this.db.checkConnection();

        const deletedSensor = await this.getSensors(id);

        try {
            await this.db.connection.execute('DELETE FROM sensors WHERE id = :id', { id });
            SensorDatabase.cachedSensors.delete(id);
            
            return deletedSensor as Sensor;
        } catch (error) {
            throw error;
        }
    }

    /**
     * Get sensor data from the database
     * @param modelId ID of the model (optionnal if sensorId is provided)
     * @param sensorId ID of the sensor (optionnal if modelId is provided)
     * @param binSize Size of the time bins (in seconds)
     * @param startTime Start time for the data retrieval
     * @param endTime End time for the data retrieval
     * @returns Array of sensor data
     * @throws Error if the operation fails
     */
    async getSensorsData(modelId: string, binSize: number, startTime: Date, endTime: Date, sensorId: string): Promise<SensorData[] | Error> {
        await this.db.checkConnection();

        const query = `
            SELECT  sensor_id AS id,
                    FROM_UNIXTIME(binned_timestamp) AS timestamp,
                    COALESCE(AVG(temperature), 0.0) AS temperature,
                    COALESCE(AVG(pressure), 0.0) AS pressure,
                    COALESCE(AVG(humidity), 0.0) AS humidity,
                    COALESCE(AVG(air_quality), 0.0) AS air_quality,
                    COALESCE(AVG(decibel_meter), 0.0) AS decibel
            FROM (
                SELECT  sensors_data.sensor_id,
                        sensors_data.temperature,
                        sensors_data.pressure,
                        sensors_data.humidity,
                        sensors_data.air_quality,
                        sensors_data.decibel_meter,
                        FLOOR(UNIX_TIMESTAMP(sensors_data.timestamp) / :binSize) * :binSize AS binned_timestamp
                FROM sensors_data
                LEFT JOIN sensors
                ON sensors.id = sensors_data.sensor_id
                WHERE sensors_data.timestamp BETWEEN :startTime AND :endTime
                ${modelId ? `AND sensors.model_id = :modelId` : ''}
                ${sensorId ? `AND sensors_data.sensor_id = :sensorId` : ''}
            ) AS binned_data
            GROUP BY binned_timestamp, id
            ORDER BY timestamp ASC
        `;

        try {
            const [rows, fields] = await this.db.connection.execute(
                query,
                {
                    modelId,
                    binSize,
                    startTime: (new Date(startTime)).toISOString().slice(0, 19).replace('T', ' '),
                    endTime: (new Date(endTime)).toISOString().slice(0, 19).replace('T', ' '),
                    sensorId
                }
            );

            return rows as SensorData[];
        } catch (error) {
            throw error;
        }
    }

    /**
     * Get a list of available sensor channels
     * @returns List of available sensor channels
     */
    async getChannels(): Promise<SensorChannel[]> {
        const [rows] = await this.db.connection.query('SELECT * FROM channels');
        return rows as SensorChannel[];
    }

    /**
     * Get sensors of a specific model
     * @param modelId ID of the model
     * @returns Array of sensors associated with the model
     * @throws Error if the operation fails
     */
    async getSensorsByModel(modelId: string): Promise<Sensor[] | Error> {
        await this.db.checkConnection();
        
        try {
            const [sensorRow] = await this.db.connection.execute(`
                SELECT sensors.id
                FROM sensors
                WHERE model_id = :modelId
            `, { modelId });

            const sensors: Sensor[] = [];

            for (const sensorId of sensorRow) {
                const sensor = await this.getSensors(sensorId.id.toString());

                if (sensor) sensors.push(sensor);
            }

            return sensors;
        } catch (error) {
            throw error;
        }
    }
}

export default new SensorDatabase();