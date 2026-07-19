# ADR-0025 — Identidade dos ativos não modelados

- **Estado**: aceite (Prompt 5B, 2026-07-18)
- **Contexto**: ativos sem representação IFC não têm entity, binding, GUID,
  `IfcElement.Tag` nem ObjectType — as regras de identidade dos equipamentos
  MODELADOS (ADR-0011) não se lhes aplicam.

## Decisão

```text
Identidade principal: asset_uuid gerado pela aplicação no registo.
URI persistente:      {base}/asset/{asset_uuid} (SemanticUriFactory).
```

- a MESMA identidade e URI acompanham o recurso durante toda a vida — mudar
  de localização NUNCA gera novo UUID/URI/asset (ADR-0028);
- **código do gestor (managerCode → assets.asset_code) é OPCIONAL**: não
  precisa de prefixo EQP- (não é Tag IFC), não participa da geração da
  identidade, é preservado quando fornecido e nunca fabricado. Âmbito de
  unicidade PROVISÓRIO: ativos não modelados (source='graph'), código
  normalizado trim+uppercase, verificado no serviço — sem constraint SQL
  nesta etapa porque não há coluna normalizada nem âmbito
  linked_model/facility definido para estes ativos (lacuna documentada);
- **serial number é OPCIONAL**, metadado separado; nunca substitui UUID ou
  código, nunca une registos automaticamente;
- Manufacturer não participa; nenhum dado IFC é fabricado;
- a chave idempotente do comando (`registrationKey`) NÃO é identidade nem
  URI pública — só deduplica o comando (ADR-0027);
- id SQL auto-increment continua a não ser identidade global (ADR-0020).

## Consequências

- assets ganha `asset_subtype` (tipo livre do projeto, ex. PortableEquipment)
  e usa `asset_type` ENUM existente como resource kind (equipment|tool);
- `source='graph'` distingue projeções (ADR-0026); ativos modelados e os
  seus fluxos (Tag EQP-, bindings) ficam intocados.
