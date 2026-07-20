# Roteiro de Demonstração para o Orientador — 10–15 min (Prompt 6)

Cenário pequeno e reproduzível que percorre o framework inteiro: identidade
persistente sob nova versão IFC, ativo não modelado com grafo como autoridade,
falha/recuperação e concorrência. Tempos estimados por secção; plano B no fim.

## Pré-preparação (antes da sessão, ~10 min, não conta no tempo)

1. Serviços ligados (4 terminais):
   ```powershell
   cd back; npm run dev                                  # :3001
   cd front; npm run dev                                 # :3000
   cd python; python app.py                              # :3002 (Flask/IfcOpenShell)
   powershell -File infrastructure/graph/start-fuseki.ps1  # :3030
   ```
2. `back/.env` com DB_* e GRAPH_* preenchidos (password real do Fuseki dev).
3. Dois ficheiros IFC4 preparados (V1 e V2) com:
   - **V1**: ≥2 IfcSpace com `Pset_SpaceCommon.Reference` = `R-101`, `R-102`;
     um equipamento com `Tag = EQP-DEMO-1` dentro de R-101; (opcional) um
     IfcBuildingElementProxy válido.
   - **V2**: os MESMOS Reference e a MESMA Tag, mas **GUIDs diferentes**, nome
     do equipamento alterado e o equipamento movido para R-102.
   (Os IFC de teste dos prompts anteriores servem — ver MANUAL_TESTS.)
4. Bruno aberto na coleção `back/bruno_collection` (pastas NonModelled e afins).
5. Base limpa de dados de demonstrações anteriores (se necessário):
   `cd back && npx tsx scripts/cleanupNonModelledGraphData.ts` (só universo 5B).

## 18.1 IFC V1 — upload e identidades (≈2 min)

- Front (`http://localhost:3000`) → upload de V1 (novo modelo numa federação).
- Mostrar no viewer os espaços e o equipamento.
- SQL (mostrar identidade persistente):
  ```sql
  SELECT id, space_uuid, inventory_code, status FROM spaces;
  SELECT id, asset_uuid, asset_code, lifecycle_status FROM assets WHERE asset_code='EQP-DEMO-1';
  SELECT id, model_version_id, ifc_guid, space_id FROM asset_bindings;
  ```
- Ponto a narrar: `Reference` identifica o espaço; `Tag EQP-` identifica o
  equipamento; GUID é só rastreabilidade por versão.

## 18.2 Reserva (≈2 min)

- Bruno/curl:
  ```http
  POST http://localhost:3001/api/reservation/request
  { "assetId": <id do EQP-DEMO-1>, "actorId": "estudante-demo",
    "startTime": "<amanhã 10:00>", "endTime": "<amanhã 12:00>" }
  ```
- Mostrar a linha criada (status `pending`) e os SNAPSHOTS:
  ```sql
  SELECT id, asset_id, status, asset_binding_id_at_booking,
         model_version_id_at_booking, space_code_snapshot
  FROM res_reservations ORDER BY id DESC LIMIT 1;
  ```

## 18.3 IFC V2 — identidade sobrevive; reserva preservada (≈3 min)

- Upload de V2 para o MESMO modelo.
- Mostrar:
  ```sql
  SELECT current_version_id FROM models WHERE id=<modelId>;      -- nova versão
  SELECT id, asset_uuid FROM assets WHERE asset_code='EQP-DEMO-1'; -- MESMO id/uuid
  SELECT model_version_id, ifc_guid, space_id FROM asset_bindings
   WHERE asset_id=<assetId> ORDER BY model_version_id;           -- binding NOVO, GUID novo, espaço novo
  SELECT id, status, space_code_snapshot FROM res_reservations
   WHERE asset_id=<assetId>;                                     -- reserva INTACTA (snapshot antigo)
  ```
- Provar o conflito preservado: repetir o POST de 18.2 com o mesmo intervalo e
  outro startTime sobreposto pelo MESMO ator → erro de sobreposição
  (continuidade por asset_id, mesmo com o equipamento noutra sala).

## 18.4 Ativo não modelado — grafo autoridade (≈3 min)

- Registar (Bruno "Register non-modelled asset"):
  ```http
  POST /api/asset/non-modelled
  { "registrationKey": "demo-proj-1", "name": "Projetor portátil DEMO",
    "assetType": "PortableEquipment", "resourceKind": "equipment",
    "initialSpaceId": <id de R-101> }
  ```
- Mostrar a URI no Fuseki (`http://localhost:3030` → dataset oswadt-dev → query):
  ```sparql
  SELECT ?p ?o WHERE { GRAPH <http://oswadt.local/id/graph/operational>
    { <URI-do-ativo> ?p ?o } }
  ```
- Mostrar a projeção SQL (`SELECT * FROM assets WHERE source='graph'`) e a
  localização (`GET /api/asset/non-modelled/:id/projection-status`).
- Mover: `POST /api/asset/non-modelled/:id/location`
  `{ "movementKey": "demo-mv-1", "newSpaceId": <R-102> }` → histórico:
  `GET /api/asset/non-modelled/:id/location-history` (2 entradas, 1 corrente).
- Idempotência ao vivo: repetir o POST de registo com a MESMA registrationKey →
  mesma resposta, `attemptCount` inalterado, nada duplicado.
- (Provider allow, se configurado para a demo) criar reserva do ativo →
  `POST /api/reservation/request` com o assetId da projeção.

## 18.5 Falha e recuperação (≈3 min)

1. Parar o Fuseki (Ctrl-C no terminal do start-fuseki).
2. `POST /api/asset/non-modelled` com chave nova → **503 controlado**; mostrar
   `GET /api/asset/...` de MODELADOS e o viewer a funcionar normalmente.
3. Registo que ficou pendente: `SELECT operation_uuid, status, attempt_count
   FROM semantic_sync_operations ORDER BY id DESC LIMIT 1;` (failed_retryable).
4. Reiniciar o Fuseki; retry:
   `POST /api/semantic/sync/<operationId>/retry` → completed; attempt_count +1.
5. Reconciliação: `GET /api/semantic/reconciliation/report` (divergências → 0)
   e, se houver finding seguro, `POST /api/semantic/reconciliation/apply-safe`.

## 18.6 Concorrência (≈2 min)

```powershell
cd back
npx tsx scripts/concurrencyProbe.ts reservation <assetId-do-EQP-DEMO-1>
```
Resultado no ecrã: 10 rondas de pares simultâneos, cada uma `accepted=1
rejected=1` — nunca duas aceites. (Extra, se sobrar tempo:
`npx tsx scripts/concurrencyProbe.ts idempotency` — 5 registos simultâneos com
a mesma chave convergem para um único ativo.)

## Plano alternativo (se um serviço falhar)

- **Flask/IfcOpenShell falha** → saltar 18.1–18.3 e usar um modelo já
  carregado (a demo 18.4–18.6 não depende do Flask); a falha de upload até
  DEMONSTRA a secção de recuperação (versão failed, corrente intacta).
- **Fuseki não arranca** → 18.4 vira 18.5: mostrar o 503 controlado + o resto
  da app intacto; retomar quando subir. (Lock TDB2: garantir que não há outra
  instância antiga a correr — `netstat -ano | findstr :3030`.)
- **Front falha** → tudo é demonstrável por Bruno/curl + SQL + Fuseki UI.
- **MySQL falha** → nada funciona: reiniciar o serviço MySQL (porta 3336) e
  recomeçar em 18.2 (os dados de 18.1 persistem).

Tempo total alvo: 15 min com folga de ~2 min.
