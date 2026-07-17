# ADR-0018 — Tratamento do IfcBuildingElementProxy

- **Estado**: aceite (revisão do Prompt 4, 2026-07-17)
- **Contexto**: o proxy é a classe de escape do modelador quando não há
  classe IFC adequada (ex.: Generic Model do Revit). Sem regras, um proxy
  tanto pode ser um equipamento crítico como lixo de modelação — e não é
  aceitável classificá-lo automaticamente por nome/semelhança.
- **Decisão** (regra obrigatória do perfil atual, aplicada a QUALQUER proxy
  do modelo — contido em espaço ou não, autoritativo ou não):

```text
IfcBuildingElementProxy sem ObjectType válido            → modelo rejeitado (PROXY-001)
IfcBuildingElementProxy com ObjectType, sem Tag EQP-     → modelo rejeitado (PROXY-002)
IfcBuildingElementProxy com ObjectType e Tag EQP- válida → managed_equipment (PROXY-003)
```

- `ObjectType` = classificação/organização deliberada do modelador:
  - não é identificador persistente, não substitui a Tag, não precisa de
    ser único, **nunca** vai para `asset_code`;
  - vazio/whitespace equivale a ausência; `PredefinedType`, `Name` e
    `Description` NÃO o substituem;
  - é preservado como snapshot (`asset_bindings.object_type_snapshot`),
    metadado do resultado de classificação e diagnóstico;
  - dois proxies com o mesmo ObjectType NÃO são o mesmo equipamento — o
    ObjectType nunca provoca reconciliação automática.
- Um proxy nunca é classificado automaticamente como elemento arquitetónico,
  estrutural ou ignorado; um provider posterior não pode transformar um
  proxy inválido em elemento ignorado sem alteração explícita do perfil.
- Proxy válido segue o fluxo normal de equipamento gerido: identidade pela
  Tag (ADR-0011), política de reservabilidade, asset + binding.
- **Âmbito exclusivo (clarificação final):** o ObjectType só é relevante
  para o projeto no IfcBuildingElementProxy. Em classes IFC específicas não
  é exigido, não entra em requisitos/classificação/identidade/reconciliação/
  confiança, não substitui Tag em falta e não distingue substituição de
  continuidade; `asset_bindings.object_type_snapshot` é preenchido APENAS
  para proxies (NULL nos restantes, mesmo com valor no export — o payload
  bruto pode mantê-lo para diagnóstico, sem efeito de domínio).
- Ativos não modelados NÃO usam IfcBuildingElementProxy (perfil próprio,
  etapa futura).
