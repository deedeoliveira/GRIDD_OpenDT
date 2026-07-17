# ADR-0009 — spatial_preflight estrito no modelo espacial autoritativo

- **Estado**: aceite (revisão do Prompt 3, 2026-07-16). **Substitui** a decisão
  de compatibilidade do Prompt 3 original (registada em PROMPT3_SPACES.md §2/§9
  e refletida no ADR-0007, agora atualizado por esta).
- **Decisão substituída**:
  ```
  Previous compatibility behavior:
  spaces without Reference did not block the upload.

  Current strict information-requirement behavior:
  the authoritative spatial model is rejected when any IfcSpace lacks a valid Reference.
  ```
- **Regra atual** (etapa `spatial_preflight`, entre o processamento Python e a
  persistência — nada é criado para depois ser apagado quando a falha é
  detetável no payload):
  - aplica-se APENAS ao modelo espacial autoritativo (ADR-0006: coluna
    explícita, ou o único modelo da federação); federações multi-modelo sem
    autoridade configurada mantêm a regra de autoridade indeterminada — sem
    validação estrita, para não impossibilitar uploads disciplinares;
  - zero `IfcSpace` → rejeição (`422`, `failure_reason = "spatial_preflight:
    no IfcSpace found"`);
  - qualquer `IfcSpace` sem código de inventário válido (ausente, vazio,
    whitespace, tipo inesperado) → rejeição sem aceitação parcial, com
    diagnóstico agregado (GUID, Name, LongName, índice, motivo) e mensagem
    com contagem ("N of M IfcSpace elements are missing a valid inventory
    reference");
  - códigos duplicados → rejeição (deteção movida do serviço de persistência
    para o preflight; a persistência mantém uma verificação defensiva com a
    MESMA lógica partilhada `groupDuplicateReferences`).
- **Natureza da falha**: requisitos de informação/pré-processamento espacial —
  não é decisão de política. Não passa pelo avaliador de reservabilidade, não
  produz resultados de política, não altera a regra legada (IfcSensor,
  IfcDistributionControlElement e `reservable` intactos). Ter código não torna
  um espaço reservável; identidade ≠ reservabilidade.
- **Efeitos em falha**: versão `failed` com etapa `spatial_preflight`, corrente
  anterior preservada, nenhum dado parcial (entities/assets/spaces/bindings
  nunca chegam a existir), ficheiro promovido e temporários compensados
  (regras do Prompt 2), reservas intocadas.
- **Fonte substituível**: a identidade continua atrás do provider
  (`SPACE_IDENTITY_PROVIDER`, default `pset-space-common-reference`); as
  strings `Pset_SpaceCommon`/`Reference` vivem apenas em `back/identity/`
  (teste-guarda) e as mensagens usam a origem dinâmica do provider. Ainda não
  existe ontologia, SHACL nem SPARQL.
