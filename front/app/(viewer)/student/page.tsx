"use client";

<html lang="pt-PT"></html>

import { useEffect, useState } from "react";
import { Viewer } from "./Viewer";

import { Accordion, AccordionItem, Button, CircularProgress } from "@heroui/react";
import type { LinkedModel } from "@/types/model";

import ReservationModal from "./ReservationModal";


type SelectedIfcInfo = {
  guid: string;
  name?: string;
  ifcClass?: string;
  predefinedType?: string;
  tag?: string;
};

type ReservationRow = {
  id: number;
  asset_id: number;
  actor_id: string;
  start_time: string;
  end_time: string;
  status: string;
};

export default function ViewerPage() {
  const [linkedModel, setLinkedModel] = useState<LinkedModel[]>([]);
  const [selectedLinkedModel, setSelectedLinkedModel] = useState<LinkedModel | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const [selectedIfc, setSelectedIfc] = useState<SelectedIfcInfo | null>(null);

  const [actorId] = useState<string>("pg202404");

  const [selectedAsset, setSelectedAsset] = useState<any | null>(null);
  const [assetReservations, setAssetReservations] = useState<ReservationRow[]>([]);
  const [actorReservations, setActorReservations] = useState<ReservationRow[]>([]);
  const [inventoryMessage, setInventoryMessage] = useState<string>("");

  const [isReservationOpen, setIsReservationOpen] = useState(false);
  const [isCheckingAsset, setIsCheckingAsset] = useState(false);



  /* -------------------------------------
              HELPERS
  ------------------------------------- */

  async function fetchJson(url: string) {
    const res = await fetch(url);
    const json = await res.json().catch(() => null);
    return { res, json };
  }

  async function fetchLinkedModelList() {
    const { res, json } = await fetchJson("/api/model/linked");
    if (!res.ok) return;

    const list = Array.isArray(json) ? json : json?.data ?? [];
    setLinkedModel(list);
  }

  function onWorldInitialized() {
    setIsLoading(false);
  }

  function onElementSelected(info: SelectedIfcInfo) {
    setSelectedIfc(info);
  }

  async function fetchAssetByGuidLatest(modelId: number, guid: string) {
    const { res, json } = await fetchJson(
      `/api/asset/by-guid-latest/${modelId}/${encodeURIComponent(guid)}`
    );

    if (!res.ok) return { ok: false, asset: null };

    const asset = json?.data ?? json;
    return { ok: true, asset: asset ?? null };
  }

  async function fetchReservationsByAsset(assetId: number) {
    const { res, json } = await fetchJson(
      `/api/reservation/asset/${assetId}`
    );

    if (!res.ok) return [];

    return (json?.data ?? json ?? []) as ReservationRow[];
  }

  async function fetchReservationsByActor(actorIdValue: string) {
    const { res, json } = await fetchJson(
      `/api/reservation/actor/${encodeURIComponent(actorIdValue)}`
    );

    if (!res.ok) return [];

    return (json?.data ?? json ?? []) as ReservationRow[];
  }

  /* -------------------------------------
              EFFECTS
  ------------------------------------- */

  useEffect(() => {
    fetchLinkedModelList();
  }, []);

  useEffect(() => {
    if (!selectedLinkedModel) return;

    setIsLoading(true);
    setSelectedIfc(null);

    setSelectedAsset(null);
    setAssetReservations([]);
    setActorReservations([]);
    setInventoryMessage("");
    setIsCheckingAsset(false);
  }, [selectedLinkedModel]);

  useEffect(() => {
    if (!selectedIfc?.guid) return;
    if (!selectedLinkedModel?.id) return;

    let cancelled = false;

    async function loadReservationData() {
      setIsCheckingAsset(true);
      setInventoryMessage("");
      setSelectedAsset(null);
      setAssetReservations([]);
      setActorReservations([]);

      const { ok, asset } = await fetchAssetByGuidLatest(
        selectedLinkedModel.id,
        selectedIfc.guid
      );

      if (cancelled) return;

      if (!ok) {
        setInventoryMessage("Erro ao consultar inventário.");
        setIsCheckingAsset(false);
        return;
      }

      if (!asset) {
        setInventoryMessage("Elemento não pertence ao inventário.");
        setIsCheckingAsset(false);
        return;
      }

      setSelectedAsset(asset);

      const aRows = await fetchReservationsByAsset(asset.id);
      if (cancelled) return;
      setAssetReservations(aRows);

      const uRows = await fetchReservationsByActor(actorId);
      if (cancelled) return;
      setActorReservations(uRows);

      setIsCheckingAsset(false);
    }

    loadReservationData();

    return () => {
      cancelled = true;
    };
  }, [selectedIfc?.guid, selectedLinkedModel?.id, actorId]);


  /* -------------------------------------
              UI
  ------------------------------------- */

  return (
    <>
      {isLoading && (
        <div className="flex w-full h-full justify-center items-center absolute top-0 left-0 z-10 bg-black/30">
          <CircularProgress aria-label="Loading model" />
        </div>
      )}

      <div className="w-80 absolute top-4 left-4 z-20 rounded shadow bg-white">
        <Accordion>
          <AccordionItem key="1" title="Models">
            {linkedModel.map((model) => (
              <Button
                key={model.id}
                onPress={() => setSelectedLinkedModel(model)}
                variant={selectedLinkedModel?.id === model.id ? "solid" : "light"}
                className="m-1"
              >
                {model.name}
              </Button>
            ))}
          </AccordionItem>

          <AccordionItem key="2" title="Selected">
            {!selectedIfc ? (
              <div className="p-2 text-sm text-gray-600">
                Nenhum elemento selecionado
              </div>
            ) : (
              <div className="p-2 text-sm">
                <div><strong>Name:</strong> {selectedIfc.name ?? "-"}</div>
                <div><strong>Tag:</strong> {selectedIfc.tag ?? "-"}</div>
                <div><strong>GUID:</strong> {selectedIfc.guid}</div>

                <hr className="my-2" />

                {isCheckingAsset ? (
                  <div className="text-sm text-gray-500">
                    Verificando inventário...
                  </div>
                ) : inventoryMessage ? (
                  <div className="text-sm text-gray-500">
                    {inventoryMessage}
                  </div>

                ) : selectedAsset ? (
                  selectedAsset.reservable ? (
                    <>
                      <div><strong>Asset ID:</strong> {selectedAsset.id}</div>

                      <Button
                        className="mt-3"
                        onPress={() => setIsReservationOpen(true)}
                      >
                        Reservar
                      </Button>
                    </>
                  ) : (
                    <div className="text-sm text-gray-500 mt-2">
                      Este elemento não pode ser reservado.
                    </div>
                  )
                ) : (

                  <div className="text-sm text-gray-500 mt-2">
                    Este elemento não pertence ao inventário e não pode ser reservado.
                  </div>
                )}
              </div>
            )}
          </AccordionItem>

        </Accordion>
      </div>

      <Viewer
        selectedModel={selectedLinkedModel}
        onWorldInitialized={onWorldInitialized}
        onElementSelected={onElementSelected}

      />
      {isReservationOpen && selectedAsset && (
        <ReservationModal
          asset={selectedAsset}
          actorId={actorId}
          onClose={() => setIsReservationOpen(false)}
        />
      )}

    </>
  );
}
