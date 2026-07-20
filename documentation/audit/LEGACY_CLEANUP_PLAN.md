# Plano de Cleanup do Legado — Prompt 6 (2026-07-18)

Auditoria do legado ainda existente após os Prompts 0–6. **NADA aqui foi
removido nesta etapa** — é um plano, com classificação e evidência. Nenhum
DROP TABLE/COLUMN, nenhum endpoint apagado, nenhuma migration removida,
nenhum ADR reescrito, nenhum backup tocado.

Classes: `remove_now` | `remove_after_demo` | `remove_after_semantic_migration`
| `keep_for_backward_compatibility` | `unknown_requires_evidence`.

## Colunas legadas

| Item | Classe | Evidência |
|---|---|---|
| `assets.model_entity_id` | keep_for_backward_compatibility | NULL para identidades P4/5B; FK antiga para entities; payloads antigos ainda a exibem. Remover exige migration destrutiva + revisão do front. |
| `assets.current_space_entity_id` | remove_after_demo | Sem leituras no backend (só um alias snapshot em assetDatabase vindo de binding); coluna real não é escrita desde P4. Confirmar front antes. |
| `assets.model_version_id` | keep_for_backward_compatibility | Ainda usada pelas compensações de upload (`DELETE FROM assets WHERE model_version_id`) para ativos pré-P4; FK com CASCADE. Reavaliar quando backfillAssets for aplicado. |
| `assets.space_id` (uso duplo: ativo-espaço P3 vs NULL nos 5B) | keep_for_backward_compatibility | Identidade dos ativos-espaço (UNIQUE uq_assets_space). Não é legado verdadeiro, mas o duplo papel merece documentação contínua. |
| `res_reservations.space_id_at_booking` etc. | keep (não é legado) | Snapshots são desenho intencional (ADR-0014). |

## Tabelas potencialmente redundantes

| Item | Classe | Evidência |
|---|---|---|
| `legacy_asset_mapping` | remove_after_semantic_migration | Só escrita por backfillAssets (`--apply` NUNCA executado). Se o backfill nunca for aplicado, remover tabela + script juntos. |
| `entities` (por versão) | keep_for_backward_compatibility | Base do inventário/viewer por versão; não é redundante hoje; poderá encolher quando a materialização RDF por versão existir (pós-migração semântica). |

## Endpoints e rotas de compatibilidade

| Item | Classe | Evidência |
|---|---|---|
| `GET /api/asset/:assetId/:versionId` (catch-all) e `by-space/by-model/by-guid` por versão | keep_for_backward_compatibility | Viewer/front dependem; payload inclui campos legados de propósito (comentário em assetDatabase). |
| `GET /api/asset/by-guid-latest/:modelId/:guid` | unknown_requires_evidence | Uso no front via /api/asset/by-guid-latest (proxy Next). Confirmar telemetria/uso real antes de mexer. |
| Rotas proxy do front (`front/app/api/*`) | keep_for_backward_compatibility | Padrão de acesso do front; revisão fora do âmbito backend. |

## Funções antigas / código morto

| Item | Classe | Evidência |
|---|---|---|
| `persistentAssetDatabase.createAsset/createBinding/markCaseResolved` (caminho não transacional) | remove_after_demo | A rota de resolução já usa `resolveCaseTransactionally`; `createAsset/createBinding` continuam usados pelo fluxo de upload (assetInventoryService) — só `markCaseResolved` isolado se tornará morto; verificar referências antes. |
| `sensorDatabase` interpolação de `channelId` no SQL (injeção potencial) | remove_now (corrigir, não remover) | Legado pré-P0; valores vêm de UI interna, mas deve passar a placeholders. Candidato a primeiro item do cleanup. |
| `SensorDatabase.cachedSensors` (cache em memória) | unknown_requires_evidence | Cache sem invalidação entre processos; inofensiva no protótipo. |

## Aliases de providers / fallbacks

| Item | Classe | Evidência |
|---|---|---|
| Provider legado `legacy` (reservability + request validator) | keep_for_backward_compatibility | É o default documentado; será substituído (não removido) quando existir provider semântico. |
| Fallback de snapshot de reserva para ativos sem binding | keep_for_backward_compatibility | Suporta ativos legados pré-P4 e não modelados. |

## Scripts de backfill temporários

| Item | Classe | Evidência |
|---|---|---|
| `scripts/backfillModelVersions.ts` | remove_after_demo | Aplicado no P2 (one-shot). Manter só como registo histórico ou remover com nota no README. |
| `scripts/backfillSpaces.ts` | remove_after_demo | Aplicado no P3; idempotente mas já sem uso previsto. |
| `scripts/backfillAssets.ts` | unknown_requires_evidence | NUNCA aplicado. Decidir: aplicar (e depois arquivar) ou abandonar (e remover com legacy_asset_mapping). |
| `scripts/seedSensorsData.ts` | remove_after_demo | Escreve dados fictícios; perigoso por engano; a demo não o usa. |

## Fixtures/documentação obsoletas

| Item | Classe | Evidência |
|---|---|---|
| `documentation/Comparison.md`, `WebLibraryComparison.md` | keep_for_backward_compatibility | Histórico de decisões antigas — documentação histórica nunca é reescrita (disciplina do projeto). |
| Documentos de auditoria por prompt (BASELINE, PROMPT2..6) | keep | Registo histórico obrigatório. |
| Vocabulário `operational-v1` | remove_after_semantic_migration | Provisório por desenho (ADR-0024); a migração ontológica cria o sucessor e um plano de migração de dados. |

## Regras para execução futura do plano

Só remover um item quando TODAS as condições valerem: código morto comprovado
(zero referências, `grep` + testes), sem função de rollback pendente, sem valor
histórico, com teste cobrindo a remoção, e sem migration destrutiva não
autorizada. Ordem sugerida: (1) correção da interpolação em sensorDatabase;
(2) `remove_after_demo` num commit próprio pós-demonstração; (3) decisão sobre
backfillAssets/legacy_asset_mapping; (4) `remove_after_semantic_migration`
apenas dentro do prompt de migração ontológica.
