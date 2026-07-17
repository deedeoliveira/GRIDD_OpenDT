# ADR-0010 — Identidade persistente de ativos com bindings por versão

- **Estado**: aceite (Prompt 4, 2026-07-17)
- **Contexto**: até ao Prompt 3, cada versão de modelo criava as SUAS linhas
  em `assets` (FK `model_version_id`). Uma nova versão IFC criava novas
  identidades operacionais para os mesmos recursos físicos, quebrando a
  continuidade de reservas, histórico e ligação a sensores.
- **Decisão**:
  - `assets` passa a guardar **identidades persistentes**: `asset_uuid`,
    `asset_code` (código institucional/serial), `space_id` (para
    ativos-espaço), `linked_model_id` (âmbito da federação),
    `lifecycle_status`, projeção operacional (`name`, `reservable`).
    `model_version_id` fica NULLABLE e é NULL nas linhas persistentes
    (expand-and-contract; as colunas legadas não são removidas nesta etapa);
  - `asset_bindings` regista **como cada versão representa** cada ativo:
    (`asset_id`, `model_version_id`, `model_entity_id`, `space_id`,
    `ifc_guid`, snapshots de nome/tipo/código, método e confiança da
    reconciliação). UNIQUE (`asset_id`,`model_version_id`) e UNIQUE
    (`model_entity_id`);
  - quatro responsabilidades mantidas separadas: **identidade** (quem é),
    **binding** (como aparece numa versão), **localização** (onde está —
    atributo do binding), **reservabilidade** (política; projeção).
- **Consequências**:
  - um upload de nova versão liga entities novas a ativos EXISTENTES; o
    `asset_id` é estável e as reservas sobrevivem a versões;
  - o viewer resolve GUID→ativo via binding da versão corrente explícita
    (`models.current_version_id`), nunca por `ORDER BY id DESC`;
  - linhas legadas (com `model_version_id` e sem `asset_uuid`) ficam fora
    das consultas novas até o backfill as promover/mapear (ADR: ver
    `PROMPT4_ASSETS.md` §backfill).
