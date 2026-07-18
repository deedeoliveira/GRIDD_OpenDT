# PROMPT 5A — Fundação do grafo semântico, identificadores e autoridade dos dados

Data: 2026-07-17. Estado: implementado e verificado (306/306 testes; smoke
real contra Fuseki local). Âmbito: APENAS fundação técnica — nenhum dado de
produção foi escrito no grafo, nenhuma URI foi gravada em SQL, nenhum fluxo
operacional passou a depender do grafo.

> Distinções deste documento: **comportamento verificado** (secções 1–10),
> **introduzido nesta etapa** (tudo em `back/graph/`, `infrastructure/graph/`,
> testes `tests/graph/`), **planeado para o futuro** (marcado "5B/futuro"),
> **decisões por resolver** (secção 11).

## 1. Auditoria e serviço escolhido

Auditoria (2026-07-17): nenhum triplestore anterior, nenhuma referência
RDF/SPARQL ativa no código (apenas guardas negativas), nenhum Docker no
repositório nem na máquina; OpenJDK 17 presente; `spaces.semantic_uri` e
`assets.semantic_uri` existentes e sempre NULL; `space_uuid`/`asset_uuid`
existentes; sem UUID em linked_models/models/model_versions/entities
(lacuna documentada em ADR-0020).

**Serviço**: Apache Jena Fuseki **5.6.0** (ADR-0019), standalone com versão
fixada e verificação SHA512. Evidência de funcionamento: smoke completo
(health, PUT, SELECT, UPDATE, DELETE isolado) executado com sucesso em
2026-07-17 contra o dataset `/oswadt-test`, com autenticação básica ativa
(pedido sem credenciais → HTTP 401).

## 2. Execução local

```powershell
powershell -ExecutionPolicy Bypass -File infrastructure\graph\setup-fuseki.ps1   # uma vez
powershell -ExecutionPolicy Bypass -File infrastructure\graph\start-fuseki.ps1   # porta 3030
```

- datasets: `/oswadt-dev` (TDB2, persistente em `run/databases/`) e
  `/oswadt-test` (memória, perde tudo ao reiniciar) — NUNCA partilham dados;
- credenciais de desenvolvimento (locais, documentadas): `admin` /
  `oswadt-dev-graph` (`infrastructure/graph/config/shiro.ini`; Shiro sem
  sessões — o Jetty do Fuseki 5 não tem SessionManager);
- health: `http://localhost:3030/$/ping` (anónimo) — o cliente Node usa
  `ASK {}` autenticado, portável entre triplestores;
- `dist/` e `run/` são gitignored; nenhum dado de produção existe no serviço;
- scripts .ps1 em ASCII puro (PowerShell 5.1 lê .ps1 sem BOM como ANSI).

## 3. Configuração (backend)

Variáveis (ver `back/.env.example`; grafo OPCIONAL — sem elas a aplicação
funciona; carregamento lazy — nada é validado no arranque):

```text
GRAPH_PROVIDER=fuseki            GRAPH_USERNAME=admin
GRAPH_QUERY_ENDPOINT=...         GRAPH_PASSWORD=***  (nunca em logs/erros)
GRAPH_UPDATE_ENDPOINT=...        GRAPH_REQUEST_TIMEOUT_MS=10000
GRAPH_DATA_ENDPOINT=...          GRAPH_BASE_URI=http://oswadt.local/id
```

Validação explícita em `back/graph/graphConfig.ts`: ausência total →
`{configured:false}` (inofensivo); configuração parcial/inválida →
`graph_configuration_error` com mensagem clara; base URI http(s) sem
query/fragmento; timeout inteiro positivo; username/password em par;
`NODE_ENV=test` exige endpoints locais.

## 4. Cliente de grafo

- contrato `GraphClient` (`back/graph/graphTypes.ts`): healthCheck,
  putGraph, query, update, deleteGraph; cancelamento por AbortSignal;
- implementação `SparqlHttpGraphClient` (`sparqlHttpGraphClient.ts`):
  SPARQL 1.1 Query/Update + Graph Store Protocol sobre fetch nativo (zero
  dependências npm); autenticação básica; timeout por pedido; sem retry
  implícito; logs estruturados `graph_operation` SEM credenciais, SEM texto
  SPARQL e SEM payload RDF;
- provider central `graphClientProvider.ts` (`GRAPH_PROVIDER`, default
  fuseki; `setGraphClient`/`resetGraphClient` para testes) — mesmo padrão
  dos restantes providers; NENHUM fetch SPARQL fora de `back/graph/`;
- erros tipados (`GraphError`): `graph_not_configured`, `graph_unavailable`,
  `graph_timeout`, `graph_authentication_failed`, `graph_query_failed`,
  `graph_update_failed`, `graph_invalid_response`,
  `graph_configuration_error`.

## 5. URIs e named graphs

Ver ADR-0020 (estratégia de URIs; fábrica `semanticUriFactory.ts`) e
ADR-0021 (named graphs; `namedGraphs.ts`). Pontos-chave:

