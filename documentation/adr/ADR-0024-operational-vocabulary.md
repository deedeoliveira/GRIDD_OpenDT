# ADR-0024 — Vocabulário operacional provisório (operational-v1)

- **Estado**: aceite (Prompt 5B, 2026-07-18)
- **Contexto**: escrever ativos não modelados em RDF exige termos. A seleção
  ontológica da tese (ifcOWL/BOT/Brick/SAREF/alinhamentos) é uma decisão
  futura que NÃO pode ser antecipada silenciosamente por uma etapa técnica.
- **Alternativas consideradas**: adotar já uma ontologia externa (rejeitado:
  decisão de investigação prematura); strings RDF ad-hoc espalhadas
  (rejeitado: irrecuperável); vocabulário mínimo do projeto, versionado
  (escolhido).

## Decisão

`back/graph/operationalVocabulary.ts` define o namespace versionado
`{GRAPH_BASE_URI}/vocab/operational-v1#` com classes `NonModelledAsset`,
`LocationAssignment`, `RegistrationActivity`, `LocationChangeActivity` e as
propriedades assetUuid/assetCode/displayName/assetType/resourceKind/
serialNumber/sourceSystem/registrationKey/hasLocationAssignment/
assignedAsset/assignedSpace/validFrom/validTo/observedAt/assignmentSource/
confidence/createdAt/provenanceActivity.

Regras:

- é um vocabulário TÉCNICO PROVISÓRIO — não é a ontologia da tese, não é
  conversão do IFC, não introduz vocabulários externos (apenas `rdf:type` e
  datatypes XSD) e poderá ser alinhado/substituído (a versão no namespace
  impede reinterpretação silenciosa dos dados já escritos);
- nenhum termo IFC para ativos sem IFC (sem ObjectType/Tag/GUID/classes Ifc*);
- termos centralizados: NENHUMA string RDF de termos fora de `back/graph/`
  (guarda automatizada); serialização exclusivamente via `sparqlText.ts`
  (IRIs validadas, literais escapados — sem SPARQL injection);
- o namespace deriva de GRAPH_BASE_URI: quando a base de produção for
  aprovada, os termos são re-emitidos sob essa base (dados de dev não são
  prometidos como estáveis).

## Consequências

- O Prompt 5B escreve RDF sem comprometer a seleção ontológica futura
  (documentado: *IFC-to-RDF mapping and ontology selection are outside
  Prompt 5B*);
- uma futura ontologia de domínio exigirá mapeamento/alinhamento explícito
  destes termos (operational-v2 ou vocabulário externo), com migração
  documentada.
