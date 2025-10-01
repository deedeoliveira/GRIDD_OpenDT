export enum Channel {
    temp = "Temperature",
    decibel = "Decibel",
    humidity = "Humidity"
}

export type Sensor = {
    id: string,
    name: string,
    channels: Channel[],
    room_id: string
    modelId: string,
    currentValues: { [channel: Channel]: number }
}

export type SensorBinnedValue = {
    id: string,
    timestamp: number,
    temperature: number,
    pressure: number,
    humidity: number,
    air_quality: number,
    decibel: number
}