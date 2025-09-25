export enum SensorChannelEnum {
    temp = 'Temperature',
    humidity = 'Humidity',
    pressure = 'Pressure',
    airQuality = 'AirQuality',
    decibel = 'Decibel'
}

export type Sensor = {
    id: string,
    guid: string,       // Sensor's guid in the IFC file
    name: string,
    room_id: string,    // Guid of the space the sensor is located in
    x: number,
    y: number,
    z: number,
    status: string,
    channels: [SensorChannelEnum],
    model_id: string
}

export type SensorData = {
    id: string,
    room: string,
    temperature?: number,
    humidity?: number,
    pressure?: number,
    airQuality?: number,
    decibel?: number,
    timestamp: number
}

export type SensorChannel = {
    id: string,
    name: string,
    description: string,
    type: string,
    unit: string,
    min: number,
    max: number
}