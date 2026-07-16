# ADR-0003 — Versões falhadas: linha preservada, inventário e ficheiro removidos

- **Estado**: aceite (Prompt 2, 2026-07-16)
- **Contexto**: o fluxo antigo apagava a linha de `model_versions` quando o preprocess
  falhava (`deleteModelVersion`), perdendo qualquer rasto da falha; MySQL e sistema de
  ficheiros não partilham transação, portanto não há atomicidade total.
- **Decisão** (compensações explícitas, nesta ordem, em qualquer falha das etapas
  promoção→processamento→inventário→ativação):
  1. `deleteInventoryForVersion(versionId)` — apaga assets e entities da versão
     (filhas antes das raízes, por causa das FKs) para nunca deixar inventário
     parcial utilizável;
  2. `markFailed(versionId, "stage: motivo")` — a linha fica `failed` com
     `failure_reason` preenchido e `storage_key = NULL` (diagnóstico rastreável);
  3. remoção do diretório `models/{modelId}/versions/{versionId}` (ficheiro promovido
     de versão falhada não fica no storage);
  4. o temporário é sempre limpo (`finally`);
  5. log estruturado `model_upload_failure` com stage, modelId, versionId e erro.
- **Invariantes garantidas**: a versão anteriormente corrente permanece corrente (a
  troca só acontece na ativação, última etapa); o viewer continua a abrir a versão
  anterior; nenhuma reserva é tocada; uma versão `failed` nunca pode ser ativada.
- **Alternativa rejeitada**: apagar a linha (comportamento antigo) — perde a
  rastreabilidade da falha e reutilizaria o `version_number`.
