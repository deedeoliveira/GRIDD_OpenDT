import inventoryDb from "../utils/inventoryDatabase.ts";

export async function runPreprocess(modelId: number, versionId: number) {

  const invResp = await fetch(
    `${process.env.IFCOPENSHELL_FLASK_API_ROUTE}/model/inventory/${modelId}`,
    { method: 'POST' }
  );

  if (!invResp.ok) {
    throw new Error(`Error extracting inventory for model ${modelId}`);
  }

  const invPayload = await invResp.json();

  if (!invPayload?.data) {
    throw new Error("Inventory extraction failed");
  }

  await inventoryDb.saveInventorySnapshot(versionId, invPayload.data);

  return true;
}
