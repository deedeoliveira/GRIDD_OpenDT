# ADR-0028 — Localização temporal dos ativos não modelados

- **Estado**: aceite (Prompt 5B, 2026-07-18). Implementa, para os ativos NÃO
  modelados, o contrato arquitetural do ADR-0023 (que continua a reger o
  futuro dos modelados/sensores).
- **Contexto**: um ativo não modelado muda de espaço sem deixar de ser o
  mesmo recurso; o histórico interessa à gestão e à tese.

## Decisão

- No grafo (autoridade): `asset → hasLocationAssignment → assignment →
  assignedSpace → space URI`, com validFrom/validTo/assignmentSource/
  provenanceActivity; **corrente ≡ ausência de validTo**; mover = INSERIR
  validTo na atribuição anterior (nunca apagar) + criar NOVA atribuição —
  identidade intacta:

```text
ativo na Sala X → movido para a Sala Y
⇒ mesmo asset_id, mesmo asset_uuid, MESMA asset URI
```

- Na projeção SQL: tabela `asset_location_assignments`
  (assignment_uuid, semantic_assertion_uri, asset_id→assets,
  space_id→spaces persistente, source, valid_from, valid_to, observed_at,
  confidence, provenance_activity_uri, projection_status);
  - `is_current` é DERIVADO (coluna gerada valid_to IS NULL) e **uma única
    corrente por ativo é garantida por UNIQUE (asset_id, current_marker)**
    com current_marker gerado = IF(valid_to IS NULL, 1, NULL);
  - histórico nunca sobrescrito; movimento fecha a anterior e insere a nova
    em transação;
- fontes previstas: manual | external_system | sensor_inference; nesta
  etapa APENAS `manual` é aceite via API — clientes não podem declarar
  sensor_inference (rejeitado 422); observedAt ≠ validFrom ≠ createdAt
  (movimento manual: observedAt fica nulo — nunca substituído por defeito);
- destino tem de ser espaço persistente ATIVO; 0 correntes → movimento
  recusado (diagnóstico, nada inventado); >1 correntes no grafo → estado
  inconsistente, movimento recusado até reconciliação (ADR-0029);
- espaço que passa a absent/retired DEPOIS: atribuição e histórico
  preservados, projeção reporta localização não disponível, novas reservas
  bloqueadas, reservas existentes intocadas;
- ausência de localização corrente bloqueia novas reservas — condição
  OPERACIONAL, não decisão de identidade nem de política.

## Fora do âmbito

Ingestão de sensores, inferência, precedência sensor/IFC, movimentação de
ativos modelados (continuam nos bindings IFC) e scheduler de sincronização.
