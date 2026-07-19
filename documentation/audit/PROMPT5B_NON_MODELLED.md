# PROMPT 5B — Ativos não modelados: grafo como autoridade, SQL como projeção

Data: 2026-07-18. Estado: implementado; testes automatizados 379/379;
statements SPARQL validados contra Fuseki 5.6.0 real (dataset de teste,
grafo `graph/test/`, limpo no fim); **verificação manual pendente**
(MANUAL_TESTS §20). Nenhum dado de produção foi escrito no grafo
operacional; nenhum backfill executado.

## 1. Objetivo e âmbito

Ativos SEM representação IFC passam a poder ser registados, localizados,
movidos e reservados. Para eles: **grafo operacional = autoridade**
(existência, identidade, tipo, localização, histórico, proveniência);
**SQL = projeção operacional** (reservas, conflitos, listagens, UI);
entities e asset_bindings **não se aplicam**. Ativos modelados ficam
intocados (não migrados, não escritos no grafo).

Fora do âmbito (deliberado): IFC-to-RDF, named graphs de versões IFC,
IFC-OWL/BOT/Brick/SAREF, ontologia definitiva, alinhamentos, SHACL,
provider ontológico de políticas, validação semântica, IDS, ingestão de
sensores, inferência/atualização automática de localização, UI de gestão,
aprovação por gestor, robustez final de concorrência, remoção do esquema
legado, P14. **IFC-to-RDF mapping and ontology selection are outside
Prompt 5B.**

## 2. Vocabulário operacional mínimo (ADR-0024)

`back/graph/operationalVocabulary.ts` — namespace versionado
`{base}/vocab/operational-v1#`; classes NonModelledAsset /
LocationAssignment / RegistrationActivity / LocationChangeActivity;
propriedades assetUuid, assetCode, displayName, assetType, resourceKind,
serialNumber, sourceSystem, registrationKey, hasLocationAssignment,
assignedAsset, assignedSpace, validFrom, validTo, observedAt,
assignmentSource, confidence, createdAt, provenanceActivity. Vocabulário
TÉCNICO e PROVISÓRIO — não é a ontologia da tese nem conversão do IFC; só
rdf:type e datatypes XSD além do namespace do projeto; nenhum termo IFC;
guarda automatizada contra strings RDF espalhadas. Nada foi carregado no
grafo de vocabulários (não é necessário nesta etapa).

## 3. Identidade (ADR-0025)

asset_uuid gerado no registo; URI `{base}/asset/{uuid}` (mesma fábrica do
5A — sem localização/versão/espaço/nome); managerCode OPCIONAL (sem regra
EQP-; unicidade provisória por código normalizado entre ativos
source='graph', verificada no serviço — lacuna de constraint documentada);
serial opcional e separado; Manufacturer/ObjectType ausentes; nenhum dado
IFC fabricado.

## 4. Estruturas SQL (migration 2026-07-17_non_modelled_assets.sql — aplicada à BD de dev)

- `assets.asset_subtype` (tipo livre); resource kind projetado no ENUM
  `asset_type` existente (equipment|tool); `source='graph'`;
  `semantic_uri`/`asset_uuid` conservados na projeção;
- `asset_location_assignments`: atribuições temporais; is_current DERIVADO
  de valid_to (coluna gerada); **UMA corrente por ativo garantida por
  UNIQUE (asset_id, current_marker)**; histórico nunca sobrescrito;
- `semantic_sync_operations`: workflow/idempotência/auditoria (ADR-0027);
- rollback (`_rollback.sql`): NÃO apaga reservas/modelados/espaços/IFCs/
  grafos; NÃO remove recursos RDF (o Fuseki fica com ativos sem projeção —
  detetável na reconciliação); perde irreversivelmente projeções e
  histórico de operações — só em ambiente descartável.

Excerto ER (novo, texto — não existe fonte editável de ER no repositório;
lacuna herdada):

```text
assets 1—N asset_location_assignments N—1 spaces
assets 1—N semantic_sync_operations (por asset_uuid, informativo)
res_reservations N—1 assets (inalterado; snapshots de booking preenchidos
                              a partir da localização projetada)
```

## 5. Fluxo de registo (ADR-0026/0027)

POST /api/asset/non-modelled → validação (nome, tipo, resourceKind,
código/serial opcionais, espaço inicial persistente e ATIVO) → operação
`pending_graph` → INSERT DATA dirigido no grafo operacional (ASK-guardado)
→ verificação por query (UUID + atribuição inicial) → `graph_written` →
política de reservabilidade pelo provider configurado (nunca
reservable=true fixo; allow ⇒ reservável, deny/undetermined/error ⇒ ativo
preservado NÃO reservável; com o provider legado o resultado é
`undetermined` DEFENSIVO — decisão de política para não modelados continua
por tomar, documentada) → projeção SQL transacional → `completed`.

