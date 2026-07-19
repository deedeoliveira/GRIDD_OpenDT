# ADR-0026 — Grafo como autoridade e SQL como projeção (ativos não modelados)

- **Estado**: aceite (Prompt 5B, 2026-07-18). Concretiza para os ativos NÃO
  modelados as linhas "futuro" da matriz do ADR-0022 (que permanece válido).
- **Contexto**: os ativos não modelados nascem fora do IFC; o Prompt 5A
  reservou o grafo operacional como autoridade futura desse domínio.

## Decisão

```text
Grafo operacional ({base}/graph/operational)
= autoridade da existência semântica, identidade (UUID/URI), código
  opcional, tipo, resource kind, origem, localização corrente, histórico
  de localização e proveniência dos ativos NÃO modelados.

SQL = projeção operacional: listagem, estado, ciclo de vida,
  reservabilidade projetada, localização corrente projetada, reservas.
```

- uma linha SQL com `source='graph'` NÃO é prova suficiente de existência
  semântica (a reconciliação deteta `sql_projection_missing_graph_asset` e
  exige decisão humana);
- a projeção conserva: semantic_uri, asset_uuid, origem, estado de
  sincronização (semantic_sync_operations), lifecycle, decisão de
  reservabilidade e ligação à localização projetada;
- SQL continua autoridade TRANSACIONAL de reservas/conflitos/estados/
  checkout/overdue/snapshots (nada disto vive no grafo); o Fuseki NUNCA é
  consultado ao criar/cancelar/consultar reservas;
- o frontend nunca escreve diretamente no grafo nem no SQL de projeção —
  toda a alteração passa pelos serviços de aplicação (registo/movimento/
  reconciliação), guarda automatizada nos testes;
- escrita no grafo: apenas `INSERT DATA` dirigido às URIs da operação —
  nunca putGraph do grafo operacional inteiro, nunca DELETE de recursos
  alheios; o grafo operacional nunca é apagável por deleteGraph
  (guarda em namedGraphs.ts);
- ativos MODELADOS ficam fora: não são escritos no grafo nesta etapa e a
  sua localização continua nos bindings IFC.

## Segurança em produção

Escritas operacionais em NODE_ENV=production exigem
(`assertOperationalGraphWriteSafety`): base URI explícita não-*.local,
GRAPH_USERNAME/PASSWORD presentes e diferentes das credenciais default de
desenvolvimento — falha ANTES de escrever.
