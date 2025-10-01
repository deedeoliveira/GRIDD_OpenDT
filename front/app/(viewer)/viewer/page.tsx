"use client";

import { useEffect, useState } from "react";
import { Viewer } from "./Viewer";
import { SensorModal } from "./SensorModal";
import {
	Accordion,
	AccordionItem,
	Button,
	CircularProgress,
	DateInput
} from "@heroui/react";
import { useSensorStore } from "@/stores/sensorStore";

import type { LinkedModel, Model } from "@/types/model";

export default function ViewerPage({}: {
}) {
    /* -------------------------------------
                VARIABLES
    ------------------------------------- */
	// Model
	const [linkedModel, setLinkedModel] = useState<LinkedModel[]>([]);
	const [selectedLinkedModel, setSelectedLinkedModel] = useState<LinkedModel | null>(null);
	// Sensor
	const sensors = useSensorStore((state) => state.sensors);
	const sensorsValues = useSensorStore((state) => state.values);
	const selectedSensor = useSensorStore((state) => state.selectedSensor);
	const selectedSensorValues = useSensorStore((state) => state.selectedSensorValues);
	// Misc
	const [isLoading, setIsLoading] = useState(false);

	const [date, setDate] = useState<Date | null>(null);

    /* -------------------------------------
                STORES
    ------------------------------------- */
	const {
		fetchSensors: sensorStoreFetchSensors,
		clear: sensorStoreClear,
		fetchValues: sensorStoreFetchValues,
		selectSensor: sensorStoreSetSelectedSensor,
		setCurrentBinnedTimestamp: sensorStoreSetCurrentBinnedTimestamp,
		currentBinnedTimestamp
	} = useSensorStore();

    /* -------------------------------------
                FUNCTIONS
    ------------------------------------- */
	async function fetchLinkedModelList() {
		const res = await fetch(`/api/model/linked`);

		if (!res.ok) return;

		const data = await res.json();

		setLinkedModel(data);
	}

	async function fetchSensors() {
		if (selectedLinkedModel) {
			const childModelIds = selectedLinkedModel.childModels.map((model: Model) => model.id);

        	sensorStoreFetchSensors(childModelIds);
		} else {
			sensorStoreClear();

			return;
		}
	}

	async function fetchSensorsValues() {
		if (selectedLinkedModel) {
			sensorStoreClear();
			
			const childModelIds = selectedLinkedModel.childModels.map((model: Model) => model.id);

			for (const modelId of childModelIds) {
				await sensorStoreFetchValues(modelId);
			}
		}
	}

	function onWorldInitialized() {
		setIsLoading(false);
	}

	/* -------------------------------------
                HOOKS
    ------------------------------------- */
	useEffect(() => {
		fetchLinkedModelList();
	}, []);

	useEffect(() => {
		if (!selectedLinkedModel) return;

		setIsLoading(true);
		fetchSensors();
		fetchSensorsValues();
	}, [selectedLinkedModel]);

	useEffect(() => {
		if (!date) return;
		
		sensorStoreSetCurrentBinnedTimestamp(date.toDate());
	}, [date]);

    return (
		<>
			{
				isLoading && (
					<div className="flex w-full h-full justify-center items-center absolute top-0 left-0 z-1 bg-black/30">
						<CircularProgress />
					</div>
				)
			}
			<div className="w-80 h-fit flex flex-col items-start absolute top-4 left-4 z-10 rounded shadow bg-white">
				<Accordion>
					<AccordionItem key="1" title="Models">{
						linkedModel.map((model) => (
							<Button onPress={() => setSelectedLinkedModel(model)} key={model.id} variant={selectedLinkedModel?.id === model.id ? "solid" : "light"} className="m-1">
								{model.name}
							</Button>
						))
					}</AccordionItem>
					<AccordionItem key="2" title="Sensors">{
						sensors.size && sensors.values().toArray().map((sensor) => (
							<Button onPress={() => sensorStoreSetSelectedSensor(sensor)} key={sensor.id} variant="light" className="m-1">
								{sensor.name}
							</Button>
						))
					}</AccordionItem>
				</Accordion>
				<div className="p-2">Current binned timestamp: {currentBinnedTimestamp ? new Date(currentBinnedTimestamp).toLocaleString() : "None"}</div>
				<DateInput granularity="second" label="Date and time" value={date} onChange={setDate} />
			</div>
			<Viewer selectedModel={selectedLinkedModel} onWorldInitialized={onWorldInitialized} />
			{
				selectedSensor && selectedSensorValues && (
					<SensorModal sensor={selectedSensor} values={selectedSensorValues} />
				)
			}
		</>
    );
}