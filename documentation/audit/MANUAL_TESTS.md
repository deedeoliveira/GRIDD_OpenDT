# Procedimento de teste manual

Documento vivo, organizado por etapa:
- **§0–§13**: procedimento da baseline (Prompt 0), com anotações posteriores;
- **§14 (Prompt 2)**: versionamento de modelos e ficheiros imutáveis;
- **§15 (Prompt 3)**: identidade persistente dos espaços — ⚠️ parcialmente
  substituída pela revisão (regra estrita); usa o roteiro atualizado do §16;
- **§16 (revisão do Prompt 3)**: spatial_preflight estrito + ambiente pós-reset.

Todos os caminhos, rotas e dados abaixo existem realmente no repositório.

## 0. Preparação da base de dados

1. MySQL a correr no host/porta do teu `back/.env` (`DB_HOST`/`DB_PORT`, ex.: localhost:3336), com a BD `digital_twin` criada.
2. Se a BD for nova, executa `database/create_tables.sql` (cria linked_models, models, sensors, channels, sensors_channels, sensors_data e povoa channels).
3. ⚠️ As tabelas `model_versions`, `entities`, `assets`, `res_reservations` **não têm DDL no repositório** — este teste assume que já existem na tua BD de desenvolvimento. Antes de qualquer teste guarda um backup para poderes restaurar no fim:
   ```bash
   mysqldump -h localhost -P 3336 -u <user> -p digital_twin > backup_baseline.sql
   ```

## 1. Inicialização dos serviços (3 terminais)

```bash
# Terminal 1 — backend Node (porta 3001)
cd back
npm run dev            # esperado: "Server is running on http://localhost:3001"

# Terminal 2 — serviço Python (porta 3002)
cd back/python
./venv/Scripts/activate
flask --app main run -p 3002   # esperado: "Running on http://127.0.0.1:3002"

# Terminal 3 — frontend (porta 3000)
cd front
npm run dev            # esperado: "Ready" em http://localhost:3000
```

Páginas úteis: `http://localhost:3000/viewer` (viewer original com sensores) e
`http://localhost:3000/student` (viewer de reservas). A raiz `/` é o boilerplate Next (comportamento atual).

## 2. Upload de um primeiro IFC (Bruno ou curl)

Com o Bruno aberto na coleção `back/bruno_collection` (environment "Digital twin web app"):

- Request **Models → Upload model**: define `file` para um IFC teu com IfcSpace
  (ex.: `G:\My Drive\PDEC - 2022_2026\5_Canadá\ModelosTeste\ModeloA.ifc`) e `name` (ex.: `ModeloA`). Envia.

Equivalente em curl:

```bash
curl -X POST http://localhost:3001/api/model/upload \
  -F "file=@/caminho/para/ModeloA.ifc" -F "name=ModeloA"
```

**Resultado esperado:** `201` com `{"data": {"id": <modelId>, "name": "ModeloA", "linkedParentId": <id>, "versionId": <versionId>, "message": "Model uploaded and inventory processed successfully"}}`.

Confirmação SQL (opcional):

```sql
SELECT * FROM models ORDER BY id DESC LIMIT 1;
SELECT * FROM model_versions ORDER BY id DESC LIMIT 1;
SELECT entity_type, COUNT(*) FROM entities WHERE model_version_id = <versionId> GROUP BY entity_type;
SELECT asset_type, COUNT(*) FROM assets WHERE model_version_id = <versionId> GROUP BY asset_type;
```

Esperado: 1 linha nova em models e model_versions; entities com `space` (nº de IfcSpace) e `element`; assets com `space` e `equipment` (sem sensores), todos `reservable = 1`. O ficheiro aparece em `back/cdn_resources/models/<modelId>.ifc`.

> 📌 *Nota histórica (Prompt 2):* desde o versionamento, o ficheiro passa a ficar em
> `models/<modelId>/versions/<versionId>/model.ifc` e a resposta inclui `versionNumber` — ver §14.

## 3. Atualização do mesmo modelo (2.ª versão)

Repete o Upload model acrescentando o campo `modelId` = `<modelId>` do passo 2.

