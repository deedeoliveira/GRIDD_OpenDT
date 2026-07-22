"use client";

import * as OBC from "@thatopen/components";
import * as FRAGS from "@thatopen/fragments";
import * as THREE from "three";
import { useEffect, useRef, useState } from "react";
import type { FragmentsModel } from "@thatopen/fragments";
import { EyeVisible } from "@/app/components/icons/eye-visible";
import { EyeHidden } from "@/app/components/icons/eye-hidden";
import type { StudentModelContext } from "@/types/model";

const components = new OBC.Components();
const fragments = components.get(OBC.FragmentsManager);
const worlds = components.get(OBC.Worlds);
const world = worlds.create<OBC.SimpleScene, OBC.OrthoPerspectiveCamera, OBC.SimpleRenderer>();
const spaces = new Map<string, unknown>();
let model: FragmentsModel;

type SelectedIfcInfo = { guid: string; name?: string; tag?: string; ifcClass?: string };
type TreeNode = {
  data: { Name: string; modelId: string; localId?: number; hierarchy: string; guid?: string; ifcClass?: string };
  children?: TreeNode[];
  expanded?: boolean;
  hidden?: boolean;
};
type ViewerProps = {
  selectedModel: StudentModelContext;
  onWorldInitialized?: () => void;
  onElementSelected?: (info: SelectedIfcInfo) => void;
  onLoadStateChange?: (state: "loading" | "loaded" | "error", message?: string) => void;
  onTreeStateChange?: (rootCount: number) => void;
};

