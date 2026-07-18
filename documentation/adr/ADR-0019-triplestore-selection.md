# ADR-0019 — Seleção do triplestore: Apache Jena Fuseki

- **Estado**: aceite (Prompt 5A, 2026-07-17; decisão confirmada pela autora
  do projeto após auditoria)
- **Contexto**: a auditoria do Prompt 5A confirmou que NENHUM triplestore
  tinha sido escolhido formalmente (BASELINE §5.6: "não existe nada no
  código"; nenhum ADR, config, Docker ou dependência anterior). Não há
  Docker na máquina de desenvolvimento; há OpenJDK 17 (Temurin).

## Decisão

```text
Triplestore do projeto: Apache Jena Fuseki 5.x
Execução local: distribuição standalone com versão FIXADA (5.6.0),
descarregada e verificada (SHA512) por infrastructure/graph/setup-fuseki.ps1.
```

Fatores decisivos (comparados apenas os requisitos relevantes, contra
Oxigraph e GraphDB Free):

- SPARQL 1.1 Query + Update + Graph Store Protocol completos, com named
  graphs — exatamente a superfície que o `GraphClient` abstrai;
- corre hoje na máquina de desenvolvimento (zip + Java 17, sem Docker);
- autenticação básica (Shiro) — as variáveis GRAPH_USERNAME/PASSWORD têm
  efeito real (Oxigraph não tem autenticação);
- múltiplos datasets num só serviço → separação obrigatória entre
  `/oswadt-dev` (TDB2, persistente) e `/oswadt-test` (memória);
- padrão de facto na comunidade Linked Building Data / académica, alinhado
  com futuras ferramentas (ifcOWL, BOT, IDS→SHACL).

## Infraestrutura reproduzível

- `infrastructure/graph/setup-fuseki.ps1` — download fixado + SHA512;
- `infrastructure/graph/start-fuseki.ps1` — arranque na porta 3030 com
  `config/oswadt-fuseki.ttl` (datasets dev/test) e `config/shiro.ini`
  (credenciais de DESENVOLVIMENTO documentadas: admin/oswadt-dev-graph;
  Shiro sem sessões — o Jetty do Fuseki 5 não tem SessionManager);
- `dist/` e `run/` estão no .gitignore — nada descarregado ou gravado pelo
  serviço é versionado; nenhum dado de produção existe no serviço.
- Docker fica como alternativa futura documentada (imagem oficial com a
  mesma versão fixada) para máquinas com Docker disponível.

## Consequências

- O cliente Node usa apenas HTTP/fetch nativo — ZERO dependências npm novas.
- A implementação concreta (`SparqlHttpGraphClient`) fala protocolo SPARQL
  1.1 genérico; trocar de triplestore no futuro = novo provider no registry
  (`GRAPH_PROVIDER`), sem alterações no resto da aplicação.
- O health check usa `ASK {}` (portável) e não o endpoint administrativo
  `/$/ping` do Fuseki, para não acoplar o contrato ao produto.
