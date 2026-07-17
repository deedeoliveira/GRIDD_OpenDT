# ADR-0006 — Modelo espacial autoritativo dentro da federação

- **Estado**: aceite (Prompt 3, 2026-07-16) — regra por omissão; configuração
  explícita **pendente de confirmação** para federações multi-modelo
- **Contexto**: uma federação (`linked_model`) pode ter vários modelos
  (arquitetura, estruturas, MEP). Só um deve mandar no inventário espacial:
  a ausência de um código numa nova versão só pode afetar o estado persistente
  do espaço quando vem do modelo autoritativo. Não se pode assumir "o
  arquitetónico" sem verificar — na auditoria, todas as federações têm
  exatamente um modelo, portanto a autoridade não é inferível de dados
  multi-modelo reais.
- **Decisão**:
  - metadado mínimo `linked_models.spatial_authority_model_id` (nullable, FK);
  - regra por omissão: com valor explícito → esse modelo é a autoridade; sem
    valor e com **exatamente um** modelo na federação → esse modelo é a
    autoridade; sem valor e com vários modelos → **nenhuma autoridade é
    assumida** (duplicações não bloqueiam ativação; ausências nunca alteram
    estado; diagnósticos ficam registados) até alguém configurar a coluna.
- **Efeitos da autoridade**: (a) duplicação ambígua de códigos numa versão do
  modelo autoritativo impede a ativação; (b) só versões ativadas do modelo
  autoritativo reconciliam estados `active`/`absent` dos espaços.
- **Nunca**: retirar/inativar espaços porque um modelo não espacial (ou não
  autoritativo) não os contém.