> ⚠️ Usa um IFC **com IfcSpace**. Um IFC sem espaços cria silenciosamente uma versão
> com inventário vazio (P13 no BASELINE.md) e o passo 5 passa a mostrar
> "não pertence ao inventário" para todos os elementos. Se acontecer, faz nova
> atualização com o ficheiro correto (o anterior fica em `cdn_resources/models/archive/`).

**Esperado:** `200` com novo `versionId`; novas linhas em entities/assets para a nova versão (as antigas mantêm-se).

> 📌 *Nota histórica (Prompt 2):* o arquivamento por rename (`models/archive/...`)
> deixou de existir — cada versão tem o seu próprio ficheiro imutável; ver §14.

## 4. Visualização do modelo

1. Abre `http://localhost:3000/student`.
2. Accordion **Models** → clica no modelo (ex.: `ModeloA`).

**Esperado:** loading, depois o modelo 3D renderizado; árvore espacial no painel direito, já expandida.

## 5. Consulta de espaços/ativos + reserva

1. Duplo-clique num elemento do modelo (ex.: uma cadeira/mesa dentro de um espaço).
2. Accordion **Selected**: mostra Name/Tag/GUID.
   - Elemento inventariado → mostra `Asset ID: <n>` e botão **Reservar**.
   - Elemento fora do inventário → "Este elemento não pertence ao inventário e não pode ser reservado."
3. Clica **Reservar**, escolhe datas **futuras** (ex.: amanhã 09:00–12:00) e submete.

**Esperado:** mensagem de sucesso; SQL: `SELECT * FROM res_reservations ORDER BY id DESC LIMIT 1;` → `status = 'pending'`, `actor_id = 'pg202404'` (hardcoded no frontend).

Casos de erro a confirmar (via Bruno **Reservation → Request reservation** com `assetId` do passo anterior):
- `startTime` no passado → `400` "Cannot create reservation in the past".
- `endTime` ≤ `startTime` → `400` "End time must be after start time".
- Mesmo ator, mesmo intervalo repetido → `400` "You already have a reservation overlapping this period".

## 6. Minhas reservas

Accordion **Your Reservations** na página `/student`.

**Esperado:** a reserva criada aparece em **Pending** com o intervalo formatado.

## 7. Aprovação (não existe interface — via SQL)

```sql
UPDATE res_reservations SET status = 'approved' WHERE id = <reservationId>;
```

Recarrega `/student` → a reserva aparece em **Approved** com botão **Check-in**.

## 8. Check-in / Checkout

1. Para testar a janela: ajusta o início da reserva para agora:
   ```sql
   UPDATE res_reservations SET start_time = NOW(), end_time = DATE_ADD(NOW(), INTERVAL 2 HOUR) WHERE id = <reservationId>;
   ```
2. Botão **Check-in** → esperado: alert "Check-in successful"; reserva passa a **In Use** (`status='in_use'`, `checkin_time` preenchido).
3. Fora da janela (start_time a mais de 20 min no futuro) → esperado: alert "Check-in not allowed: outside allowed time window or no approved reservation".
4. Botão **Checkout** → esperado: "Checkout successful"; reserva passa a **Finished** (`status='completed'`).
5. Reserva com check-in cujo período já terminou sem checkout: passa automaticamente a
   `status='overdue'` (na próxima operação de reservas) e aparece na secção **In Use**
   com a etiqueta "Reserva terminada — checkout pendente"; o botão **Checkout** continua
   disponível e leva a `completed`.

## 9. Cancelamento (só via Bruno/curl — sem botão na UI)

Bruno **Reservation → Cancel reservation** com `{ "reservationId": <id>, "actorId": "pg202404" }`.

- Reserva `pending` → `200` "Reservation cancelled" **a qualquer momento** (mesmo <24h do início).
- Reserva `approved` com início **no futuro** a menos de 24h → `400` "Cancellation allowed only up to 24h before start time" (a regra das 24h só se aplica a aprovadas).
  ⚠️ Se o início já tiver passado há >10 min sem check-in, a reserva converte-se primeiro
  em `no_show` e a resposta passa a ser "Reservation cannot be cancelled" — usa uma
  reserva com início futuro (ex.: `NOW() + INTERVAL 2 HOUR`) para ver a mensagem das 24h.
