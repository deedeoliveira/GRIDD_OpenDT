import type { ExtractedIfcModel } from "../requirements/modelRequirementsTypes.ts";

/**
 * Extração do inventário via serviço Python/IfcOpenShell (SEM persistência).
 *
 * O Python continua apenas a extrair candidatos — não decide identidade,
 * classificação, reservabilidade nem requisitos de informação. A validação
 * acontece no model_requirements_preflight e a persistência do snapshot
 * (entities) acontece depois (ver modelUploadService).
 *
 * A resposta mantém `data` (dict de espaços) por compatibilidade e traz em
 * campos irmãos o contexto do modelo: `schema` (perfil suportado/testado:
 * IFC4) e `uncontainedProxies` (IfcBuildingElementProxy fora de espaços,
 * abrangidos pelas regras PROXY-*).
 *
 * @param fileUrl URL de onde o Python deve descarregar o IFC. Quando fornecido
 *   (fluxo de versionamento: aponta para o download da versão em processamento),
 *   é passado no campo de formulário `path`, que o main.py já suporta. Quando
 *   omitido, o Python usa MODEL_DOWNLOAD_ROUTE/<modelId> (ficheiro corrente).
 */
export async function fetchInventory(modelId: number, fileUrl?: string): Promise<ExtractedIfcModel> {

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

  return {
    inventoryData: invPayload.data,
    uncontainedProxies: invPayload.uncontainedProxies ?? [],
    schema: invPayload.schema ?? null,
  };
}
