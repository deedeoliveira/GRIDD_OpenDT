# ADR-0001 — Versão corrente por referência explícita (`models.current_version_id`)

- **Estado**: aceite (Prompt 2, 2026-07-16)
- **Contexto**: até esta etapa a "versão corrente" era implícita — o maior `model_versions.id`
  (`ORDER BY id DESC LIMIT 1`, em `assetDatabase.getAssetByGuidLatest`). Isso tornava
  corrente qualquer versão acabada de inserir, incluindo versões com inventário vazio
  (P13) ou falhadas, e impedia distinguir "última criada" de "última válida".
- **Decisão**: coluna `models.current_version_id` (FK para `model_versions.id`,
  `ON DELETE SET NULL`), atualizada apenas na ativação, dentro da mesma transação que
  marca a nova versão `active` e arquiva a anterior.
- **Alternativas rejeitadas**:
  - *flag `is_current` em model_versions*: exige constraint condicional para garantir
    unicidade, que o MySQL não tem nativamente;
  - *manter maior-id*: não permite `processing`/`failed` sem os expor como correntes.
- **Garantias**: no máximo uma corrente por model (coluna única); a corrente pertence ao
  mesmo model (a ativação verifica `model_id`); `failed`/`archived`/`active` nunca são
  reativáveis — só `processing` pode ser ativada; a troca acontece apenas após
  processamento completo.
- **Nota sobre a referência mútua** models ↔ model_versions: não há ciclo na criação
  porque `current_version_id` é NULL até a primeira ativação (INSERT model → INSERT
  version → UPDATE model).