- `actorId` diferente → `400` "Not authorized to cancel this reservation".

## 10. Sensores

1. Se o IFC tiver sensores (IFC4: IfcSensor): Bruno **Models → Process model's spaces and sensors** (`GET /api/model/process/<modelId>`) → esperado: `200` com `createdSensors`; linhas novas em `sensors` + `sensors_channels`.
2. Seed de dados: `cd back && npx tsx scripts/seedSensorsData.ts` → "Mock sensor data inserted successfully." (24h de dados por sensor).
3. Abre `http://localhost:3000/viewer`, seleciona o modelo, abre o accordion **Sensors** → clica num sensor → esperado: modal com gráfico de temperatura.
4. No campo "Date and time" escolhe uma hora dentro das últimas 24h → esperado: espaços coloridos (verde/laranja/vermelho consoante a temperatura média do bin).

## 11. Disponibilidade (API)

```bash
curl "http://localhost:3001/api/asset/availability/<assetId>?start=2026-08-01T10:00:00&end=2026-08-01T12:00:00"
```

(Também disponível no Bruno: **Reservation → Asset avaiability** — a URL só leva `:assetId`, sem `:versionId`.)

**Esperado:** `{"data": {"available": true, "conflicts": []}}` se não houver reserva
`approved`/`in_use` sobreposta; caso contrário `available: false` com os ids em conflito.
Com `end ≤ start` → `400 "End time must be after start time"`; com início no passado →
`400 "Cannot create reservation in the past"`; datas inválidas → `400`.
Nota: reservas `pending` não afetam este endpoint (comportamento atual).

## 12. Testes automatizados

```bash
cd back && npm test        # 40 testes de caracterização (sem BD real)
cd back && npm run build   # typecheck limpo
cd front && npm run build  # build de produção limpo
```

## 13. Restaurar o estado inicial (opcional)

Só é relevante se quiseres repetir o procedimento do zero ou comparar resultados entre
execuções — numa BD que só tem dados de teste, **podes simplesmente manter tudo**.

```bash
mysql -h localhost -P 3336 -u <user> -p digital_twin < backup_baseline.sql
```

E apaga os ficheiros criados durante o teste: `back/cdn_resources/models/<novoModelId>.ifc`
e o conteúdo novo de `back/cdn_resources/models/archive/`.

---

## 14. Prompt 2 — Versionamento de modelos e ficheiros imutáveis

### 14.0 Preparação

1. Migrations (já aplicadas na BD de dev em 2026-07-16; numa BD nova, por ordem):
   ```bash
   cd back
   npx tsx scripts/runSqlFile.ts ../database/migrations/2026-07-15_add_overdue_status.sql
   npx tsx scripts/runSqlFile.ts ../database/migrations/2026-07-16_model_versioning.sql
   npx tsx scripts/backfillModelVersions.ts            # relatório
   npx tsx scripts/backfillModelVersions.ts --apply    # aplicação (idempotente)
   ```
2. MySQL a correr (como na §0); backup opcional: `mysqldump ... > backup_prompt2.sql`.
3. Serviços (⚠️ reinicia o backend para carregar o código novo):
   `back: npm run dev` · `back/python: flask --app main run -p 3002` · `front: npm run dev`.
4. Ficheiro necessário: um IFC com IfcSpace (ex.: o ModeloA da baseline).

### 14.1 Primeiro upload (novo modelo lógico)

5. Bruno **Models → Upload model** (file + name=`ModeloV2Teste`, sem modelId) ou:
   ```bash
   curl -X POST http://localhost:3001/api/model/upload -F "file=@ModeloA.ifc" -F "name=ModeloV2Teste"
   ```
   **Esperado:** `201` com `{id, versionId, versionNumber: 1, ...}`.
