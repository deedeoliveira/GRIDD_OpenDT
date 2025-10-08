"use client";

import * as OBC from "@thatopen/components";
import * as FRAGS from "@thatopen/fragments";
import * as THREE from "three";
import { createRef, useEffect, useState, useRef } from "react";
import { FragmentsModel } from "@thatopen/fragments";
import { useSensorStore } from "@/stores/sensorStore";
import { SensorBinnedValue } from "@/types/sensor";
import { Checkbox } from "@heroui/react";

const components = new OBC.Components();
const fragments = components.get(OBC.FragmentsManager);
const worlds = components.get(OBC.Worlds);
const world = worlds.create<
    OBC.ShadowedScene,
    OBC.OrthoPerspectiveCamera,
    OBC.SimpleRenderer
>();
let model: FragmentsModel;

/*
spaces: A map representing spaces in the model.
The keys are space global IDs (from IFC) and the values are THREE.Mesh objects representing the spaces in the 3D scene.
*/
const spaces = new Map<string, object>();

export function Viewer(props: {}) {
    const {
        selectedModel,
        onWorldInitialized
    } = props;

    /* -------------------------------------
                VARIABLES
    ------------------------------------- */
    /* Engine web IFC variables */
    const container = useRef<HTMLDivElement>(null);
    const [worldInitialized, setWorldInitialized] = useState(false);
    const [fragmentsModelIds, setFragmentsModelIds] = useState([]);
    const sensors = useSensorStore((state) => state.sensors);
    const currentBinnedTimestamp = useSensorStore((state) => state.currentBinnedTimestamp);
    const [currentChannel, setCurrentChannel] = useState<string | null>("temperature");
    const [spacesIsolated, setSpacesIsolated] = useState(false);
    const [modelTrees, setModelTrees] = useState<object[]>([]);

    /* -------------------------------------
                STORES
    ------------------------------------- */
	const {
		getBinnedValues
	} = useSensorStore();

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
            for (const fragId of fragmentsModelIds) {
                await fragments.core.disposeModel(fragId);
            }

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

    async function toggleSpacesIsolation() {
        const hider = components.get(OBC.Hider);

        const modelIdMap = {};

        const categoriesRegex = new RegExp("^IFCSPACE$");

        for (const [_, model] of fragments.list) {
            const localIds = Object.values(await model.getItemsOfCategories([categoriesRegex])).flat()
            modelIdMap[model.modelId] = new Set(localIds);
            console.log(model)
        }

        console.log(modelIdMap);

        if (spacesIsolated)
            await hider.isolate(modelIdMap);
        else
            await hider.set(true, modelIdMap);
    }

    const loadLinkedModel = async () => {
        if (!selectedModel.childModels?.length || !container.current) return;

        if (!worldInitialized) {
            console.log("World not initialized");
            initWorld();
        }

        if (fragments === null) {
            console.log("Fragments manager not initialized");
            onWorldInitialized?.();
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

        const modelIds = [];

        for (const childModel of selectedModel.childModels) {
            const res = await fetch(`/api/model/download/${childModel.id}`);
            const blob = await res.blob();
            const arrayBuffer = new Uint8Array(await blob.arrayBuffer());

            model = await ifcLoader.load(arrayBuffer, false, childModel.name, {
                processData: {
                    progressCallback: (progress) => {
                        console.log(progress);
                        // setLoadingProgress(progress * 100 / childModels.length);
                    }
                }
            });

            model.tiles.onItemSet.add(({ value: mesh }) => {
                if ("isMesh" in mesh) {
                    const mat = mesh.material as THREE.MeshStandardMaterial[];
                    if (mat[0].opacity === 1) {
                        mesh.castShadow = true;
                        mesh.receiveShadow = true;
                    }
                }
            });

            modelIds.push(model.modelId);
        }

        await retrieveSpaces();
        setFragmentsModelIds(modelIds);

        const bboxCenter = model._bbox.getCenter(new THREE.Vector3());
        world.camera.controls.setLookAt(bboxCenter.x + 25, bboxCenter.y + 25, bboxCenter.z + 25, bboxCenter.x, bboxCenter.y, bboxCenter.z, true);

        for (const child of model.object.children) {
            child.castShadow = true;
            child.receiveShadow = true;
        }

        onWorldInitialized?.();

        console.log("World:", world);
        console.log("FragmentsManager:", fragments);

        getSpatialStructure(fragments.list);
    }

    /*
    Find and store all space in the model.
    Retrieve the local ID and the geometry of each space so it is possible to create a mesh from it later.
    */
    async function retrieveSpaces() {
        if (!model) return;

        // Clear previous spaces
        spaces.clear();

        // Get all spaces from the model
        const finder = components.get(OBC.ItemsFinder);
        const spacesItems = await finder.getItems([
            {
                categories: [/^IFCSPACE$/],
            }
        ]);

        // Function to create a Three.js mesh from geometry data
        const createMesh = (data: FRAGS.MeshData) => {
            const meshMaterial = new THREE.MeshLambertMaterial({ color: "white" });
            const { positions, indices, normals, transform } = data;
            if (!(positions && indices && normals)) return null;
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
            geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
            geometry.setIndex(Array.from(indices));

            const mesh = new THREE.Mesh(geometry, meshMaterial);
            mesh.applyMatrix4(transform);
            return mesh;
        };

        const promises = [];

        // Create a mesh for each space
        for (const [modelId, localIds] of Object.entries(spacesItems)) {
            const model = fragments.list.get(modelId);

            if (!model) continue;

            // Retrieve space item data and geometry
            const spaceItemData = await model.getItemsData([...localIds]);
            const spaceItemGeometry = await model.getItemsGeometry([...localIds]);

            for (const [index, spaceData] of spaceItemData.entries()) {
                // Store space data in the spaces map
                spaces.set(spaceData._guid.value, {
                    id: spaceData._guid.value,
                    modelId,
                    localId: spaceData._localId.value,
                    geometries: spaceItemGeometry[index],
                    meshes: spaceItemGeometry[index]?.map((geom) => createMesh(geom))
                });

                if (spaces.get(spaceData._guid.value).meshes)
                    spaces.get(spaceData._guid.value).meshes.forEach(mesh => world.scene.three.add(mesh));
            }

            promises.push(model.setVisible([...localIds], false));
        }

        await Promise.all(promises);
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

    async function colorSpace(spaceId: string, color: THREE.Color) {
        const space = spaces.get(spaceId)

        if (!space || !space.meshes) return;

        space.meshes.forEach((mesh: THREE.Mesh) => {
            (mesh.material as THREE.MeshLambertMaterial).color = color;
        });
    }

    async function getSpatialStructure(models) {
        if (!models || models.size === 0) return;

        const trees = [];
        const promises = [];

        models.values().toArray().forEach((model) => {
            promises.push(new Promise<void>(async (resolve) => {
            	const structure = await model.getSpatialStructure();
                const tree = await getModelTree(model, structure);

                trees.push({
					localId: tree?.data?.localId,
					data: tree?.data,
					children: tree?.children,
					hidden: false
				});

                resolve();
            }));
        });

        await Promise.all(promises);

        setModelTrees(trees);
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

    /**
     * Function to render the model tree structure as an JSX element.
     */
    function computeModelTree(elem) {
		if (!elem)
			elem = modelTrees[0];

		elem.expanded = true;
		elem.childRef = createRef();
		let childs = undefined;

		if (elem.children && elem.children.length > 0)
			childs = elem.children.map((child) => computeModelTree(child));

        return (
			<div key={elem.data?.localId || Math.random()} className="flex flex-col ml-1 border-l border-gray-300 pl-2">
            	<div className="flex flex-row gap-x-2 hover:cursor-pointer">
					<button onClick={() => {elem.expanded = !elem.expanded; elem.childRef.current.style.display = elem.expanded ? 'block' : 'none';}}>+</button>
					<button onClick={() => {hideElementAndChilds(elem)}}>H</button>
					<div>{elem.data.Name}</div>
				</div>
				<div ref={elem.childRef} style={{ display: elem.expanded ? 'block' : 'none' }}>
					{childs}
				</div>
			</div>
        )
    }

	function hideElementAndChilds(elem) {
		if (!elem) return;

		const modelId = elem.data?.modelId;

		if (!modelId || !fragments.list.get(modelId)) return;

		const modelIdMap = { [modelId]: new Set(getChildsRecursively(elem)) };

		const hider = components.get(OBC.Hider);
		hider.toggle(modelIdMap);
	}

	function getChildsRecursively(elem) {
		if (!elem) return [];

		let arr = [];

		if (elem.children && elem.children.length > 0) {
			elem.children.forEach((child) => {
				arr.push(child.data.localId);
				arr = arr.concat(getChildsRecursively(child));
			});
		}

		return arr.filter((v, i, a) => a.indexOf(v) === i && !!v); // remove duplicates
	}

    /* -------------------------------------
                HOOKS
    ------------------------------------- */
    useEffect(() => {
        initWorld();
    }, []);

    useEffect(() => {
        if (selectedModel) loadLinkedModel();
    }, [selectedModel]);

    useEffect(() => {
        if (!!!spacesIsolated && fragments.initialized && fragments?.list.size > 0)
            toggleSpacesIsolation();
    }, [spacesIsolated]);

    useEffect(() => {
        if (currentBinnedTimestamp) {
            const binnedValues = getBinnedValues(new Date(currentBinnedTimestamp).toISOString());

            binnedValues.values().toArray().forEach((value: SensorBinnedValue) => {
                const sensor = sensors.get(value.id.toString());

                if (!sensor) return;

                const space = spaces.get(sensor.room_id);

                if (!space) return;

                // TODO: change color depending on currentChannel / define boundaries for each colors (probably according to channel type also)
                colorSpace(space.id, new THREE.Color(value.temperature > 25 ? "red" : value.temperature > 20 ? "orange" : "green"));
            });
        }
    }, [currentBinnedTimestamp]);

    return (
        <>
            <div ref={container} style={{ "width": "100vw", height: "100vh" }} />
            {/* <Checkbox
                style={{ position: "absolute", top: 10, right: 10, zIndex: 10 }}
                checked={spacesIsolated}
                onChange={(e) => setSpacesIsolated(e.target.checked)}
            >
                Isolate spaces
            </Checkbox> */}
            <div style={{ position: "absolute", top: 40, right: 10, zIndex: 10, backgroundColor: "white", padding: 10, maxHeight: "75vh", width: "25vw", overflow: "auto" }}>
            {
				modelTrees.map((tree) => computeModelTree(tree))
			}
            </div>
        </>
    );
};