- URI de ativo = função APENAS de `asset_uuid` — sem espaço, binding,
  versão ou coordenada; mesma URI quando o equipamento muda de espaço;
- entity/model-version são as únicas URIs com contexto de versão;
- id SQL auto-increment isolado é rejeitado como identidade global;
- grafos: `graph/model-version/{id}`, `graph/operational` (5B),
  `graph/vocabularies` (futuro), `graph/validation` (reservado),
  `graph/test/{uuid}` (um por execução);
- versões `processing`/`failed` nunca materializam grafo.

## 6. Matriz de autoridade

A matriz completa e o princípio ("cópia RDF ≠ autoridade") estão em
**ADR-0022**. Resumo operacional: IFC imutável = autoridade do conteúdo da
versão; SQL = autoridade de versão corrente, espaços, ativos, bindings,
reservas/conflitos; grafo = SEM autoridade nesta etapa; no 5B passará a ser
autoridade da existência/tipo/localização de ativos NÃO modelados, com
projeção SQL operacional.

## 7. Identidade vs localização; movimento de equipamentos

- Ativos MODELADOS: autoridade da localização = asset_binding da versão
  corrente (`models.current_version_id`). Nova versão que move o
  equipamento: mesmo asset_id, mesma URI, novo binding com novo space_id,
  binding antigo preserva a localização histórica, reservas continuam no
  mesmo asset_id, snapshots de reservas não são reescritos. Nenhuma coluna
  permanente de localização concorre com os bindings.
- Ativos NÃO MODELADOS (5B/futuro): grafo operacional = autoridade da
  existência/tipo/localização; SQL = projeção para reservas. Contratos já
  preparados (ADR-0023): mudança de localização preserva identidade/URI,
  encerra a atribuição anterior, cria nova com tempo/fonte/proveniência,
  atualiza depois a projeção SQL, nunca cria novo asset.
- Sensores (futuro): observação bruta ≠ inferência ≠ atribuição validada ≠
  projeção corrente; nenhuma observação substitui automaticamente a
  localização operacional sem regra explícita de validação e autoridade.

## 8. Isolamento de falhas (verificado)

- guarda automatizada: NENHUM módulo operacional (serviços, rotas, utils,
  políticas, identidade, classificação, requisitos, index) importa
  `back/graph/`, fala SPARQL ou lê GRAPH_* — logo grafo indisponível, lento,
  mal configurado ou vazio NÃO afeta upload, preflight, reservas, viewer,
  sensores, APIs nem políticas, não altera `current_version_id`, não
  modifica bindings, não duplica assets; sem dual-write, sem retry
  implícito;
- runtime: os 253 testes pré-existentes correm TODOS sem grafo configurado;
  sem GRAPH_*, só `getGraphClient()` explícito falha
  (`graph_not_configured`);
- a camada de políticas tem guarda própria: o GraphClient não é provider de
  política.

## 9. Segurança dos testes (preservada e estendida)

Todas as proteções pós-incidente de storage mantidas (storage temporário,
guardas do reset). Novas guardas do grafo: dataset de teste isolado em
memória; named graph único por execução (`graph/test/{uuid}`); limpeza
apaga apenas o próprio grafo; `CLEAR/DROP ALL|NAMED|DEFAULT` recusados
sempre; `NODE_ENV=test` → endpoints obrigatoriamente locais e deleteGraph
restrito ao namespace de teste; credenciais de fixtures são fictícias; os
testes de grafo usam fetch injetado (nenhum serviço real é contactado);
nenhum reset de base e nenhum ficheiro IFC tocado.

## 10. Smoke e testes

- `back/scripts/graphSmoke.ts` (CLI): health → PUT grafo de teste (recursos
  fictícios marcados) → SELECT → UPDATE isolado → DELETE do próprio grafo →
  confirmação de vazio. Executado com sucesso contra Fuseki 5.6.0 local.
- 53 testes novos em `back/tests/graph/` (config, cliente, named graphs,
  URIs, contratos de localização, isolamento). Suíte total: **306/306**.
- Roteiro manual: `MANUAL_TESTS.md` §19.

## 11. Limites desta etapa / deliberadamente NÃO implementado

Sem: registo definitivo de ativos não modelados; projeção grafo–SQL;
atualização de localização por sensores; ingestão de observações;
IFC-to-RDF; ontologia definitiva; SHACL; validação ontológica; provider
ontológico de reservabilidade; IDS (upload/armazenamento); sincronização de
produção; UI; alterações a reservas/aprovação por gestor; correção de P14;
remoção do esquema legado; backfill de URIs; dual-write; grafos de
produção. Decisões por resolver (para 5B+): base URI de produção; migration
de UUIDs para modelos/versões/entities; direção e reconciliação da projeção
grafo→SQL; precedência sensor vs IFC; vocabulário/ontologia e mapeamento
IFC→RDF; eventual autenticação por papel no Fuseki.