6. Confirmações SQL:
   ```sql
   SELECT * FROM linked_models ORDER BY id DESC LIMIT 1;   -- novo linked_model
   SELECT id, name, current_version_id FROM models ORDER BY id DESC LIMIT 1;  -- novo model, corrente preenchida
   SELECT id, version_number, status, storage_key, original_filename, file_hash, file_size, activated_at
   FROM model_versions ORDER BY id DESC LIMIT 1;
   ```
   **Esperado:** `version_number=1`, `status='active'`, `storage_key='models/<id>/versions/<vid>/model.ifc'`,
   `original_filename` com o nome real do ficheiro, `file_hash` (64 hex), `activated_at` preenchido.
7. Caminho no disco: `back/cdn_resources/models/<modelId>/versions/<versionId>/model.ifc` existe.
8. Hash: compara `file_hash` com `certutil -hashfile <caminho> SHA256` (Windows) — devem coincidir.
9. Viewer: `http://localhost:3000/student` → o modelo novo abre normalmente.

### 14.2 Segunda revisão

10. Repete o upload com `modelId=<id do passo 5>`.
    **Esperado:** `200` com `versionNumber: 2`.
11. SQL:
    ```sql
    SELECT COUNT(*) FROM models WHERE name='ModeloV2Teste';           -- continua 1 (não criou novo model)
    SELECT id, version_number, status FROM model_versions WHERE model_id=<id> ORDER BY version_number;
    -- v1: archived; v2: active
    SELECT current_version_id FROM models WHERE id=<id>;              -- id da v2
    ```
12. API: `GET http://localhost:3001/api/model/<id>/versions` (Bruno **List model versions**) → 2 versões;
    `GET .../api/model/<id>/current` → v2.
13. Downloads: `GET .../api/model/versions/<v1>/download` e `<v2>/download` (Bruno **Download model version**)
    → ambos devolvem ficheiro; se enviaste ficheiros diferentes, hashes diferem; o ficheiro da v1 permanece intacto no disco.
14. Viewer: continua a abrir o modelo (agora a v2, via versão corrente).

### 14.3 Falha de processamento (segura e reversível)

15. Envia um "IFC" inválido como revisão:
    ```bash
    echo "isto nao e um ifc" > invalido.ifc
    curl -X POST http://localhost:3001/api/model/upload -F "file=@invalido.ifc" -F "modelId=<id>"
    ```
    **Esperado:** `500` com mensagem de erro de inventário; no terminal do backend, uma linha
    `{"type":"model_upload_failure","stage":"processing",...}`.
16. Confirmações:
    ```sql
    SELECT id, version_number, status, failure_reason, storage_key FROM model_versions
    WHERE model_id=<id> ORDER BY id DESC LIMIT 1;   -- status='failed', failure_reason preenchida, storage_key NULL
    SELECT current_version_id FROM models WHERE id=<id>;   -- CONTINUA a v2
    SELECT COUNT(*) FROM entities WHERE model_version_id=<idFalhada>;  -- 0 (sem parciais)
    SELECT COUNT(*) FROM assets   WHERE model_version_id=<idFalhada>;  -- 0
    ```
17. Disco: `back/cdn_resources/models/<id>/versions/<idFalhada>/` NÃO existe;
    `back/cdn_resources/models/temp/` sem ficheiros novos.
18. Viewer: o modelo continua a abrir (a v2 permanece corrente).

### 14.4 Compatibilidade (sem regressões)

19. Ativos/reserva: duplo-clique num equipamento em `/student` → `Asset ID` + **Reservar**;
    cria uma reserva → `pending`.
20. Disponibilidade: início no passado → `400 "Cannot create reservation in the past"`.
21. `overdue` existente continua visível; regras de cancelamento inalteradas (§9).
22. Sensores: `/viewer` com timeline continua a funcionar (dependem de model_id, não de caminhos).
23. Sem aprovação de gestor: `POST /api/reservation/approve` → `404`.
24. P14 inalterado (lista de reservas só sem modelo selecionado).

### 14.5 Limpeza / repetição

- Os modelos de teste podem ficar; para repetir do zero:
  `mysql ... < backup_prompt2.sql` e apaga `back/cdn_resources/models/<modelId>/` do modelo de teste.
- O rollback do esquema (se alguma vez necessário):
  `npx tsx scripts/runSqlFile.ts ../database/migrations/2026-07-16_model_versioning_rollback.sql`
  (⚠️ perde os metadados novos; não apaga ficheiros nem reservas).

