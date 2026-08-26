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
 * SEGURANÇA: o Node envia apenas um IDENTIFICADOR NUMÉRICO de versão — nunca um
 * URL. O Python constrói o URL do download autenticado a partir da sua própria
 * configuração de confiança (MODEL_VERSION_DOWNLOAD_BASE_URL) e só então anexa o
 * token de serviço interno. Assim um chamador não pode escolher o destino do
 * pedido autenticado (o antigo campo `path` foi removido). Quando `versionId` é
 * omitido, o Python usa o download LEGADO por modelId (rota não autenticada, sem
 * token) — comportamento preservado para os chamadores do ficheiro corrente.
 *
 * @param versionId id (inteiro positivo) da versão em processamento.
 */
export async function fetchInventory(modelId: number, versionId?: number): Promise<ExtractedIfcModel> {

  const sendsVersion = Number.isInteger(versionId) && (versionId as number) > 0;
  const invResp = await fetch(
    `${process.env.IFCOPENSHELL_FLASK_API_ROUTE}/model/inventory/${modelId}`,
    sendsVersion
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `versionId=${encodeURIComponent(String(versionId))}`,
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
    // Lossless per-IfcSpace occurrences (ADR-0051 Stage 0B §1). Propagated verbatim
    // so the ORDINARY upload path (not only the controlled CLI extractor) can prove
    // GlobalId uniqueness before any persistence. When the bridge omits it (an older
    // Flask), it stays undefined: the write path then blocks with
    // `lossless_space_occurrences_missing` rather than trusting the collapsed dict.
    spaceOccurrences: Array.isArray(invPayload.spaceOccurrences) ? invPayload.spaceOccurrences : undefined,
    uncontainedProxies: invPayload.uncontainedProxies ?? [],
    schema: invPayload.schema ?? null,
    // RZ-1: passive pass-through only. Not interpreted here for acceptance/governance;
    // carried so a later slice (RZ-2+) can consume it without re-plumbing this bridge.
    reservationZoneOccurrences: Array.isArray(invPayload.reservationZoneOccurrences)
      ? invPayload.reservationZoneOccurrences
      : undefined,
  };
}