Sem espaço inicial: registo semântico válido, estado operacional
`pending_location`, reservas bloqueadas, nenhuma localização inventada.

## 6. Movimento e histórico (ADR-0028)

POST /api/asset/non-modelled/:id/location — só ativos source='graph';
fonte apenas `manual` nesta etapa; espaço destino ativo; corrente segundo o
GRAFO (0 → recusa com diagnóstico; >1 → recusa até reconciliar); fecha a
anterior com validTo (inserção, nunca remoção), cria nova, verifica, projeta
em transação. Identidade e reservas intactas; snapshots de reservas nunca
reescritos. GET .../location-history devolve o histórico projetado.

## 7. Consistência distribuída e retries (ADR-0027)

Sem transação conjunta (nunca alegada). Grafo falha → nada projetado,
failed_retryable. SQL falha após grafo → pending_sql_projection, grafo
permanece autoridade, ativo não reservável. Verificação falha → não
projeta. Retry (mesma chave, POST /api/semantic/sync/:id/retry ou
apply-safe) reutiliza UUIDs/URIs, valida payload_hash, não duplica triplos
nem linhas, incrementa attempt_count, preserva erros sanitizados. Sem retry
automático/infinito (agendamento futuro documentado).

## 8. Reconciliação (ADR-0029)

GET /api/semantic/reconciliation/report (só leitura) e POST
.../apply-safe (idempotente; corrige APENAS: projeção ausente, localização
inequívoca, operações retomáveis). Conflitos de identidade, múltiplas
correntes no grafo e projeções órfãs são só reportados. O grafo nunca é
alterado pela reconciliação.

## 9. Reservas

SQL continua a autoridade; o Fuseki NUNCA é consultado em criação/
conflito/cancelamento/checkout/transições. Ativo não modelado reservável
⇔ projeção concluída (sem sync ops incompletas) + lifecycle active +
reservable=1 (allow) + localização corrente em espaço ATIVO. Falha
posterior do Fuseki não invalida projeções nem reservas existentes.
Preservados: overdue, checkout, cancelamento, validações de datas,
hasActorConflict, snapshots, ausência de aprovação por gestor, P14.

## 10. APIs e Bruno

/api/asset/non-modelled (POST), /:id (GET), /:id/projection-status (GET),
/:id/location (POST), /:id/location-history (GET);
/api/semantic/sync/:operationId/retry (POST);
/api/semantic/reconciliation/report (GET) e /apply-safe (POST).
Bruno: pasta `NonModelled` (8 pedidos). **Endpoints administrativos SEM
autenticação** — a aplicação não tem sistema de auth; nenhum foi
introduzido nesta etapa; risco documentado (uso local via Bruno/curl).

## 11. Dados legados (§16)

`scripts/reportNonModelledLegacy.ts` (READ-ONLY): classifica assets em
space_asset / modelled_asset / graph_projection /
possible_legacy_non_modelled / ambiguous_origin; tudo `not_migrated` —
nenhum backfill automático; migrar exigirá confirmação humana (nunca
inventar URI/identidade).

## 12. Segurança e isolamento

- Guardas 5A preservadas; novas: grafo operacional NUNCA apagável por
  deleteGraph (qualquer ambiente); CLEAR/DROP ALL|NAMED continuam
  proibidos; toda a remoção/alteração usa URI específica; produção exige
  base não-*.local + credenciais não-default ANTES de escrever (§17.3);
- SPARQL injection eliminada por construção (sparqlText.ts); limitação
  conhecida: a guarda anti-destrutiva do cliente pode rejeitar literais que
  contenham "DROP ALL" como texto (trade-off defensivo aceite);
- isolamento: só os 4 serviços 5B (lista fechada, testada) conhecem o
  grafo; upload/preflight/reservas/viewer/sensores/políticas continuam sem
  dependência; Fuseki parado impede APENAS operações explícitas de ativos
  não modelados; falhas de registo/movimento não tocam
  current_version_id/bindings/reservas;
- testes: BD falsa, grafo falso em memória (nenhum serviço real), storage
  temporário; a validação real usou o dataset /oswadt-test com grafo
  `graph/test/{uuid}` próprio, apagado no fim.

## 13. Limitações e itens futuros

Decisão de política de reservabilidade para não modelados por tomar
(undetermined defensivo até lá); autenticação administrativa inexistente;
constraint SQL de unicidade do managerCode adiada; scheduler de retry
futuro; fontes external_system/sensor_inference futuras; precedência
sensor/IFC futura; vocabulário provisório a alinhar com a ontologia da
tese; base URI de produção por aprovar; UUIDs de models/versions/entities
continuam em falta (5A) — necessários antes de grafos de versão.
