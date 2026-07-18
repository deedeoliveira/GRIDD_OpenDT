# ADR-0021 — Convenção de named graphs

- **Estado**: aceite (Prompt 5A, 2026-07-17)
- **Contexto**: sem convenção de named graphs, dados derivados de versões
  IFC diferentes, dados operacionais e dados de teste misturam-se e deixam
  de poder ser substituídos/apagados com segurança.

## Decisão

Convenções (relativas a `GRAPH_BASE_URI`; código em `back/graph/namedGraphs.ts`):

```text
{base}/graph/model-version/{modelVersionStableId}  dados derivados de UMA versão IFC
{base}/graph/operational                            futuro: ativos não modelados,
                                                    localização, proveniência (5B)
{base}/graph/vocabularies                           futuro: ontologias/vocabulários
{base}/graph/validation                             futuro: resultados de validação
{base}/graph/test/{testRunUuid}                     grafos de teste, um por execução
```

Regras:

- o grafo de versão usa a identidade da **model_version** (nunca apenas
  model_id) e nunca mistura versões;
- só versões `active` ou `archived` podem materializar grafo de produção;
  `processing` e `failed` nunca (`canMaterializeModelVersionGraph`);
- nenhum grafo de produção é criado nesta etapa; `operational`,
  `vocabularies` e `validation` são convenções RESERVADAS (nenhuma ontologia
  carregada; resultados atuais de policy/preflight NÃO vão para RDF);
- cada teste/smoke usa `graph/test/{uuid}` novo e apaga APENAS o seu grafo.

## Guardas (pós-incidente de storage)

- `CLEAR/DROP ALL|NAMED|DEFAULT` são recusados SEMPRE pelo cliente
  (`assertSparqlUpdateAllowed`) — a limpeza global não existe como operação;
- com `NODE_ENV=test`, `deleteGraph` só aceita URIs do namespace de teste
  (`assertGraphDeletable`) e a configuração recusa endpoints não-locais;
- o dataset de teste (`/oswadt-test`, memória) é separado do de
  desenvolvimento (`/oswadt-dev`, TDB2) — nunca partilham dados.
