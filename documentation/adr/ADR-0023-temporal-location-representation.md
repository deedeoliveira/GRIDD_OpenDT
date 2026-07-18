# ADR-0023 — Representação futura de localização temporal

- **Estado**: aceite (Prompt 5A, 2026-07-17) — **apenas contrato
  arquitetural**; nenhuma persistência, escrita em grafo, ingestão ou
  ontologia foi implementada nesta etapa
- **Contexto**: um equipamento pode mudar de espaço (nova versão IFC,
  operação humana, futura inferência por sensores) sem deixar de ser o mesmo
  ativo. A localização não pode contaminar a identidade (ADR-0011,
  ADR-0020).

## Decisão

A localização é um RECURSO SEPARADO ligado à URI persistente do ativo:

```text
asset URI → hasLocationAssignment → location-assignment URI → space URI
```

Contrato em `back/graph/assetLocationContracts.ts`
(`AssetLocationAssertion`): assertionId, assetUri, spaceUri, source
(`ifc_binding | manual | sensor_inference | external_system`), validFrom,
validTo?, observedAt?, confidence?, provenanceActivityUri?.

Invariantes que o contrato fixa:

- **identidade imutável**: mudar de espaço preserva asset_id/asset_uuid e a
  assetUri; mover = encerrar a atribuição anterior (validTo) + criar NOVA
  atribuição — nunca editar a antiga, nunca criar outro asset;
- **temporalidade**: validFrom/validTo delimitam a validade; só uma
  atribuição operacional corrente por fonte e regra de autoridade;
- **fonte e proveniência obrigatórias no futuro registo**; Tag,
  SerialNumber, GUID e ObjectType NÃO são fontes de localização;
- **observação ≠ localização validada**: `observedAt` (sensor) é distinto de
  `validFrom`; uma observação bruta nunca substitui automaticamente a
  localização operacional — a promoção exigirá regra explícita de validação
  e autoridade (etapa futura), distinguindo: observação bruta → inferência
  de localização → atribuição validada → projeção operacional corrente;
- conflitos entre fontes (ex.: sensor vs IFC) exigirão reconciliação futura
  com precedência explícita — NÃO definida nesta etapa.

## Âmbito atual (5A)

Para ativos MODELADOS a autoridade da localização continua a ser o
asset_binding da versão corrente (ADR-0022); reservas continuam ligadas ao
asset_id persistente e uma mudança de localização não contorna reservas.
Não foram criados: tabela de localização, escrita no grafo, ingestão de
sensores, inferência, precedência sensor/IFC, alteração de bindings.
