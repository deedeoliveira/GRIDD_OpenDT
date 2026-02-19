"use client";

import * as OBC from "@thatopen/components";
import * as FRAGS from "@thatopen/fragments";
import * as THREE from "three";
import { createRef, useEffect, useState, useRef } from "react";
import { FragmentsModel } from "@thatopen/fragments";
import { Button } from "@heroui/react";
import { EyeVisible } from "@/app/components/icons/eye-visible"
import { EyeHidden } from "@/app/components/icons/eye-hidden";
import { ChevronUp } from "@/app/components/icons/chevron-up";
import { ChevronDown } from "@/app/components/icons/chevron-down";



const components = new OBC.Components();
const fragments = components.get(OBC.FragmentsManager);
const worlds = components.get(OBC.Worlds);
const world = worlds.create<
    OBC.ShadowedScene,
    OBC.OrthoPerspectiveCamera,
    OBC.SimpleRenderer
>();



type SelectedIfcInfo = {
  guid: string;
  name?: string;
  tag?: string;
};

type ViewerProps = {
  selectedModel: any;
  onWorldInitialized?: () => void;
  onElementSelected?: (info: SelectedIfcInfo) => void;
};

let model: FragmentsModel;

const spaces = new Map<string, any>();

export function Viewer(props: ViewerProps) {

    const { selectedModel, onWorldInitialized, onElementSelected } = props;

    const container = useRef<HTMLDivElement>(null);
    const [worldInitialized, setWorldInitialized] = useState(false);
    const [fragmentsModelIds, setFragmentsModelIds] = useState<number[]>([]);
    const [modelTrees, setModelTrees] = useState<any[]>([]);
    const [selectedObjectProperties, setSelectedObjectProperties] = useState<any | null>(null);

    const resizeWorld = () => {
        world.renderer?.resize();
        world.camera.updateAspect();
    }

    function initWorld() {
        if (worldInitialized) return;

        world.scene = new OBC.ShadowedScene(components);
        world.renderer = new OBC.SimpleRenderer(components, container.current);
        world.camera = new OBC.OrthoPerspectiveCamera(components);

        // ✅ THIS IS THE IMPORTANT PART
        world.scene.setup({
            shadows: {
                cascade: 1,
                resolution: 1024
            }
        });

        world.scene.three.background = new THREE.Color(0xfafafa);

        container.current?.addEventListener("resize", resizeWorld);
        components.init();

        //const highlighter = components.get(OBC.Highlighter);
        //highlighter.setup({ world });


        const caster = components.get(OBC.Raycasters).get(world);

        container.current?.addEventListener("dblclick", async () => {
            const result = await caster.castRay();

            if (!result) {
                setSelectedObjectProperties(null);
                return;
            }

            const modelIdMap = { [result.fragments.modelId]: new Set([result.localId]) };
            onSelectCallback(modelIdMap);
        });

        setWorldInitialized(true);
    }


    async function clearWorld() {
        if (fragmentsModelIds.length) {
            for (const fragId of fragmentsModelIds) {
                await fragments.core.disposeModel(fragId);
            }
        }

        spaces.clear();
        setFragmentsModelIds([]);
        setModelTrees([]);
    }

    async function initFragmentsManager() {
        if (fragments.initialized) return;

        fragments.init("worker.mjs");

        fragments.list.onItemSet.add(({ value: model }) => {
            model.useCamera(world.camera.three);
            world.scene.three.add(model.object);
            fragments.core.update(true);
        });
    }

    const loadLinkedModel = async () => {
        if (!selectedModel?.childModels?.length || !container.current) return;

        if (!worldInitialized) {
            initWorld();
        }

        // 🔵 GARANTIR que a câmera foi criada
        if (!world.camera) {
            console.warn("World camera not ready yet");
            return;
        }

        if (!fragments.initialized) {
            await initFragmentsManager();
        }

        if (fragmentsModelIds.length) await clearWorld();

        const ifcLoader = components.get(OBC.IfcLoader);
        await ifcLoader.setup({
            autoSetWasm: false,
            wasm: { absolute: true, path: "" },
        });

        const modelIds: number[] = [];

        for (const childModel of selectedModel.childModels) {

            const res = await fetch(`/api/model/download/${childModel.id}`);

            const blob = await res.blob();

            const arrayBuffer = new Uint8Array(await blob.arrayBuffer());

            model = await ifcLoader.load(arrayBuffer, true, childModel.name);

            modelIds.push(model.modelId);
        }

        await retrieveSpaces();
        setFragmentsModelIds(modelIds);

        await getSpatialStructure(fragments.list);

        onWorldInitialized?.();
    }

    async function retrieveSpaces() {

        if (!model) return;

        spaces.clear();

        const finder = components.get(OBC.ItemsFinder);
        const spacesItems = await finder.getItems([{ categories: [/^IFCSPACE$/] }]);

        for (const [modelId, localIds] of Object.entries(spacesItems)) {
            const modelInstance = fragments.list.get(modelId);
            if (!modelInstance) continue;

            const spaceItemData = await modelInstance.getItemsData([...localIds]);

            for (const spaceData of spaceItemData) {
                spaces.set(spaceData._guid.value, {
                    id: spaceData._guid.value,
                    modelId,
                    localId: spaceData._localId.value
                });
            }
        }
    }

    async function onSelectCallback(modelIdMap: OBC.ModelIdMap) {
        const modelId = Object.keys(modelIdMap)[0];

        if (modelId && fragments.list.get(modelId)) {
            const modelInstance = fragments.list.get(modelId)!;
            const [data] = await modelInstance.getItemsData([...modelIdMap[modelId]]);

            const attributes = Object.entries(data).reduce((acc: any, [key, value]: any) => {
            if (key.startsWith("_")) return acc;
            acc[key] = value.value;
            return acc;
            }, {});

            const guid =
            data?._guid?.value ??
            attributes?.GlobalId ??
            null;

            const name =
            attributes?.Name ??
            attributes?.LongName ??
            null;

            const tag =
            attributes?.Tag ??
            null;

            if (guid && props.onElementSelected) {
            props.onElementSelected({
                guid: String(guid),
                name: name ? String(name) : undefined,
                tag: tag ? String(tag) : undefined
            });
            }
        }

        await fragments.core.update(true);
    }

    function expandTreeToDepth(node: any, depth: number) {
        if (!node || depth <= 0) return;

        node.expanded = true;

        if (Array.isArray(node.children)) {
            for (const child of node.children) {
            expandTreeToDepth(child, depth - 1);
            }
        }
        }

    async function getSpatialStructure(models: any) {
        if (!models || models.size === 0) return;

        const trees: any[] = [];

        const promises: Promise<void>[] = [];

        models.values().toArray().forEach((model: FRAGS.FragmentsModel) => {
            promises.push(new Promise<void>(async (resolve) => {

                const structure = await model.getSpatialStructure();

                // 🔵 Encontrar primeiro IfcBuilding
                const buildingNode = findIfcBuilding(structure);

                if (!buildingNode) {
                    resolve();
                    return;
                }

                const tree = await getModelTree(model, buildingNode);

                if (tree) {
                // abre o IFCBUILDING + próximos níveis (ajusta o "3" se quiser mais/menos)
                expandTreeToDepth(tree, 10);
                trees.push(tree);
                }

                resolve();
            }));
        });

        await Promise.all(promises);
        setModelTrees(trees);
    }

    function findIfcBuilding(node: any): any | null {
        if (!node) return null;

        if (node.category === "IFCBUILDING") {
            return node;
        }

        if (node.children && node.children.length > 0) {
            for (const child of node.children) {
                const found = findIfcBuilding(child);
                if (found) return found;
            }
        }

        return null;
    }

    const getModelTree = async (
        model: FRAGS.FragmentsModel,
        structure: any,
        hierarchy: string = '/'
    ): Promise<any> => {

        const { localId, category, children } = structure;

        if (localId !== null)
            hierarchy = hierarchy + localId + '/';

        if (category && children) {
            const row: any = {
                data: {
                    Name: category,
                    modelId: model.modelId,
                    children: JSON.stringify(children.map((item: any) => item.localId)),
                    hierarchy
                }
            };

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

            const row: any = {
                data: {
                    Name: String(attrs.getValue("Name")),
                    modelId: model.modelId,
                    localId,
                    hierarchy
                }
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
    };

    function computeModelTree(elem: any) {

        elem.childRef = createRef();
        let childs;

        if (elem.children && elem.children.length > 0)
            childs = elem.children.map((child: any) => computeModelTree(child));

        return (
            <div key={elem.data?.localId || Math.random()} className="flex flex-col ml-1 border-l border-gray-300 pl-2">
                <div className="flex flex-row items-center">
                    <button onClick={() => handleExpandButton(elem)}>+</button>
                    <button onClick={() => handleVisibilityButton(elem)}>👁</button>
                    <div className="ml-2">{elem.data.Name}</div>
                </div>
                <div ref={elem.childRef} style={{ display: elem.expanded ? 'block' : 'none' }}>
                    {childs}
                </div>
            </div>
        );
    }


    function handleExpandButton(elem: any) {
        elem.expanded = !elem.expanded;
        elem.childRef.current.style.display = elem.expanded ? 'block' : 'none';
    }

    function handleVisibilityButton(elem: any) {
        elem.hidden = !elem.hidden;
        hideElementAndChilds(elem);
    }

    function hideElementAndChilds(elem: any) {
        if (!elem) return;

        const modelId = elem.data?.modelId;
        if (!modelId || !fragments.list.get(modelId)) return;

        const modelIdMap = { [modelId]: new Set(getChildsRecursively(elem)) };

        const hider = components.get(OBC.Hider);
        hider.toggle(modelIdMap);
    }

    function getChildsRecursively(elem: any): number[] {
        if (!elem) return [];

        let arr: number[] = [];

        if (elem.children && elem.children.length > 0) {
            elem.children.forEach((child: any) => {
                arr.push(child.data.localId);
                arr = arr.concat(getChildsRecursively(child));
            });
        }

        return arr.filter((v, i, a) => a.indexOf(v) === i && !!v);
    }


    function computeObjectProperties() {
        return Object.entries(selectedObjectProperties ?? {}).map(([key, value]) => (
            <tr key={key}>
                <td className="border px-2 py-1 font-bold">{key}</td>
                <td className="border px-2 py-1">{String(value)}</td>
            </tr>
        ));
    }

    async function checkAvailability() {
        if (!selectedAsset) return;

        const versionId = selectedAsset.model_version_id;

        const res = await fetch(
            `/api/asset/availability/${selectedAsset.id}/${versionId}?start=${startTime}&end=${endTime}`
        );

        if (res.ok) {
            const data = await res.json();
            setAvailabilityResult(data.data);
        }
    }

    async function createReservation() {
        if (!selectedAsset) return;

        const res = await fetch(`/api/reservation/request`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                assetId: selectedAsset.id,
                actorId,
                startTime,
                endTime
            })
        });

        if (res.ok) {
            alert("Reservation requested successfully!");
            setIsReserveModalOpen(false);
        } else {
            const err = await res.json();
            alert(err.message);
        }
    }



    useEffect(() => {
        initWorld();
    }, []);

    useEffect(() => {
        if (selectedModel)
            loadLinkedModel();
    }, [selectedModel]);

    return (
        <>
            <div ref={container} style={{ width: "100vw", height: "100vh" }} />

            <div style={{
                position: "absolute",
                top: 40,
                right: 10,
                zIndex: 10,
                backgroundColor: "white",
                padding: 10,
                maxHeight: "75vh",
                width: "25vw",
                overflow: "auto"
            }}>
                {modelTrees.map((tree) => computeModelTree(tree))}
            </div>

        </>
    );
}
