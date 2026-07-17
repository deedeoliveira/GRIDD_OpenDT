import inventoryDb from "../utils/inventoryDatabase.ts";

/**
 * Extrai o inventário via serviço Python/IfcOpenShell e grava o snapshot.
 *
 * O Python continua apenas a extrair candidatos — não decide reservabilidade
 * (a decisão é do provider de política dentro de saveInventorySnapshot).
 *
 * @param fileUrl URL de onde o Python deve descarregar o IFC. Quando fornecido
 *   (fluxo de versionamento: aponta para o download da versão em processamento),
 *   é passado no campo de formulário `path`, que o main.py já suporta. Quando
 *   omitido, o Python usa MODEL_DOWNLOAD_ROUTE/<modelId> (ficheiro corrente).
 */
export async function runPreprocess(modelId: number, versionId: number, fileUrl?: string) {

  const invResp = await fetch(
    `${process.env.IFCOPENSHELL_FLASK_API_ROUTE}/model/inventory/${modelId}`,
    fileUrl
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `path=${encodeURIComponent(fileUrl)}`,
        }
      : { method: 'POST' }
  );

  if (!invResp.ok) {
    throw new Error(`Error extracting inventory for model ${modelId}`);
  }

  const invPayload: any = await invResp.json();

  if (!invPayload?.data) {
    throw new Error("Inventory extraction failed");
  }

  const { spaceEntityIdsByGuid } = await inventoryDb.saveInventorySnapshot(versionId, invPayload.data);

  return { inventoryData: invPayload.data, spaceEntityIdsByGuid };
}
