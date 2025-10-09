/**
 * Sensor store
 * This store is used to manage sensors and their values. It also manages the current selected sensor, so that components can reactively update when the selected sensor changes.
 * Values from all sensors are stored in a single array, and two maps are used to index them by sensor ID and timestamp for efficient retrieval.
 */

import { create } from "zustand";

import type { Sensor, SensorBinnedValue } from "@/types/sensor";

interface SensorState {
    sensors: Map<string, Sensor>;
    values: SensorBinnedValue[];
    selectedSensor: Sensor | null;
    selectedSensorValues: SensorBinnedValue[] | null;
    currentBinnedTimestamp: string | null;
}

interface SensorActions {
    selectSensor: (sensor: Sensor | null) => void;
    fetchSensors: (modelsId: string[]) => Promise<void>;
    addSensor: (sensor: Sensor) => void;
    setSensorLocalInfo: (sensorId: string, modelId: string, localInfo: Object) => void;
    clear: () => void;
    fetchValues: (modelId: string, binSize?: number, start?: string, end?: string) => Promise<void>;
    setCurrentBinnedTimestamp?: (timestamp: string | null) => void;
    getBinnedValues: (timestamp: string) => Map<string, SensorBinnedValue>;
}

export const useSensorStore = create<SensorState & SensorActions>()((set, get) => ({
    /* ----------------------
        States
    ----------------------- */
    sensors: new Map<string, Sensor>(),
    values: new Array<SensorBinnedValue>(),
    selectedSensor: null,
    selectedSensorValues: null,
    currentBinnedTimestamp: null,
    _sensorsValuesMap: new Map<string, Map<string, SensorBinnedValue>>(),
    _timestampValuesMap: new Map<string, Map<string, SensorBinnedValue>>(),

    /* ----------------------
        Actions
    ----------------------- */
    selectSensor: (sensor: Sensor | null) => {
        set((state) => {
            return {
                selectedSensor: sensor,
                selectedSensorValues: sensor?.id ? Array.from(state._sensorsValuesMap.get(sensor.id.toString()).values()).map((index) => state.values[index]) : null
            };
        })
    },
    fetchSensors: async (modelsId: string[]) => {
        const sensors: Sensor[] = [];
        const promises = [];

        for (const modelId of modelsId) {
            promises.push(new Promise<void>(async (resolve) => {
                const res = await fetch(`/api/sensor/model/${modelId}`);

                if (res.ok) {
                    sensors.push(...(await res.json()));
                }

                resolve();
            }));
        }

        await Promise.all(promises);

        set({ sensors: new Map(sensors.map((sensor) => [sensor.id.toString(), sensor])) });
    },
    addSensor: (sensor: Sensor) => {
        set((state) => {
            const newSensors = new Map(state.sensors);
            newSensors.set(sensor.id.toString(), sensor);

            return { sensors: newSensors };
        })
    },
    setSensorLocalInfo: (sensorId: string, modelId: string, localInfo: Object) => {
        set((state) => {
            const newSensors = new Map(state.sensors);
            const sensor = newSensors.get(sensorId);

            // if (sensor) {
            //     sensor.localId = localInfo.localId;
            //     sensor.spaceLocalId = localInfo.spaceLocalId;
            //     newSensors.set(sensorId, sensor);
            // }

            return { sensors: newSensors };
        });
    },
    clear: () => set({
        sensors: new Map<string, Sensor>(),
        values: new Array<SensorBinnedValue>(),
        selectedSensor: null,
        selectedSensorValues: null
    }),
    fetchValues: async (modelId: string, binSize?: number, start?: string, end?: string) => {
        const response = await fetch(`/api/sensor/data/?modelId=${modelId}${binSize ? `binSize=${binSize}&` : ''}${start ? `start=${start}&` : ''}${end ? `end=${end}` : ''}`);
        const data = await response.json();

        const sensorsValuesMap = get()._sensorsValuesMap;
        const timestampValuesMap = get()._timestampValuesMap;
        const values = get().values;

        data.forEach((value: SensorBinnedValue) => {
            if (!sensorsValuesMap.has(value.id.toString())) {
                sensorsValuesMap.set(value.id.toString(), new Map<string, SensorBinnedValue>());
            }

            if (!timestampValuesMap.has(value.timestamp)) {
                timestampValuesMap.set(value.timestamp, new Map<string, SensorBinnedValue>());
            }

            const index = values.push(value) - 1;

            sensorsValuesMap.get(value.id.toString()).set(value.timestamp, index);
            timestampValuesMap.get(value.timestamp).set(value.id.toString(), index);
        });

        set({ values });
    },
    setCurrentBinnedTimestamp: (timestamp: string | null) => {
        set({ currentBinnedTimestamp: timestamp });
    },
    getBinnedValues: (timestamp: string) => {
        const binnedValues: Map<string, SensorBinnedValue> = new Map();

        const timestampValuesMap = get()._timestampValuesMap;
        const values = get().values;

        timestampValuesMap.get(timestamp)?.forEach((index, sensorId) => {
            const binnedValue = values[index];

            if (binnedValue) {
                binnedValues.set(sensorId, binnedValue);
            }
        });
        
        return binnedValues;
    }
}));