export function Viewer(props: ViewerProps) {
  const { selectedModel, onWorldInitialized, onLoadStateChange, onTreeStateChange } = props;
  const container = useRef<HTMLDivElement>(null);
  const callbackRef = useRef(props.onElementSelected);
  const loadedIdsRef = useRef<string[]>([]);
  const initializedRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const clickHandlerRef = useRef<((event: MouseEvent) => void) | null>(null);
  const [worldInitialized, setWorldInitialized] = useState(false);
  const [modelTrees, setModelTrees] = useState<TreeNode[]>([]);
  const [selectedLocalId, setSelectedLocalId] = useState<number | null>(null);
  const [, renderRevision] = useState(0);

  callbackRef.current = props.onElementSelected;

  async function selectItems(modelIdMap: OBC.ModelIdMap) {
    const modelId = Object.keys(modelIdMap)[0];
    const localIds = modelId ? [...modelIdMap[modelId]] : [];
    const localId = localIds[0];
    if (!modelId || typeof localId !== "number") return;
    const modelInstance = fragments.list.get(modelId);
    if (!modelInstance) return;
    const [data]: any[] = await modelInstance.getItemsData(localIds);
    if (!data) return;
    const attributes = Object.entries(data).reduce((acc: Record<string, unknown>, [key, value]: [string, any]) => {
      if (!key.startsWith("_")) acc[key] = value?.value;
      return acc;
    }, {});
    const guid = data?._guid?.value ?? attributes.GlobalId;
    setSelectedLocalId(localId);
    if (guid) callbackRef.current?.({
      guid: String(guid),
      name: attributes.Name || attributes.LongName ? String(attributes.Name ?? attributes.LongName) : undefined,
      tag: attributes.Tag ? String(attributes.Tag) : undefined,
      ifcClass: data?._category?.value ? String(data._category.value) : undefined,
    });
    await fragments.core.update(true);
  }

  function initWorld() {
    if (initializedRef.current || !container.current) return;
    initializedRef.current = true;
    world.scene = new OBC.SimpleScene(components);
    world.renderer = new OBC.SimpleRenderer(components, container.current);
    world.camera = new OBC.OrthoPerspectiveCamera(components);
    world.camera.threePersp.near = 0.01;
    world.camera.threePersp.updateProjectionMatrix();
    world.camera.projection.set("Perspective");
    world.camera.controls.restThreshold = 0.05;
    world.scene.setup();
    world.scene.three.background = new THREE.Color(0xf7f4f5);
    world.dynamicAnchor = false;
    components.init();
    const clickHandler = async (event: MouseEvent) => {
      const mouse = new THREE.Vector2(event.clientX, event.clientY);
      for (const loadedModel of fragments.list.values()) {
        const result = await loadedModel.raycast({ camera: world.camera.three, mouse, dom: world.renderer!.three.domElement });
        if (!result) continue;
        await selectItems({ [loadedModel.modelId]: new Set([result.localId]) });
        return;
      }
    };
    clickHandlerRef.current = clickHandler;
    container.current.addEventListener("click", clickHandler);
    setWorldInitialized(true);
  }

  async function clearWorld() {
    for (const fragId of loadedIdsRef.current) await fragments.core.disposeModel(fragId);
    spaces.clear();
    loadedIdsRef.current = [];
    setModelTrees([]);
    setSelectedLocalId(null);
    onTreeStateChange?.(0);
  }

  async function initFragmentsManager() {
    if (fragments.initialized) return;
    fragments.init("worker.mjs");
    fragments.list.onItemSet.add(({ value: loadedModel }) => {
      loadedModel.useCamera(world.camera.three);
      world.scene.three.add(loadedModel.object);
      fragments.core.update(true);
    });
    world.camera.projection.onChanged.add(() => {
      for (const [, loadedModel] of fragments.list) loadedModel.useCamera(world.camera.three);
    });
    world.camera.controls.addEventListener("rest", () => { void fragments.core.update(true); });
  }

  async function retrieveSpaces() {
    if (!model) return;
    spaces.clear();
    const finder = components.get(OBC.ItemsFinder);
    const spacesItems = await finder.getItems([{ categories: [/^IFCSPACE$/] }]);
    for (const [modelId, localIds] of Object.entries(spacesItems)) {
      const modelInstance = fragments.list.get(modelId);
      if (!modelInstance) continue;
      const rows: any[] = await modelInstance.getItemsData([...localIds]);
      for (const row of rows) spaces.set(row._guid.value, { id: row._guid.value, modelId, localId: row._localId.value });
    }
  }

  function findIfcBuilding(node: any): any | null {
    if (!node) return null;
    if (node.category === "IFCBUILDING") return node;
    for (const child of node.children ?? []) {
      const found = findIfcBuilding(child);
      if (found) return found;
    }
    return null;
  }

  async function getModelTree(loadedModel: FragmentsModel, structure: any, hierarchy = "/"): Promise<TreeNode | null> {
    const { localId, category, children } = structure;
    if (localId !== null) hierarchy += `${localId}/`;
    if (category && children) {
      const row: TreeNode = { data: { Name: category, modelId: loadedModel.modelId, hierarchy, ifcClass: category }, expanded: true };
      for (const child of children) {
        const childRow = await getModelTree(loadedModel, child, hierarchy);
        if (childRow) (row.children ??= []).push(childRow);
      }
      return row;
    }
    if (localId === null) return null;
    const item = loadedModel.getItem(localId);
    const attrs = await item.getAttributes();
    if (!attrs) return null;
    const [itemData]: any[] = await loadedModel.getItemsData([localId]);
    const row: TreeNode = {
      data: {
        Name: String(attrs.getValue("Name") || category || `Elemento ${localId}`),
        modelId: loadedModel.modelId,
        localId,
        hierarchy,
        guid: String(itemData?._guid?.value ?? attrs.getValue("GlobalId") ?? ""),
        ifcClass: String(itemData?._category?.value ?? category ?? ""),
      },
      expanded: true,
    };
    for (const child of children ?? []) {
      const childRow = await getModelTree(loadedModel, child, hierarchy);
      if (childRow) (row.children ??= []).push(childRow);
    }
    return row;
  }

  async function getSpatialStructure(models: any) {
    const trees: TreeNode[] = [];
    for (const loadedModel of models.values().toArray() as FragmentsModel[]) {
      const building = findIfcBuilding(await loadedModel.getSpatialStructure());
      if (!building) continue;
      const tree = await getModelTree(loadedModel, building);
      if (tree) trees.push(tree);
    }
    setModelTrees(trees);
    onTreeStateChange?.(trees.length);
  }

  async function loadLinkedModel() {
    if (!selectedModel.currentVersionId || !container.current) return;
    const generation = ++loadGenerationRef.current;
    onLoadStateChange?.("loading");
    try {
      if (!worldInitialized) return;
      if (!world.camera) throw new Error("O visualizador ainda não está pronto.");
      await world.camera.projection.set("Perspective");
      await initFragmentsManager();
      if (loadedIdsRef.current.length) await clearWorld();
      const ifcLoader = components.get(OBC.IfcLoader);
      await ifcLoader.setup({ autoSetWasm: false, wasm: { absolute: true, path: "" } });
      const response = await fetch(`/api/model/version/${selectedModel.currentVersionId}/download`, { cache: "no-store" });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        if (response.status === 401 || response.status === 403) throw new Error("A sessão atual não está autorizada a carregar este modelo.");
        if (response.status === 404) throw new Error("O ficheiro IFC da versão corrente não está disponível.");
        throw new Error(payload?.message ?? payload?.error ?? "Falha técnica ao carregar o ficheiro IFC.");
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json") || contentType.includes("text/html")) throw new Error("O serviço devolveu uma resposta inesperada em vez do ficheiro IFC.");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.byteLength) throw new Error("O ficheiro IFC da versão corrente está vazio.");
      if (generation !== loadGenerationRef.current) return;
      model = await ifcLoader.load(bytes, true, `${selectedModel.modelLineName}-v${selectedModel.currentVersionNumber}`);
      loadedIdsRef.current = [model.modelId];
      const firstTile = new Promise<boolean>((resolve) => {
        const timeout = window.setTimeout(() => resolve(false), 3_000);
        model.tiles.onItemSet.add(({ value: mesh }) => {
          if ("isMesh" in mesh) { mesh.castShadow = true; mesh.receiveShadow = true; }
          window.clearTimeout(timeout); resolve(true);
        });
      });
      model.useCamera(world.camera.three);
      if (model.object.parent !== world.scene.three) world.scene.three.add(model.object);
      const center = (model as any)._bbox.getCenter(new THREE.Vector3());
      await world.camera.controls.setLookAt(center.x + 25, center.y + 25, center.z + 25, center.x, center.y, center.z, false);
      await fragments.core.update(true);
      const tileArrived = await firstTile;
      await fragments.core.update(true);
      world.scene.three.updateMatrixWorld(true);
      world.camera.three.updateMatrixWorld(true);
      world.renderer!.three.render(world.scene.three, world.camera.three);
      void tileArrived;
      await retrieveSpaces();
      await getSpatialStructure(fragments.list);
      world.renderer?.resize();
      world.camera.updateAspect();
      onWorldInitialized?.();
      onLoadStateChange?.("loaded");
    } catch (reason) {
      if (generation !== loadGenerationRef.current) return;
      await clearWorld();
      onLoadStateChange?.("error", reason instanceof Error ? reason.message : "Falha técnica ao carregar o modelo.");
    }
  }

  function descendantIds(node: TreeNode): number[] {
    const ids = typeof node.data.localId === "number" ? [node.data.localId] : [];
    for (const child of node.children ?? []) ids.push(...descendantIds(child));
    return [...new Set(ids)];
  }

  async function setVisibility(node: TreeNode) {
    const ids = descendantIds(node);
    if (!ids.length || !fragments.list.get(node.data.modelId)) return;
    const nextVisible = Boolean(node.hidden);
    const update = (item: TreeNode) => { item.hidden = !nextVisible; item.children?.forEach(update); };
    update(node);
    await components.get(OBC.Hider).set(nextVisible, { [node.data.modelId]: new Set(ids) });
    await fragments.core.update(true);
    renderRevision((value) => value + 1);
  }

  function treeNode(node: TreeNode): React.ReactNode {
    const hasChildren = Boolean(node.children?.length);
    const ids = descendantIds(node);
    const hiddenCount = ids.filter((id) => findNodeHidden(node, id)).length;
    const allHidden = ids.length > 0 && hiddenCount === ids.length;
    const partiallyHidden = hiddenCount > 0 && !allHidden;
    return <div key={`${node.data.modelId}-${node.data.hierarchy}-${node.data.localId ?? node.data.Name}`} className="ml-1 border-l border-[var(--border)] pl-2">
      <div className={`flex min-h-9 items-center rounded px-1 ${selectedLocalId === node.data.localId ? "bg-[var(--uminho-primary-light)]" : ""}`}>
        <button type="button" className="mr-1 h-7 w-7 rounded hover:bg-[var(--uminho-primary-light)]" disabled={!hasChildren} onClick={() => { node.expanded = !node.expanded; renderRevision((value) => value + 1); }} aria-label={node.expanded ? `Fechar ${node.data.Name}` : `Abrir ${node.data.Name}`} aria-expanded={hasChildren ? Boolean(node.expanded) : undefined}>{hasChildren ? (node.expanded ? "−" : "+") : "·"}</button>
        <button type="button" className={`mr-1 flex h-8 w-8 items-center justify-center rounded border ${allHidden ? "border-[var(--border)] text-[var(--text-secondary)]" : "border-[var(--uminho-primary)] text-[var(--uminho-primary-dark)]"}`} onClick={() => void setVisibility(node)} aria-label={allHidden ? `Mostrar ${node.data.Name}` : `Ocultar ${node.data.Name}`} aria-pressed={!allHidden} data-visibility-state={partiallyHidden ? "partial" : allHidden ? "hidden" : "visible"}>{allHidden ? <EyeHidden width="19" height="19" /> : <EyeVisible width="19" height="19" />}</button>
        {typeof node.data.localId === "number" ? <button type="button" className="min-w-0 flex-1 truncate rounded px-2 py-1 text-left hover:bg-[var(--uminho-primary-light)]" data-tree-select data-ifc-guid={node.data.guid} data-ifc-class={node.data.ifcClass} onClick={() => void selectItems({ [node.data.modelId]: new Set([node.data.localId!]) })}>{node.data.Name}</button> : <span className="ml-2 truncate font-semibold">{node.data.Name}</span>}
      </div>
      {node.expanded && node.children?.map(treeNode)}
    </div>;
  }

  function findNodeHidden(root: TreeNode, localId: number): boolean {
    if (root.data.localId === localId) return Boolean(root.hidden);
    for (const child of root.children ?? []) {
      if (descendantIds(child).includes(localId)) return findNodeHidden(child, localId);
    }
    return false;
  }

  useEffect(() => { initWorld(); }, []);
  useEffect(() => { if (worldInitialized) void loadLinkedModel(); return () => { loadGenerationRef.current += 1; }; }, [selectedModel.modelLineId, selectedModel.currentVersionId, worldInitialized]);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(() => { world.renderer?.resize(); world.camera?.updateAspect(); });
    observer.observe(element);
    return () => observer.disconnect();
  }, [worldInitialized]);
  useEffect(() => () => {
    loadGenerationRef.current += 1;
    if (container.current && clickHandlerRef.current) container.current.removeEventListener("click", clickHandlerRef.current);
    void clearWorld();
  }, []);

  return <section className="mx-auto grid max-w-7xl gap-4 px-5 pb-5 lg:grid-cols-[minmax(17rem,22rem)_minmax(0,1fr)]" aria-label="Explorador do modelo IFC">
    <aside className="uminho-card order-2 flex min-h-0 flex-col overflow-hidden lg:order-1" aria-label="Árvore IFC">
      <header className="border-b border-[var(--border)] p-3"><h2 className="font-semibold">Árvore IFC</h2><p className="text-xs" style={{ color: "var(--text-secondary)" }}>Selecione um elemento pelo nome ou altere a visibilidade com o ícone de olho.</p></header>
      <div className="max-h-[32rem] overflow-auto p-2 lg:h-[38rem] lg:max-h-none" data-testid="ifc-tree-scroll">{modelTrees.length ? modelTrees.map(treeNode) : <p className="p-3 text-sm">A preparar a árvore…</p>}</div>
    </aside>
    <div className="uminho-card order-1 min-h-[26rem] overflow-hidden lg:order-2 lg:h-[38rem]" data-testid="ifc-viewer-panel">
      <div ref={container} className="h-full min-h-[26rem] w-full" aria-label="Visualizador tridimensional IFC" />
    </div>
  </section>;
}