---

## 15. Prompt 3 — Identidade persistente dos espaços

> ⚠️ **REVISÃO (ADR-0009):** os passos abaixo que mostram espaços SEM código a
> serem aceites com diagnóstico já não se aplicam ao modelo espacial
> autoritativo — agora o upload é REJEITADO (422). Usa o roteiro atualizado
> do **§16**; esta secção fica como registo do comportamento intermédio.

### 15.0 Preparação

1. Migrations (a de espaços já foi aplicada na BD de dev em 2026-07-16; numa BD nova, por ordem de data):
   ```bash
   cd back
   npx tsx scripts/runSqlFile.ts ../database/migrations/2026-07-16_space_identity.sql
   ```
2. Serviços a correr (⚠️ reinicia backend E Flask — ambos têm código novo):
   `back: npm run dev` · `back/python: flask --app main run -p 3002` · `front: npm run dev`.
3. Fixtures (os teus IFCs reais não têm `Pset_SpaceCommon.Reference` — usa o gerador):
   ```bash
   cd back/python
   ./venv/Scripts/python.exe make_space_fixture.py fx_v1.ifc --space "R-101:Sala 101:GUIDFIXO01" --space "R-102:Sala 102" --space ":Sem Codigo"
   ./venv/Scripts/python.exe make_space_fixture.py fx_v2.ifc --space "R-101:Sala Renomeada" --space "R-102:Sala 102" --space "R-103:Sala Nova"
   ./venv/Scripts/python.exe make_space_fixture.py fx_dup.ifc --space "R-500:Sala X" --space "R-500:Sala Y"
   ./venv/Scripts/python.exe make_space_fixture.py fx_split.ifc --space "R-101A:Metade A" --space "R-101B:Metade B" --space "R-102:Sala 102" --space "R-103:Sala Nova"
   ```

### 15.1 Primeiro upload com códigos

4. `curl -X POST http://localhost:3001/api/model/upload -F "file=@fx_v1.ifc" -F "name=FixtureEspacos"` → `201` (guarda `<modelId>`/`<versionId>`; o linked_model criado é `<lm>`).
5. SQL / API:
   ```sql
   SELECT id, space_uuid, inventory_code, status FROM spaces WHERE linked_model_id = <lm>;
   -- 2 linhas: R-101 e R-102, status 'active' (o espaço sem código NÃO cria linha)
   SELECT * FROM space_bindings WHERE model_version_id = <versionId>;
   -- 2 bindings com ifc_guid, snapshots e model_version_id explícito
   ```
   `GET http://localhost:3001/api/space/linked/<lm>` devolve o mesmo. No terminal do backend: log `space_identity` com `ignored_missing_inventory_code` para o espaço sem código.
6. O espaço sem código continua como entity + asset legado: `SELECT COUNT(*) FROM assets WHERE model_version_id = <versionId> AND asset_type='space';` → 3 (lista legada não reduzida).

### 15.2 Nova versão — mesmo código, GUIDs/nome diferentes

7. `curl -X POST ... -F "file=@fx_v2.ifc" -F "modelId=<modelId>"` → `200`, versão 2.
8. Confirmações:
   ```sql
   SELECT id, inventory_code, status FROM spaces WHERE linked_model_id = <lm>;
   -- R-101 e R-102 mantêm os MESMOS ids (GUID novo e nome novo não mudam identidade);
   -- R-103 é novo; nenhum foi apagado
   SELECT space_id, model_version_id, ifc_guid FROM space_bindings ORDER BY id;
   -- bindings da v1 intactos (históricos); novos bindings para a v2
   ```
   `GET /api/space/<spaceId de R-101>/bindings` → 2 bindings (v1 e v2), com GUIDs diferentes.

### 15.3 GUID igual, código diferente

9. Gera `fx_v3.ifc` reutilizando o GUID fixo com outro código: `--space "R-999:Sala Recodificada:GUIDFIXO01"` (+ os outros espaços que quiseres manter) e faz upload como versão 3. Esperado: **novo** espaço R-999 (id novo); R-101 fica `absent` se ausente da v3 — GUID não transfere identidade.

