# ADR-0011 — Identidade dos equipamentos modelados: IfcElement.Tag (EQP-)

- **Estado**: aceite (revisão do Prompt 4, 2026-07-17). **Substitui** a
  decisão original deste ADR (2026-07-17, ordem `Reference` em `Pset_*Common`
  → SerialNumber → GUID), que fica registada abaixo como superseded.
- **Contexto**: o perfil do projeto fixa que a `Tag` dos equipamentos NÃO é
  preenchida automaticamente pelo Revit — é controlada deliberadamente pelo
  gestor/modelador, sendo por isso o código institucional fiável. O esquema
  suportado e testado é **IFC4**.

## Decisão

```text
Manager inventory code for modelled equipment:
IfcElement.Tag with EQP- prefix.
```

```text
Optional physical-instance evidence:
SerialNumber (Pset_ManufacturerOccurrence) — stored separately
(assets.serial_number / asset_bindings.serial_snapshot), never in asset_code.
```

```text
Proxy classification:
IfcBuildingElementProxy requires ObjectType and EQP- Tag.
```

```text
Not identity:
ObjectType and Manufacturer information (marca/modelo comercial) —
metadados descritivos apenas; nunca chave, confiança ou reconciliação.
```

**Âmbito do ObjectType (clarificação final):** o ObjectType só é relevante
para o projeto quando a entidade é `IfcBuildingElementProxy` (ADR-0018).
Para qualquer classe IFC específica: não é exigido, não entra na validação
de requisitos, não determina se a entidade é equipamento gerido, não é
identidade, não participa da reconciliação nem da confiança, não é fallback
de Tag em falta e não distingue substituição de continuidade. Pode
permanecer no payload bruto da extração para diagnóstico, sem efeito de
domínio; `asset_bindings.object_type_snapshot` fica NULL em não-proxies
mesmo quando o export traga um valor.

```text
Legacy-only compatibility evidence:
IFC GUID (backfill, method legacy_ifc_guid, confiança média) —
nunca convertido em asset_code; sem fallback em novos uploads.
```

- Tag válida: string não vazia, prefixo EXATO `EQP-`, com conteúdo após o
  prefixo (regras únicas em `classification/equipmentTag.ts`).
- Resolver: `ifc-tag-serial-guid` (env `ASSET_IDENTITY_PROVIDER`; o nome
  anterior `ifc-asset-code-serial-guid` é alias de compatibilidade).
- `asset_code` recebe EXCLUSIVAMENTE a Tag (equipamentos) ou o Reference do
  espaço (ativos-espaço, ADR-0015) — nunca Reference de equipamento, serial,
  GUID, nome, ObjectType ou id Revit.

## Regras de reconciliação (sem merge automático)

| Evidência | Resultado |
|---|---|
| mesma Tag + mesmo serial | matched forte (`tag_and_serial`) |
| mesma Tag + serial ausente | matched pela Tag (`equipment_tag`), evidência reduzida documentada |
| mesma Tag + seriais diferentes | caso de reconciliação (`serial_conflict`: substituição física ou erro de dados) |
| mesmo serial + Tags diferentes | caso de reconciliação (`serial_renumbering`: renumeração ou erro de dados) |
| Tag diferente + serial diferente | ativos diferentes, salvo reconciliação humana |

- Equipamento modelado sem Tag válida **falha no preflight** (EQUIPMENT-001/
  002; PROXY-002 nos proxies) — nunca chega ao resolver em novos uploads.
- Ativos NÃO modelados terão perfil de identidade próprio (etapa futura) —
  estas regras não se lhes aplicam.

## Decisão anterior (superseded, 2026-07-17)

Ordem de evidência: 1) `Reference` no primeiro `Pset_*Common` (asset_code);
2) `Pset_ManufacturerOccurrence.SerialNumber` gravado em asset_code;
3) GUID na linha de modelo; 4) first_version → new; 5) unresolved.
Substituída porque o `Reference` de pset não é o código controlado pelo
gestor no perfil atual, e o serial não pode ocupar `asset_code`.
