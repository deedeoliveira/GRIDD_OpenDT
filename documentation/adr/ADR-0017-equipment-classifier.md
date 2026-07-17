# ADR-0017 — Classificador central de candidatos a equipamento gerido

- **Estado**: aceite (revisão do Prompt 4, 2026-07-17)
- **Contexto**: até aqui, "equipamento" era implicitamente "qualquer elemento
  não-espaço" e a exclusão do IfcSensor vivia na política de reservabilidade.
  A intenção do domínio — *equipamento gerido = elemento operacional que não
  é espaço nem elemento arquitetónico/estrutural* — não pode ser algoritmo
  direto nem pode usar o `ReservabilityEvaluator` como classificador.
- **Decisão**:
  - contrato `ManagedEquipmentCandidateClassifier` (`classification/`):
    `classify(candidate, ctx) → {classification, classifierId, rulesVersion,
    ifcClass, predefinedType, objectType, tag, metadataUsed, reasons}` com
    categorias `managed_equipment | architectural_element |
    structural_element | space | ignored_element | undetermined |
    invalid_proxy`;
  - provider único `EQUIPMENT_CLASSIFIER_PROVIDER=project-profile`
    (registry; substituível/configurável no futuro, sem ontologia);
  - implementação atual por listas AUDITADAS (2026-07-17) + taxonomia IFC4:
    managed = classes observadas nos modelos/fixtures (IfcBoiler,
    IfcUnitaryEquipment, IfcElectricAppliance, IfcLightFixture, IfcOutlet,
    IfcSensor) + família de mobiliário; arquitetónico/estrutural = famílias
    IFC4 padrão; `IfcOpeningElement`/`IfcVirtualElement` = ignored;
  - classe fora das listas → `undetermined`: entity preservada, SEM ativo,
    diagnóstico explícito (`undetermined_classification`) e log — **nunca
    silenciosamente ignorado** (nenhuma lista arbitrária inventada);
  - a decisão para classes normais usa APENAS a classe IFC (perfil IFC4
    auditado) — nunca a presença de Tag (para conseguir detetar equipamento
    com Tag em falta), nunca a política e nunca o ObjectType: fora do
    IfcBuildingElementProxy, o ObjectType não tem qualquer papel na
    classificação (clarificação final; ver ADR-0018);
  - IfcSensor é classificado managed_equipment (é elemento operacional);
    a sua exclusão do inventário reservável continua a ser decisão da
    POLÍTICA legada (deny em candidato novo → sem ativo), preservada;
  - listas/regras de classes não podem existir fora de `classification/`
    (guarda automatizada) — Python extrai, Node classifica.
- **Consequências**: classes MEP de rede (dutos, tubos, fittings) surgem
  como `undetermined` até decisão explícita do perfil — comportamento
  deliberadamente conservador.
