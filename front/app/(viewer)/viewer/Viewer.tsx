"use client";

import * as OBC from "@thatopen/components";
import * as FRAGS from "@thatopen/fragments";   
import * as THREE from "three";
// import { Manager } from "@thatopen/ui"
import { useEffect, useState, useRef, use } from "react";
import { Button, Progress } from "@heroui/react";
import { SensorModal } from "./SensorModal";
import { FragmentsModel } from "@thatopen/fragments";

import type { Sensor, SensorDatedValue, Channel } from "@/types/sensor";

const components = new OBC.Components();
const fragments = components.get(OBC.FragmentsManager);
const worlds = components.get(OBC.Worlds);
const world = worlds.create<
    OBC.ShadowedScene,
    OBC.OrthoPerspectiveCamera,
    OBC.SimpleRenderer
>();
let model: FragmentsModel;

const sensors = new Map<string, Sensor>();
const sensorsDatedValues = new Map<string, Map<string, SensorDatedValue>>();

export function Viewer() {
    /* -------------------------------------
                VARIABLES
    ------------------------------------- */
    /* Engine web IFC variables */
    const container = useRef<HTMLDivElement>(null);
    const [worldInitialized, setWorldInitialized] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [loadingProgress, setLoadingProgress] = useState(0);
    const [fragmentsModelIds, setFragmentsModelIds] = useState([]);

    /* React variables */
    const [sensor, setSensor] = useState<Sensor | null>(null);
    const [linkedModels, setLinkedModels] = useState([]);
    const [childModels, setChildModels] = useState<string[]>([]);

    /* -------------------------------------
                FUNCTIONS
    ------------------------------------- */
    const resizeWorld = () => {
        world.renderer?.resize();
        world.camera.updateAspect();
    }

    function initWorld() {
        if (worldInitialized) return;

        world.scene = new OBC.ShadowedScene(components);

        world.renderer = new OBC.SimpleRenderer(components, container.current);
        world.renderer.three.shadowMap.enabled = true;
        world.renderer.three.shadowMap.type = THREE.PCFSoftShadowMap;

        world.camera = new OBC.OrthoPerspectiveCamera(components);
        world.camera.threePersp.near = 0.01;
        world.camera.threePersp.updateProjectionMatrix();
        world.camera.projection.set("Perspective");
        world.camera.controls.restThreshold = 0.05;

        const worldGrid = components.get(OBC.Grids).create(world);
        worldGrid.material.uniforms.uColor.value = new THREE.Color(0x494b50);
        worldGrid.material.uniforms.uSize1.value = 2;
        worldGrid.material.uniforms.uSize2.value = 8;

        world.scene.setup({
            shadows: {
                cascade: 1,
                resolution: 1024
            }
        });
        world.scene.distanceRenderer.excludedObjects.add(worldGrid.three);

        world.scene.three.background = new THREE.Color(0xfafafa);

        container.current.addEventListener("resize", resizeWorld);

        world.dynamicAnchor = false;

        components.init();

        const caster = components.get(OBC.Raycasters).get(world);

        container.current.addEventListener("dblclick", async () => {
            const result = await (caster.castRay());

            if (!result) return;

            const modelIdMap = { [result.fragments.modelId]: new Set([result.localId]) };
            onSelectCallback(modelIdMap);
        });

        setWorldInitialized(true);
    }

    async function clearWorld() {
        if (fragmentsModelIds.length)
            for (const fragId of fragmentsModelIds)
                fragments.core.disposeModel(fragId);

        sensors.clear();
        sensorsDatedValues.clear();
        setSensor(null);
        setFragmentsModelIds([]);
    }

    async function initFragmentsManager() {
        console.log("Initializing fragments manager");

        if (fragments.initialized) return;

        fragments.init("worker.mjs");
        // world.camera.controls.addEventListener("control", () => fragments.update())

        fragments.list.onItemSet.add(({ value: model }) => {
            model.useCamera(world.camera.three);
            world.scene.three.add(model.object);
            fragments.core.update(true);
        });

        world.camera.projection.onChanged.add(() => {
        for (const [_, model] of fragments.list) {
            model.useCamera(world.camera.three);
        }
        });

        world.camera.controls.addEventListener("rest", () => {
            fragments.core.update(true);
        });

        console.log("Fragments manager initialized");
    }

    async function isolateSpaces() {
        const hider = components.get(OBC.Hider);

        const modelIdMap = {};

        const categoriesRegex = new RegExp("^IFCSPACE$");

        for (const [_, model] of fragments.list) {
            const localIds = Object.values(await model.getItemsOfCategories([categoriesRegex])).flat()
            modelIdMap[model.modelId] = new Set(localIds);
            console.log(model)
        }

        console.log(modelIdMap);

        await hider.isolate(modelIdMap);
    }

    const fetchLinkedModelsList = async () => {
        const res = await fetch('/api/model/linked');
        const data = await res.json();

        console.log("Linked models:", data);

        setLinkedModels(data);
    }

    const loadLinkedModel = async () => {
        if (!childModels?.length || !container.current) return;

        setIsLoading(true);
        setLoadingProgress(0);

        console.log("Loading linked model", childModels);

        if (!worldInitialized) {
            console.log("World not initialized");
            initWorld();
        }

        if (fragments === null) {
            console.log("Fragments manager not initialized");
            setIsLoading(false);
            return;
        }

        if (!fragments.initialized)
            await initFragmentsManager();

        if (fragmentsModelIds.length) {
            clearWorld();
        }

        const ifcLoader = components.get(OBC.IfcLoader);
        await ifcLoader.setup({
            autoSetWasm: false,
            wasm: { absolute: true, path: "" },
        });

        for (const childModel of childModels) {
            const res = await fetch(`/api/model/download/${childModel.id}`);
            const blob = await res.blob();
            const arrayBuffer = new Uint8Array(await blob.arrayBuffer());

            model = await ifcLoader.load(arrayBuffer, false, childModel.name, {
                processData: {
                    progressCallback: (progress) => {
                        console.log(progress);
                        setLoadingProgress(progress * 100 / childModels.length);
                    }
                }
            });

            // /* Query sensors in the model */
            // const finders = components.get(OBC.ItemsFinder);
            // // const sensorsLocalId = await finders.getItems([{ categories: [/IFCDISTRIBUTIONCONTROLELEMENT/], relation: { name: "Contained in space", query: { } } }]);
            // const sensorsLocalId = await finders.getItems([{ categories: [/IFCDISTRIBUTIONCONTROLELEMENT/] }]);
            // // await model.getItem()
            // console.log(`Sensors found: `, sensorsLocalId);

            // const sensorsMetadata = await model.getItemsData(sensorsLocalId["example"]?.values().toArray(), {
            //     attributesDefault: false,
            //     attributes: ["GlobalId", "Name", "ObjectType", "PredefinedType", "Tag", "Description", "Mark", "Comments", "ContainedInStructure"],
            //     relations: {
            //         IsDefinedBy: { attributes: true, relations: true },
            //         DefinesOccurence: { attributes: false, relations: false }
            //     }
            // });

            // console.log("Sensors metadata:", sensorsMetadata);

            // console.log(await model.getItemsOfCategories([/SENSORS/]))

            // const sensors_query = finders.create("Find sensors", [
            //     { categories: [/SENSORS/] }
            // ]);
            // const sensors_result = await sensors_query.test();
            // console.log("Sensors found:", sensors_result);

            model.tiles.onItemSet.add(({ value: mesh }) => {
                if ("isMesh" in mesh) {
                    const mat = mesh.material as THREE.MeshStandardMaterial[];
                    if (mat[0].opacity === 1) {
                        mesh.castShadow = true;
                        mesh.receiveShadow = true;
                    }
                }
            });

            console.log("Fragments:",fragments);

            setFragmentsModelIds([...fragmentsModelIds, model.modelId]);
        }

        /* Center camera after the model is loaded */
        console.log("BBox", await fragments.getBBoxes(fragments.list.values().map(m => m.modelId).toArray()));

        const bboxCenter = model._bbox.getCenter(new THREE.Vector3());
        world.camera.controls.setLookAt(bboxCenter.x + 25, bboxCenter.y + 25, bboxCenter.z + 25, bboxCenter.x, bboxCenter.y, bboxCenter.z, true);

        for (const child of model.object.children) {
            child.castShadow = true;
            child.receiveShadow = true;
        }

        await fetchSensors();

        setIsLoading(false);

        console.log("World:", world);
    }

    const fetchSensors = async () => {
        const fetchedSensors = [];

        for (const childModel of childModels) {
            const res = await fetch(`http://localhost:3001/api/sensor/model/${childModel.id}`);
            const data = await res.json();

            if (data.ok && data.data)
                fetchedSensors.push(...data.data);
        }

        const sensorsLocalIds = await model.getLocalIdsByGuids(fetchedSensors.map((s: Partial<Sensor>) => s.guid));
        const spaceLocalIds = await model.getLocalIdsByGuids(fetchedSensors.map((s: Partial<Sensor>) => s.room_id));

        for (let i = 0; i < fetchedSensors.length; i++) {
            const s = fetchedSensors[i] as Partial<Sensor>;

            s.localId = sensorsLocalIds[i];
            s.spaceLocalId = spaceLocalIds[i];

            sensors.set(s.id, s);
        }

        console.log("Sensors with local IDs:", sensors);

        fetchSensorsValues();
        spatialStructure();
    }

    async function fetchSensorsValues(sensorId?: string, binSize?: number, startTime?: string, endTime?: string) {
        if (!childModels?.length) return;

        binSize = 10000;

        for (const childModel of childModels) {
            const res = await fetch(`http://localhost:3001/api/sensor/data?modelId=${childModel.id}${sensorId ? `&sensorId=${sensorId}` : ''}${binSize ? `&binSize=${binSize}` : ''}${startTime ? `&startTime=${startTime}` : ''}${endTime ? `&endTime=${endTime}` : ''}`);
            const data = await res.json();

            if (data.ok && data.data) {
                console.log(data.data);

                data.data.forEach((value: SensorDatedValue) => {
                    if (!sensorsDatedValues.has(value.sensor_id)) {
                        sensorsDatedValues.set(value.sensor_id, new Map());
                    }

                    sensorsDatedValues.get(value.sensor_id).set(value.timestamp, value);
                });
            }
        }

        console.log("Fetched sensor values:", sensorsDatedValues);
    }

    async function onSelectCallback(modelIdMap: OBC.ModelIdMap) {
        const modelId = Object.keys(modelIdMap)[0];

        if (modelId && fragments.list.get(modelId)) {
            const model = fragments.list.get(modelId)!;
            const [data] = await model.getItemsData([...modelIdMap[modelId]]);
            const attributes = data;
            console.log("Selected model attributes:", attributes);

            console.log("model items", model.getItem([...modelIdMap[modelId]][0]));
            console.log("model geometry", await model.getItemsGeometry([...modelIdMap[modelId]]));
        }

        await fragments.core.update(true);
    }

    async function selectSensorCurrentValue(sensorId: string, timestamp: number, channel: Channel) {
        console.log(sensorId, timestamp, channel, sensors);
        console.log(sensors.get(sensorId), sensorsDatedValues.get(timestamp)?.[sensorId]);

        const sensor = sensors.get(sensorId);
        if (!sensor) return;

        const sensorValue = sensorsDatedValues.get(timestamp)?.[sensorId];
        if (!sensorValue) return;

        /* Check current channel, normalize value and compute color */

        colorSpace(sensor.spaceLocalId, new THREE.Color("red"));
    }

    async function colorSpace(spaceLocalId: number, color: THREE.Color) {
        console.log(spaceLocalId, color, model);
        if (!model) return;

        const space = model.getItem(spaceLocalId);
        console.log("Space:", space);
        if (!space) return;

        const spaceLocalId2 = await space.getLocalId();
        if (!spaceLocalId2) return;

        model.highlight([spaceLocalId], {color: color, opacity: 0.5, transparent: true, renderedFaces: FRAGS.RenderedFaces.ONE});

        await fragments.core.update(true);

        // console.log(world.scene.three.getObjectById(spaceLocalId2));
    }

    async function spatialStructure() {
        const structure = await model.getSpatialStructure();

        console.log("Spatial structure:", structure);

        const tree = await getModelTree(model, structure);

        console.log("Model tree:", tree);
    }

    const getModelTree = async (
        model: FRAGS.FragmentsModel,
        structure,
        hierarchy: string = '/'
    ) => {
        const { localId, category, children } = structure;

        if (localId !== null)
            hierarchy = hierarchy + localId + '/';

        if (category && children) {
            const row = {
                data: {
                    Name: category,
                    modelId: model.modelId,
                    children: JSON.stringify(children.map(item => item.localId)),
                    hierarchy
                }
            }

            for (const child of children) {
                const childRow = await getModelTree(model, child, hierarchy);

                if (!childRow) continue;
                if (!row.children) row.children = [];
                    row.children.push(childRow);
            }

            return row;
        }

        if (localId !== null) {
            const item = model.getItem(localId);
            const attrs = await item.getAttributes();

            if (!attrs) return null;

            const row = {
                data: {
                    Name: String(attrs.getValue("Name")),
                    modelId: model.modelId,
                    localId,
                    hierarchy
                },
            };

            for (const child of children ?? []) {
                const childRow = await getModelTree(model, child, hierarchy);
                
                if (!childRow) continue;

                if (!row.children) row.children = [];
                    row.children.push(childRow);
            }

            return row;
        }

        return null;

        /*
        const arr = []

        const getChildsId = (i) => {
            i?.children?.forEach((c) => {
                arr.push(c?.localId)
                getChildsId(c)
            })
        }

        arr.push(getChildsId(temp1))

        arr
        */
    };

    async function sleep(ms) {
        return new Promise((res) => {
            setTimeout(res, ms);
        });
    }

    async function random() {
        const sens = sensors.keys().toArray();

        const colors = [
            new THREE.Color(255, 0, 0),
            new THREE.Color(0, 255, 0),
            new THREE.Color(0, 0, 255),
            new THREE.Color(255, 255, 0),
            new THREE.Color(255, 165, 0),
            new THREE.Color(128, 0, 128),
            new THREE.Color(0, 255, 255),
            new THREE.Color(255, 192, 203)
        ];

        for (let i = 0; i < 200; i++) {
            await colorSpace(sensors.get(sens[i%sens.length])?.spaceLocalId, (colors[Math.floor(Math.random() * colors.length)]));
            await sleep(500);
        }
    }

    /* -------------------------------------
                HOOKS
    ------------------------------------- */
    useEffect(() => {
        initWorld();
        fetchLinkedModelsList();
    }, []);

    useEffect(() => {
        loadLinkedModel();
    }, [childModels]);

    return (
        <>
            <div style={{ width: "20vw", height: "80vh", display: "flex", flexDirection: "column", position: "absolute", zIndex: 1, backgroundColor: "white" }}>
                <div className="flex flex-col items-start">
                    <h2 className="font-bold mb-1">Available models:</h2>
                    {
                        linkedModels.map((model: any) => (
                            <Button onPress={() => setChildModels(model.childModels)} key={model.id}>{model.name}</Button>
                        ))
                    }
                </div>
                {
                    isLoading && (
                        <Progress value={loadingProgress} showValueLabel={true} style={{ width: "100%" }} />
                    )
                }
                {
                    (!isLoading && sensors?.size > 0) && (
                        <>
                        <h2 className="font-bold mb-1">Sensors in model:</h2>
                        {
                            sensors.values().toArray().map((sensor: Sensor) => (
                                <div key={sensor.id}>
                                    <Button className="font-bold" onPress={() => setSensor(sensor)}>{sensor.name}</Button>
                                    <p>{sensor.id}</p>
                                    <p>{sensor.localId}</p>
                                    <p>{sensor.spaceLocalId}</p>
                                </div>
                            ))
                        }
                        </>
                    )
                }
                {
                    (!isLoading && model) && (
                        <Button onPress={() => random()}>Color spaces</Button>
                    )
                }
                {
                    (!isLoading && model) && (
                        <Button onPress={() => isolateSpaces()}>Isolate spaces</Button>
                    )
                }
            </div>
            <div ref={container} style={{ "width": "100vw", height: "100vh" }} />
            <SensorModal sensor={sensor} values={sensorsDatedValues.get(sensor?.id) || null}/>
        </>
    );
};