### 15.4 Duplicado bloqueia ativação (modelo autoritativo)

10. `curl -X POST ... -F "file=@fx_dup.ifc" -F "modelId=<modelId>"` → `500 "Duplicate space inventory code(s)..."`.
11. Confirmações: `SELECT status, failure_reason FROM model_versions WHERE model_id=<modelId> ORDER BY id DESC LIMIT 1;` → `failed`, razão `spatial_identity: ...`; `SELECT current_version_id FROM models WHERE id=<modelId>;` → continua a versão anterior; `SELECT COUNT(*) FROM space_bindings WHERE model_version_id=<idFalhada>;` → 0; espaços preexistentes intactos; viewer continua a abrir o modelo.

### 15.5 Divisão / fusão / ausência

12. Upload de `fx_split.ifc` como nova versão (R-101 desaparece; R-101A/R-101B aparecem) → esperado: 2 espaços novos; R-101 fica `status='absent'` (preservado, com histórico); nada apagado.
13. Fusão: gera um ficheiro onde R-101A/R-101B desaparecem e surge R-101AB → 1 espaço novo, os dois anteriores `absent`.
14. Ausência em modelo NÃO espacial: faz upload de um IFC sem IfcSpace como **outro** modelo (ex.: `casa_modelo`) — os espaços da fixture não mudam de estado (autoridade é por federação).

### 15.6 Backfill

15. Com backend + Flask a correr: `cd back && npx tsx scripts/backfillSpaces.ts` (relatório) → nos teus modelos reais, todos os espaços dão `missing_reference` (não têm o pset — limitação histórica honesta); a versão `failed` aparece como `skipped_failed_version`. `--apply` + repetir → `already_bound`/no-op nas fixtures.

### 15.7 Compatibilidade

16. Viewer (`/student`): seleciona um modelo real → tudo como antes; sensores (`/viewer`) sem regressão; reserva nova → `pending`; início no passado → `400`; `overdue` continua; APIs de versões e downloads funcionam; `POST /api/reservation/approve` → 404; P14 inalterado.

### 15.8 Limpeza / rollback

17. Limpar fixtures: apaga o linked_model de teste (cascata para models) e os diretórios `back/cdn_resources/models/<modelId>/`; `DELETE FROM spaces WHERE linked_model_id=<lm>;` (bindings primeiro se necessário).
18. Rollback (ambiente descartável): `npx tsx scripts/runSqlFile.ts ../database/migrations/2026-07-16_space_identity_rollback.sql` — remove spaces/bindings/coluna de autoridade; não toca em entities, assets, reservas, ficheiros nem `current_version_id`.

---

## 16. Revisão do Prompt 3 — spatial_preflight estrito (ambiente pós-reset)

> A base foi limpa (reset operacional) — começa do zero. Nota: a aplicação não
> tem autenticação/login; "confirmar login" = abrir as páginas normalmente.

### 16.0 Preparação

1. Serviços (⚠️ reinicia backend E Flask — código novo em ambos):
   `back: npm run dev` · `back/python: flask --app main run -p 3002` · `front: npm run dev`.
2. Confirmar base vazia: `SELECT COUNT(*) FROM models; SELECT COUNT(*) FROM res_reservations; SELECT COUNT(*) FROM spaces;` → 0/0/0; `GET http://localhost:3001/api/model/linked` → `[]`; `/student` abre com lista de modelos vazia.
3. Fixtures (gera onde quiseres; os comandos criam os ficheiros na pasta atual):
   ```bash
   cd back/python
   ./venv/Scripts/python.exe make_space_fixture.py fx_valido_v1.ifc --space "R-101:Sala 101" --space "R-102:Sala 102"
   ./venv/Scripts/python.exe make_space_fixture.py fx_valido_v2.ifc --space "R-101:Sala Renomeada" --space "R-102:Sala 102" --space "R-103:Sala Nova"
   ./venv/Scripts/python.exe make_space_fixture.py fx_um_semcod.ifc --space "R-201:Sala OK" --space "R-202:Outra OK" --space ":Sem Codigo"
   ./venv/Scripts/python.exe make_space_fixture.py fx_dup.ifc --space "R-500:Sala X" --space "R-500:Sala Y"
   ```
   Para "modelo sem IfcSpace" usa um IFC teu sem espaços (ex.: Project1.ifc / casa_modelo_v5.ifc).

