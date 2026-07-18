# ADR-0020 — Estratégia de URIs semânticas

- **Estado**: aceite (Prompt 5A, 2026-07-17)
- **Contexto**: o grafo precisa de URIs estáveis para as identidades
  persistentes do projeto. As identidades SQL (auto-increment) não são
  globais nem estáveis entre ambientes; a localização de um ativo muda.

## Decisão

Base configurável `GRAPH_BASE_URI` (dev: `http://oswadt.local/id`; a base
de produção será decidida quando existir publicação real). Padrões, gerados
EXCLUSIVAMENTE por `back/graph/semanticUriFactory.ts`:

```text
{base}/linked-model/{linkedModelStableId}
{base}/model/{modelStableId}
{base}/model-version/{modelVersionStableId}
{base}/entity/{modelVersionStableId}/{entityStableToken}
{base}/space/{spaceUuid}
{base}/asset/{assetUuid}
{base}/location-assignment/{assignmentUuid}
{base}/provenance-activity/{activityUuid}
{base}/validation-result/{resultUuid}
```

Regras:

- **identidade persistente, nunca localização**: a URI de um ativo é função
  APENAS de `asset_uuid`. Nunca contém espaço, binding, versão de modelo,
  coordenadas ou nome — mesmo equipamento noutro espaço = mesma URI
  (ADR-0023 trata a localização como recurso separado);
- **entities e model versions são as únicas URIs com contexto de versão**
  (uma entity é um snapshot de uma model_version concreta);
- URIs determinísticas; segmentos codificados (encodeURIComponent); a
  fábrica não consulta a base de dados e não decide domínio;
- um id SQL auto-increment isolado é REJEITADO como identidade global
  (guarda na fábrica);
- `spaces.space_uuid` e `assets.asset_uuid` já existem e são usados;
  **lacuna documentada**: linked_models, models, model_versions e entities
  ainda não têm UUID — as funções aceitam um identificador estável fornecido
  pelo chamador; a migration de UUIDs será feita quando o Prompt 5B precisar
  de materializar grafos de versão (sem migration ampla antecipada);
- nesta etapa NENHUMA URI de produção é gravada: `spaces.semantic_uri` e
  `assets.semantic_uri` permanecem NULL (sem backfill; guarda automatizada
  verifica que nenhum código escreve semantic_uri), nenhuma URI é exigida
  para upload ou reservas.
