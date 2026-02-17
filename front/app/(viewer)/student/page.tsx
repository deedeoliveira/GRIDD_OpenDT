"use client";

import { useEffect, useState } from "react";
import { Viewer } from "./Viewer";

import {
  Accordion,
  AccordionItem,
  Button,
  CircularProgress
} from "@heroui/react";

import type { LinkedModel, Model } from "@/types/model";

export default function ViewerPage() {

  /* -------------------------------------
              VARIABLES
  ------------------------------------- */

  const [linkedModel, setLinkedModel] = useState<LinkedModel[]>([]);
  const [selectedLinkedModel, setSelectedLinkedModel] = useState<LinkedModel | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  /* -------------------------------------
              FUNCTIONS
  ------------------------------------- */

  async function fetchLinkedModelList() {
    const res = await fetch(`/api/model/linked`);
    if (!res.ok) return;

    const data = await res.json();
    setLinkedModel(data);
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
	console.log("Selected model changed:", selectedLinkedModel);
  }, [selectedLinkedModel]);

  /* -------------------------------------
              UI
  ------------------------------------- */

  return (
    <>
      {isLoading && (
        <div className="flex w-full h-full justify-center items-center absolute top-0 left-0 z-10 bg-black/30">
          <CircularProgress />
        </div>
      )}

      <div className="w-80 h-fit flex flex-col items-start absolute top-4 left-4 z-20 rounded shadow bg-white">
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
        </Accordion>
      </div>

      <Viewer
        selectedModel={selectedLinkedModel}
        onWorldInitialized={onWorldInitialized}
      />
    </>
  );
}
