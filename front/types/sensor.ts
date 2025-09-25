export enum Channel {
    temp = "Temperature",
    decibel = "Decibel",
    humidity = "Humidity"
}

export type Sensor = {
    id: string,
    name: string,
    channels: Channel[],
    localId: number,
    spaceLocalId: number,
    modelId: string,
    currentValues: { [channel: Channel]: number }
}

export type SensorDatedValue = {
    sensor_id: string,
    timestamp: number,
    temperature: number,
    pressure: number,
    humidity: number,
    air_quality: number,
    decibel: number
}