### 16.1 Modelo sem IfcSpace → rejeitado

4. `curl -X POST http://localhost:3001/api/model/upload -F "file=@Project1.ifc" -F "name=SemEspacos"`
   **Esperado:** `422` `"The spatial model cannot be processed because it contains no IfcSpace elements."`
5. `SELECT id, status, failure_reason FROM model_versions ORDER BY id DESC LIMIT 1;`
   → `failed`, `failure_reason = 'spatial_preflight: no IfcSpace found'`.
6. `SELECT COUNT(*) FROM entities; SELECT COUNT(*) FROM assets;` → 0/0 (nada persistido);
   `back/cdn_resources/models/<id>/` sem diretório da versão; `models/temp/` vazio.
   (A linha em `models`/`linked_models` fica — é o modelo lógico, não a versão.)

### 16.2 Espaço sem Reference → rejeitado (sem aceitação parcial)

7. Upload de `fx_um_semcod.ifc` (novo modelo `Misto`).
   **Esperado:** `422` `"... one or more IfcSpace elements do not contain a valid Pset_SpaceCommon.Reference. 1 of 3 IfcSpace elements are missing a valid inventory reference."`
8. No terminal do backend: log `spatial_preflight`/`invalid_references` com guid/Name/LongName/motivo (`missing_reference`).
9. SQL: versão `failed` com `spatial_preflight: 1 of 3 ...`; zero entities/assets/spaces/bindings.

### 16.3 Modelo totalmente válido → ativa

10. Upload de `fx_valido_v1.ifc` (novo modelo `FixValida`). **Esperado:** `201`, versão 1 `active`.
11. `SELECT * FROM spaces;` → R-101 e R-102 `active`; `SELECT * FROM space_bindings;` → 2 bindings; viewer abre o modelo.

### 16.4 Identidade persistente entre versões

12. Upload de `fx_valido_v2.ifc` com `modelId=<FixValida>`. **Esperado:** `200`, versão 2.
13. `SELECT id, inventory_code, status FROM spaces;` → R-101/R-102 mantêm os MESMOS ids (GUIDs/nome mudaram); R-103 novo; `GET /api/space/<idR101>/bindings` → bindings v1 e v2.

### 16.5 Duplicados → rejeitados no preflight

14. Upload de `fx_dup.ifc` com `modelId=<FixValida>`. **Esperado:** `422 "Duplicate space inventory code(s) in authoritative spatial model: R-500"`; corrente continua a v2; versão `failed` com `spatial_preflight: duplicate inventory code(s): R-500`; zero linhas novas em entities/assets/spaces/bindings.

### 16.6 Modelo não autoritativo (federação)

15. Com a federação de `FixValida` (`<lm>`): fixa a autoridade e carrega um disciplinar sem espaços NA MESMA federação:
    ```sql
    UPDATE linked_models SET spatial_authority_model_id = <FixValidaModelId> WHERE id = <lm>;
    ```
    `curl -X POST ... -F "file=@Project1.ifc" -F "name=MEP" -F "linkedParentId=<lm>"`
    **Esperado:** `201` — modelos disciplinares sem IfcSpace continuam permitidos.

### 16.7 Compatibilidade e encerramento

16. Bruno: pastas **Models/Spaces** funcionam; `GET /api/space/linked/<lm>`; downloads de versões OK.
17. Reservas: cria uma reserva num asset das fixtures → `pending`; início no passado → `400`; **nenhuma reserva pré-existente** (`SELECT COUNT(*) FROM res_reservations;` só com as que criares).
18. Limpeza para repetir: novo reset —
    ```bash
    cd back
    npx tsx scripts/resetOperationalData.ts                                   # dry-run (plano)
    ALLOW_DESTRUCTIVE_DEV_RESET=true npx tsx scripts/resetOperationalData.ts --apply
    ```
    (backup JSON automático em `cdn_resources/_backup_reset_<data>/`; nunca guardes a variável num .env.)
