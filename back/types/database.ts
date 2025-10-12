import type { Sensor, SensorData, SensorChannel } from './sensors.js';
import type { Model, LinkedModel } from './models.js';

export interface IDatabase {
    connect(): Promise<void>;
    disconnect(): Promise<void>;
}

export interface ISensorDatabase {
    getSensors(id?: string): Promise<Sensor[] | Sensor | Error>;
    createSensor(data: Partial<Sensor>): Promise<Sensor | Error>;
    updateSensor(id: string, data: Partial<Sensor>): Promise<Sensor | Error>;
    deleteSensor(id: string): Promise<Sensor | Error>;
    getSensorsData(modelId: string, binSize: number, startTime: Date, endTime: Date, sensorId?: string): Promise<SensorData[] | Error>;
    getChannels(): Promise<SensorChannel[] | Error>;
}

export interface IModelDatabase {
    getLinkedModelMetadata(id: string): Promise<LinkedModel | Error>;
    getModelMetadata(id: string): Promise<Model | Error>;
    downloadModel(id: string): Promise<Buffer | Error>;
    uploadModel(name: string, buffer: Buffer, linkedParentId?: string, modelId?: string): Promise<Model | Error>;
    deleteModel(id: string): Promise<boolean | Error>;
    deleteLinkedModel(id: string): Promise<boolean | Error>;
    listModels(): Promise<Partial<Model>[] | Error>;
    listLinkedModels(): Promise<LinkedModel[] | Error>;
}