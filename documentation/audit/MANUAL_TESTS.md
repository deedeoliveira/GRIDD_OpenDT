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

Páginas úteis: `http://localhost:3000/viewer` (viewer original com sensores),
`http://localhost:3000/student` (viewer de reservas) e `/dashboard` (gestão e
controlled model intake quando a feature está habilitada). A raiz `/` permanece
o boilerplate Next.

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

## 17. Prompt 4 — Identidade persistente dos ativos

> ⚠️ Começa de base limpa (reset §16.7/18) e **reinicia backend E Flask**
> (o Python passou a extrair psets dos elementos). A invariante central a
> validar: **uma nova versão nunca cria outro `asset_id` para o mesmo
> recurso — as reservas sobrevivem às versões.**

### 17.0 Preparação e fixtures

1. Serviços como em §16.0; base a zeros.
2. Fixtures com equipamentos (código no `Pset_DistributionElementCommon.Reference`):
   ```bash
   cd back/python
   ./venv/Scripts/python.exe make_space_fixture.py fx_assets_v1.ifc \
     --space "R-101:Sala 101" --space "R-102:Sala 102" \
     --element "R-101|EQ-001:Betoneira:GUIDEQ001" --element "R-101|EQ-002:Serra:GUIDEQ002" \
     --element "R-102|:SemCodigo:GUIDEQ003"
   ./venv/Scripts/python.exe make_space_fixture.py fx_assets_v2.ifc \
     --space "R-101:Sala 101" --space "R-102:Sala 102" \
     --element "R-101|EQ-001:Betoneira Renomeada:GUIDNOVO1" \
     --element "R-102|EQ-004:Equip Novo:GUIDEQ004" \
     --element "R-102|:Misterio:GUIDMIST"
   ```
   Notas: em v2 a EQ-001 muda de GUID e de nome (só o código a identifica);
   a EQ-002 desaparece (→ `absent`); `SemCodigo` mantém o GUID GUIDEQ003 em
   v1 mas NÃO existe em v2; `Misterio` não tem código nem GUID conhecido
   (→ caso de reconciliação).

### 17.1 Primeira versão — ativos persistentes

3. Upload `fx_assets_v1.ifc` (novo modelo `Ativos`). **Esperado:** `201`.
4. `SELECT id, asset_uuid, asset_code, asset_type, space_id, lifecycle_status, reservable FROM assets;`
   → 2 ativos-espaço (R-101/R-102, `space_id` preenchido) + 3 equipamentos
   (EQ-001, EQ-002 e SemCodigo — primeira versão aceita sem código), todos
   `active`, `asset_uuid` preenchido, `model_version_id` NULL.
5. `SELECT asset_id, model_version_id, ifc_guid, reconciliation_method FROM asset_bindings;`
   → 5 bindings da v1 (`space_id`, `asset_code`/`first_version`).
6. Bruno **Assets → Persistent asset / Asset bindings history** funcionam.

### 17.2 Reserva + nova versão — invariante central

7. No `/student` (ou Bruno), reserva a **Betoneira** (anota o `asset_id`,
   ex.: A) para amanhã. `SELECT asset_id, asset_binding_id_at_booking,
   model_version_id_at_booking, asset_name_snapshot, space_code_snapshot
   FROM res_reservations;` → snapshots preenchidos.
8. Upload `fx_assets_v2.ifc` com `modelId=<Ativos>`. **Esperado:** `200`.
9. **Invariante:** `SELECT id, asset_code, lifecycle_status FROM assets;` →
   a Betoneira mantém o MESMO id A (matched por código apesar de GUID e
   nome novos); NENHUM ativo novo para ela. A reserva continua a apontar
   para A e os snapshots não mudaram.
10. Tenta reservar a Betoneira no MESMO horário com outro actorId →
    **rejeitado** (`Asset already reserved for this period`) — a nova
    versão não contornou a reserva.

### 17.3 Ausente, novo e reconciliação

11. EQ-002 (Serra): `lifecycle_status = 'absent'`; tentar reservá-la →
    `Asset is not available for new reservations (lifecycle: absent)`;
    uma reserva já existente dela (se criaste) permanece intacta.
12. EQ-004: ativo NOVO (código novo = identidade nova, mesmo em versão
    posterior).
13. `Misterio`: `GET /api/asset/reconciliation/cases` → 1 caso `open`
    (sem asset nem binding — não reservável); a versão 2 ativou na mesma;
    log `pending_reconciliation` no backend.
14. Resolve o caso (Bruno **Resolve reconciliation case**), p.ex.
    `{"resolution":"confirm_as_new_asset"}` → cria ativo + binding
    `manual`; `?status=open` fica vazio; repetir a resolução → `409`.

### 17.4 Backfill (só se existirem dados legados)

15. Em base pós-reset não há linhas legadas: `npx tsx scripts/backfillAssets.ts`
    → "Nada a migrar (no-op)". (O relatório/aplicação com dados legados
    está coberto por testes automatizados; em produção corre primeiro sem
    `--apply` e revê o relatório.)

### 17.5 Encerramento

16. `npm test` (198 testes), viewer e páginas `/student`/`/viewer` abrem,
    seleção de elementos mostra os ativos via bindings da versão corrente.

> ⚠️ **Nota da revisão do Prompt 4:** o roteiro §17 foi escrito para a
> estratégia anterior (Reference em pset). Usa o **§18** — as fixtures do
> §17.0 já NÃO passam no preflight novo (equipamentos sem Tag EQP-).

## 18. Revisão do Prompt 4 — Tag EQP-, proxies e model_requirements_preflight

> ⚠️ Reinicia **backend E Flask** (extração nova de Tag/ObjectType).
> Base limpa recomendada (reset §16.7/18 — só com a tua autorização).
> Perfil: **IFC4**. `failure_reason` agora usa o prefixo
> `model_requirements_preflight: <REQUIREMENT-ID>` (as versões falhadas
> antigas mantêm o prefixo `spatial_preflight:` — histórico não reescrito).

### 18.0 Fixtures (localização: back/python; ficam na pasta atual)

Sintaxe dos elementos: `"ESPACO|TAG:Nome[:GUID][:SERIAL][:OBJECTTYPE]"`
(TAG vazia = sem Tag; OBJECTTYPE omitido = "Equipamento Gerido"; literal
`NONE` = sem ObjectType).

```bash
cd back/python
# 1. IFC4 válido: espaço + equipamentos EQP- (um com serial)
./venv/Scripts/python.exe make_space_fixture.py fx18_valido_v1.ifc \
  --space "R-301:Sala 301" --space "R-302:Sala 302" \
  --element "R-301|EQP-000123:Betoneira:GBETO1:SN-111" \
  --element "R-301|EQP-000124:Serra:GSERRA1"

# 2-5. inválidos de equipamento (cada um deve falhar com 422)
./venv/Scripts/python.exe make_space_fixture.py fx18_sem_tag.ifc \
  --space "R-303:Sala 303" --element "R-303|:SemTag"
./venv/Scripts/python.exe make_space_fixture.py fx18_prefixo.ifc \
  --space "R-304:Sala 304" --element "R-304|ABC-1:PrefixoErrado"
./venv/Scripts/python.exe make_space_fixture.py fx18_eqp_vazio.ifc \
  --space "R-305:Sala 305" --element "R-305|EQP-:SufixoVazio"
./venv/Scripts/python.exe make_space_fixture.py fx18_dup.ifc \
  --space "R-306:Sala 306" \
  --element "R-306|EQP-DUP:Mesa A" --element "R-306|EQP-DUP:Mesa B"

# 9-13. proxies
./venv/Scripts/python.exe make_space_fixture.py fx18_px_sem_ot.ifc \
  --space "R-307:Sala 307" --element "R-307|EQP-P1:ProxySemOT:::NONE"
./venv/Scripts/python.exe make_space_fixture.py fx18_px_ot_vazio.ifc \
  --space "R-308:Sala 308" --element "R-308|EQP-P2:ProxyOTVazio::: "
./venv/Scripts/python.exe make_space_fixture.py fx18_px_sem_tag.ifc \
  --space "R-309:Sala 309" --element "R-309|:ProxySemTag:::Betoneira Diesel"
./venv/Scripts/python.exe make_space_fixture.py fx18_px_tag_ruim.ifc \
  --space "R-310:Sala 310" --element "R-310|XPTO:ProxyTagRuim:::Betoneira Diesel"
./venv/Scripts/python.exe make_space_fixture.py fx18_px_valido.ifc \
  --space "R-311:Sala 311" --element "R-311|EQP-P9:ProxyValido:::Betoneira Diesel"

# 16-20. continuidade/reconciliação (v2 do fx18_valido)
./venv/Scripts/python.exe make_space_fixture.py fx18_valido_v2.ifc \
  --space "R-301:Sala 301" --space "R-302:Sala 302" \
  --element "R-301|EQP-000123:Betoneira Renomeada:GNOVO1:SN-111" \
  --element "R-302|EQP-000125:Equip Novo:GNOVO2"
./venv/Scripts/python.exe make_space_fixture.py fx18_valido_v3_serial.ifc \
  --space "R-301:Sala 301" --space "R-302:Sala 302" \
  --element "R-301|EQP-000123:Betoneira:GNOVO3:SN-999" \
  --element "R-302|EQP-000125:Equip Novo:GNOVO2"
./venv/Scripts/python.exe make_space_fixture.py fx18_renum.ifc \
  --space "R-301:Sala 301" --space "R-302:Sala 302" \
  --element "R-301|EQP-888888:Betoneira Renumerada:GNOVO4:SN-111" \
  --element "R-302|EQP-000125:Equip Novo:GNOVO2"
```

Upload: `curl -X POST http://localhost:3001/api/model/upload -F "file=@<fx>" -F "name=<Nome>"`
(revisões: `-F "modelId=<id>"`).

### 18.1 Válido IFC4 (item 1 do roteiro)

1. Upload `fx18_valido_v1.ifc` (novo modelo `RevTag`). **Esperado:** `201`.
2. `SELECT id, asset_code, serial_number, asset_type FROM assets WHERE asset_type='equipment' ORDER BY id DESC LIMIT 2;`
   → EQP-000123 com `serial_number='SN-111'` e EQP-000124 com serial NULL —
   **serial separado; asset_code = Tag**.
3. `SELECT asset_code_snapshot, serial_snapshot, object_type_snapshot FROM asset_bindings ORDER BY id DESC LIMIT 3;`

### 18.2 Equipamentos inválidos (itens 2–5)

4. Upload de `fx18_sem_tag/fx18_prefixo/fx18_eqp_vazio/fx18_dup` (modelos
   novos). **Esperado:** `422` com mensagem citando o elemento;
   `SELECT status, failure_reason FROM model_versions ORDER BY id DESC LIMIT 1;`
   → `failed`, `model_requirements_preflight: EQUIPMENT-001|002|002|003 …`.
5. Zero linhas novas em entities/assets/asset_bindings/asset_reconciliation_cases;
   diretório da versão não existe; `models/temp` vazio.

### 18.3 Modelos sem equipamentos e elementos arq/estruturais (itens 6–8)

6. Upload de um IFC só com espaços (ex.: `fx_valido_v1.ifc` do §16) →
   **passa** sem Tags.
7/8. Elementos arquitetónicos/estruturais não são cobrados por Tag — coberto
   por testes automatizados (as fixtures geradas não criam IfcWall); num IFC
   real com paredes contidas em espaços, o upload passa e
   `SELECT COUNT(*) FROM assets WHERE asset_type='equipment'` não cresce por
   causa delas (ficam só como entities).

### 18.4 Proxies (itens 9–15)

9–12. Upload de `fx18_px_sem_ot/fx18_px_ot_vazio/fx18_px_sem_tag/fx18_px_tag_ruim`
   → `422` `PROXY-001/PROXY-001/PROXY-002/PROXY-002`, mensagens
   "IfcBuildingElementProxy without a valid ObjectType" / "...without a
   valid equipment Tag starting with EQP-".
13/14. Upload `fx18_px_valido.ifc` → `201`; o proxy vira equipamento:
   `SELECT asset_code, name FROM assets ORDER BY id DESC LIMIT 1;` → EQP-P9.
15. `SELECT asset_code, object_type_snapshot FROM assets a JOIN asset_bindings ab ON ab.asset_id=a.id ORDER BY ab.id DESC LIMIT 1;`
   → `asset_code='EQP-P9'` e `object_type_snapshot='Betoneira Diesel'` —
   **ObjectType nunca vira asset_code**.

### 18.5 Continuidade e reconciliação (itens 16–23)

16/17. Reserva a Betoneira (asset A). Upload `fx18_valido_v2.ifc` com
   `modelId=<RevTag>` (GUID e nome mudaram; mesma Tag). → mesma linha:
   `SELECT id FROM assets WHERE asset_code='EQP-000123';` continua = A;
   reserva intacta; pedido sobreposto (com a reserva approved via SQL) →
   `Asset already reserved for this period`.
18. Serial igual (SN-111 em ambas) → binding `tag_and_serial`:
   `SELECT reconciliation_method FROM asset_bindings ORDER BY id DESC LIMIT 2;`
19. Upload `fx18_valido_v3_serial.ifc` (mesma Tag, serial SN-999 ≠ SN-111) →
   `200` e caso: `GET http://localhost:3001/api/asset/reconciliation/cases`
   → 1 caso `open` (serial_conflict); SEM ativo novo; Betoneira `absent`
   (sem binding na corrente) e EQP-000125 `active`.
20. Resolve o caso (Bruno) e upload `fx18_renum.ifc` (Tag EQP-888888 com o
   serial SN-111 já conhecido) → novo caso (serial_renumbering), sem merge.
21. Manufacturer: qualquer pset de fabricante é ignorado na identidade
   (guarda automatizada; sem fixture própria).
22/23. = invariante confirmada em 16–20.

### 18.6 Backfill, reset, viewer, sensores, APIs (itens 24–28)

24. `npx tsx scripts/backfillAssets.ts` (SEM --apply) → relatório com
   categorias `legacy_match_by_ifc_guid`/`missing_equipment_tag`/
   `unrecoverable`; nada escrito.
25. Nenhum reset ocorreu: `SELECT COUNT(*) FROM channels;` continua igual;
   os teus dados/uploads anteriores continuam na BD.
26. Viewer `/student`/`/viewer`: seleção mostra os ativos via bindings.
27. Sensores: página/API de sensores continuam a funcionar (desacoplado).
28. Bruno: pastas Models/Spaces/Reservation/Assets todas funcionais.


---

## 19. Prompt 5A — Fundação do grafo semântico (Fuseki, cliente, URIs)

Roteiro vivo (2026-07-17). Pré-requisitos: Java 17+ (`java -version`),
backend/BD como habitualmente. O grafo é OPCIONAL: os itens 11–19 provam
exatamente isso.

### 19.1 Suíte e triplestore (itens 1–4)

1. `cd back && npm test` → **306/306** (total anterior: 253).
2. Preparar o Fuseki (uma vez, ~80 MB):
   `powershell -ExecutionPolicy Bypass -File infrastructure\graph\setup-fuseki.ps1`
   → "Fuseki 5.6.0 pronto".
3. Arrancar: `powershell -ExecutionPolicy Bypass -File infrastructure\graph\start-fuseki.ps1`
   → "A arrancar Fuseki 5.6.0 em http://localhost:3030".
4. Health: abrir `http://localhost:3030/$/ping` → data/hora (HTTP 200).

### 19.2 Configuração e smoke (itens 5–9)

5. Em `back/.env` acrescentar (ver `.env.example`; recomendado apontar ao
   dataset de TESTE para o smoke):
   `GRAPH_QUERY_ENDPOINT=http://localhost:3030/oswadt-test/query`,
   `GRAPH_UPDATE_ENDPOINT=http://localhost:3030/oswadt-test/update`,
   `GRAPH_DATA_ENDPOINT=http://localhost:3030/oswadt-test/data`,
   `GRAPH_BASE_URI=http://oswadt.local/id`, `GRAPH_USERNAME=admin`,
   `GRAPH_PASSWORD=oswadt-dev-graph` (credencial LOCAL de dev).
6. `cd back && npx tsx scripts/graphSmoke.ts` → ✓ health, ✓ putGraph
   (2 triplos), ✓ query, ✓ update (3 triplos), ✓ deleteGraph; termina com
   "nenhum dado de produção foi tocado".
7. Query manual (auth pedida pelo browser ou via Bruno):
   `http://localhost:3030/oswadt-test/query?query=SELECT (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } }`
   → n=0 (o smoke limpou o seu próprio grafo).
8. Isolamento entre grafos: correr o smoke DUAS vezes e confirmar que cada
   execução mostra uma URI `…/graph/test/<uuid>` DIFERENTE.
9. Sem credenciais: pedir a query do item 7 sem auth → HTTP 401.

### 19.3 Aplicação SEM grafo (itens 10–19) — isolamento de falhas

10. Parar o Fuseki (Ctrl+C na janela do item 3).
11. Arrancar backend (`cd back && npm run dev`), Flask e front normalmente —
    nenhum erro de arranque relacionado com grafo.
12. Upload de um IFC válido (ex.: `back/python/fx18_valido_v1.ifc`) → upload
    e preflight funcionam exatamente como no §18.
13. Consultar modelo, espaços (`/api/spaces`) e ativos (`/api/assets`) → OK.
14. Criar uma reserva (fluxo do §18) → OK; conflitos continuam por asset_id.
15. Viewer `/student` e `/viewer` → OK.
16. Políticas: logs `policy_evaluation` continuam; decisões inalteradas.
17. `npx tsx scripts/graphSmoke.ts` com o Fuseki parado → falha CONTROLADA
    (`graph_unavailable`), sem afetar o backend em execução.
18. Reiniciar o Fuseki (item 3) e repetir o smoke → volta a passar.
19. Logs do backend: nenhuma linha `graph_operation` durante upload/reservas
    (nenhum fluxo operacional toca o grafo).

### 19.4 Nenhum dado de produção no grafo / nenhuma URI em SQL (itens 20–23)

20. `SELECT COUNT(*) FROM spaces WHERE semantic_uri IS NOT NULL;` → 0;
    `SELECT COUNT(*) FROM assets WHERE semantic_uri IS NOT NULL;` → 0.
21. Query do item 7 no dataset `/oswadt-dev` → 0 triplos (nenhum named
    graph de produção foi criado).
22. Confirmar no Fuseki UI (`http://localhost:3030`, auth dev) que apenas
    existem os datasets `oswadt-dev` e `oswadt-test`, ambos vazios.
23. Preservação da identidade na mudança de espaço (prova por teste):
    `npx tsx --test tests/graph/locationContracts.test.ts` → o teste
    "mudar o espaço … NÃO muda a assetUri" passa.

### 19.5 Limpeza

- Parar o Fuseki (Ctrl+C); os dados de dev ficam em
  `infrastructure/graph/run/` (gitignored). Para recomeçar do zero, apagar
  `infrastructure/graph/run/databases/oswadt-dev` COM O SERVIÇO PARADO.
- Remover/comentar as variáveis GRAPH_* do `.env` se não quiseres o grafo
  configurado no dia-a-dia (a aplicação não precisa delas).

---

## 20. Prompt 5B — Ativos não modelados (grafo autoridade, SQL projeção)

Roteiro vivo (2026-07-18). Pré-requisitos: migration
`2026-07-17_non_modelled_assets.sql` aplicada (já aplicada à BD de dev);
Fuseki preparado (§19). Usa SEMPRE chaves novas (UUIDs) nos comandos.
⚠️ Os endpoints são administrativos e sem autenticação — só uso local.

### 20.1 Arranque (itens 1–6)

1. MySQL a correr; `cd back && npm run dev` (porta 3001).
2. Flask: `cd back/python && flask --app main run -p 3002`.
3. Front: `cd front && npm run dev` (porta 3000).
4. Fuseki: `powershell -ExecutionPolicy Bypass -File infrastructure\graph\start-fuseki.ps1`.
5. Health: `http://localhost:3030/$/ping` → 200.
6. `.env` do back com GRAPH_* apontando ao dataset **oswadt-dev**
   (`http://localhost:3030/oswadt-dev/query|update|data`), base
   `http://oswadt.local/id`, admin/oswadt-dev-graph.

### 20.2 Espaço persistente ativo (item 7)

7. Precisas de um espaço ativo: carrega um IFC com espaços (§18, ex.
   `fx18_valido_v1.ifc`) e confirma `SELECT id, inventory_code, status FROM
   spaces;` → anota dois IDs ativos (ex.: 1 e 2).

### 20.3 Registo (itens 8–14)

8. Bruno → NonModelled → *Register non-modelled asset* (ou curl) com
   `registrationKey` NOVO (uuid), `initialSpaceId` = espaço ativo:
   → 201 com assetId, assetUuid, `assetUri = http://oswadt.local/id/asset/<uuid>`,
   `policyDecision: "undetermined"` (provider legado — defensivo),
   `reservable: false`, `locationStatus: "located"`, operação `completed`.
9. GET `/api/asset/non-modelled/:assetId` → projeção com source=graph.
10. SPARQL (browser/Bruno, auth dev), dataset oswadt-dev:
    `SELECT ?p ?o WHERE { GRAPH <http://oswadt.local/id/graph/operational> { <ASSET_URI> ?p ?o } }`
    → tipo NonModelledAsset, assetUuid, displayName, hasLocationAssignment.
11. SQL: `SELECT id, asset_uuid, asset_code, asset_type, asset_subtype,
    semantic_uri, source, reservable FROM assets WHERE source='graph';`
12. Ausência de entity: `SELECT COUNT(*) FROM entities e JOIN assets a ON
    a.model_entity_id = e.id WHERE a.source='graph';` → 0.
13. Ausência de binding: `SELECT COUNT(*) FROM asset_bindings ab JOIN assets
    a ON a.id = ab.asset_id WHERE a.source='graph';` → 0.
14. Localização: `SELECT * FROM asset_location_assignments;` → 1 linha,
    valid_to NULL, is_current=1.

### 20.4 Idempotência (itens 15–18)

15. Repete o MESMO pedido (mesma registrationKey e payload) → 201 com o
    MESMO assetUuid/assetUri; `SELECT COUNT(*) FROM assets WHERE
    source='graph';` inalterado.
16. Mesmo registrationKey com `name` alterado → **409** idempotency_conflict.
17. Regista SEM `initialSpaceId` (chave nova) → `locationStatus:
    "pending_location"`; tentativa de reserva desse asset → erro "no valid
    current location".
18. Regista com `initialSpaceId` inexistente (ex. 999, chave nova) → 422; e
    com espaço absent → 422; confirma no Fuseki que NADA foi escrito para
    essas chaves.

### 20.5 Movimento e histórico (itens 19–22)

19. *Move non-modelled asset* com `movementKey` novo e `newSpaceId` = o 2.º
    espaço ativo → 200; `assetUuid`/`assetUri` INALTERADOS.
20. GET `/:id/location-history` → 2 linhas: antiga com valid_to preenchido,
    nova corrente; SPARQL do item 10 mostra as DUAS atribuições (antiga com
    validTo).
21. Repete o mesmo movimento (mesma movementKey) → mesmo resultado, sem
    duplicação; movementKey igual com espaço diferente → 409.
22. `source: "sensor_inference"` no movimento → **422** source_not_implemented.

### 20.6 Política em ambiente controlado (item 23)

23. (Opcional, prova de allow) `RESERVABILITY_POLICY_PROVIDER` não tem
    provider allow para não modelados — a prova de allow/deny/error é feita
    por teste automatizado com provider injetado:
    `npx tsx --test tests/nonmodelled/projectionPolicy.test.ts` → passa.
    Para o roteiro manual de reserva, torna o asset reservável à mão
    (aceite como passo de TESTE local): `UPDATE assets SET reservable=1
    WHERE id=<assetId> AND source='graph';`

### 20.7 Reservas (itens 24–27)

24. Front /student (ou POST /api/reservation/request) para o asset não
    modelado com datas futuras → reserva `pending` criada;
    `SELECT asset_id, space_code_snapshot FROM res_reservations ORDER BY id
    DESC LIMIT 1;` → snapshot com o código do espaço ATUAL.
25. Move o equipamento para outro espaço (chave nova) → OK.
26. A reserva continua no MESMO asset_id e o snapshot antigo NÃO mudou
    (repete o SELECT do item 24).
27. Segunda reserva sobreposta do mesmo asset (depois de aprovares a
    primeira via SQL `UPDATE res_reservations SET status='approved' WHERE
    id=<id>;`) → "Asset already reserved for this period" — o movimento não
    contornou o conflito.

### 20.8 Falhas e retry (itens 28–33)

28. Pára o Fuseki (Ctrl+C) e confirma: a reserva existente continua
    consultável e o checkout/cancelamento funcionam (nada toca o grafo).
29. Tentativa de NOVO registo/movimento com Fuseki parado → **503**
    controlado (`graph_unavailable`/`graph_not_configured`), sem stack trace.
30. Reinicia o Fuseki; repete o comando com a MESMA chave → conclui e não
    duplica nada.
31. Falha SQL segura: para simular, usa o teste automatizado
    `npx tsx --test tests/nonmodelled/distributedFailures.test.ts` (injeta a
    falha sem tocar na tua BD) → passa.
32. `SELECT * FROM semantic_sync_operations;` → operações com status
    completed; attempt_count > 1 nas que repetiste.
33. Retry manual: POST `/api/semantic/sync/<id>/retry` numa operação
    completed → devolve o resultado existente (idempotente).

### 20.9 Reconciliação (itens 34–35)

34. GET `/api/semantic/reconciliation/report` → findings: [] (estado
    consistente).
35. POST `/api/semantic/reconciliation/apply-safe` → applied: [],
    skipped: [] (idempotente; nada a corrigir).

### 20.10 Regressão e limpeza (itens 36–40)

36. Bruno: pastas Models/Spaces/Reservation/Assets/NonModelled funcionais.
37. Ativos MODELADOS: upload/§18 continua igual; viewer OK; sensores OK.
38. `npx tsx scripts/reportNonModelledLegacy.ts` → relatório read-only.
39. Confirma que NENHUM ativo modelado foi escrito no grafo:
    a query do item 10 sobre o grafo operacional só devolve os ativos que
    registaste neste roteiro.
40. LIMPEZA (apenas dados de ativos não modelados — SQL + Fuseki, direcionada
    e idempotente; executar o comando significa querer apagar):
    `cd back && npx tsx scripts/cleanupNonModelledGraphData.ts`
    (com o Fuseki LIGADO e as GRAPH_* no .env; remove reservas/localizações/
    operações/assets source='graph' e os recursos RDF correspondentes; nunca
    usa CLEAR/DROP; preserva modelos, espaços, bindings, sensores e channels.)
## 21. Prompt 6 — Roteiro FINAL completo (concorrência, integração, recuperação)

Roteiro único de verificação de todo o protótipo. NÃO executes reset da base
sem autorização; nenhum passo apaga dados reais (a limpeza do item 21.12 só
toca no universo 5B e só quando TU a executares).

### 21.1 Base e serviços
1. MySQL (3336), backend (3001), front (3000), Flask (3002), Fuseki (3030)
   ligados. `GET http://localhost:3001/api/model` responde; `GET
   http://localhost:3030/$/ping` responde.
2. Migrations aplicadas — a nova (índice de concorrência) se ainda não:
   `cd back && npx tsx scripts/runSqlFile.ts ../database/migrations/2026-07-18_concurrency_constraints.sql`
   (idempotência: 2.ª execução falha com "Duplicate key name" — esperado e
   inofensivo). Rollback documentado no ficheiro `_rollback.sql` — só em
   ambiente descartável.
3. `SHOW INDEX FROM assets WHERE Key_name='uq_assets_graph_manager_code';` → 1 linha.

### 21.2 Suite automática, typecheck, front
4. `cd back && npm test` → **416 testes, 0 falhas**.
5. `npx tsc --noEmit` → sem erros. `cd ../front && npm run build` → conclui.

### 21.3 IFC V1/V2, versões, espaços, ativos, bindings
6. Segue DEMO_SCRIPT.md §18.1–18.3 (upload V1 → reserva → upload V2):
   mesma identidade (asset_uuid/space_uuid), binding novo por versão, corrente
   por `models.current_version_id`, reserva preservada com snapshots antigos,
   conflito preservado por asset_id.

### 21.4 Estados das reservas (inclui overdue e checkout)
7. Cria reserva (pending). Cancela → OK sem restrição de 24 h.
8. Cria outra; marca-a `approved` diretamente em SQL (não há workflow de
   aprovação — mecanismo documentado):
   `UPDATE res_reservations SET status='approved' WHERE id=<id>;`
   Cancelar a <24 h do início → erro da regra 24 h.
9. Com uma approved dentro da janela: `POST /api/reservation/checkin` →
   in_use; `POST /api/reservation/checkout` → completed. Segundo checkout →
   "No active reservation to checkout".
10. Overdue: cria reserva curta já a decorrer (approved em SQL, checkin), deixa
    passar o end_time, faz qualquer GET de reservas → status vira `overdue`;
    checkout de overdue → completed (obrigatório e aceite).
11. Datas inválidas: início no passado e fim ≤ início → 400 com as mensagens
    de sempre, ANTES de tocar na base.

### 21.5 Concorrência (real, contra o backend)
12. `cd back && npx tsx scripts/concurrencyProbe.ts reservation <assetId>` →
    10 rondas, todas `accepted=1 rejected=1`.
13. `npx tsx scripts/concurrencyProbe.ts idempotency` → 1 ativo, 1 operação.
14. Regista um ativo não modelado com localização e corre
    `npx tsx scripts/concurrencyProbe.ts movement <assetId>` → 1 corrente.

### 21.6 Ativo não modelado, grafo, projeção, movimento, histórico
15. Roteiro §20 (itens 1–20) continua válido — versão curta: regista com
    initialSpaceId, vê a URI no Fuseki, projection-status, move, histórico.

### 21.7 Retries e reconciliação
16. Pára o Fuseki; POST de registo novo → 503 controlado; sobe o Fuseki;
    `POST /api/semantic/sync/<id>/retry` → completed (attempt_count +1 UMA vez,
    mesmo se dispararem dois retries ao mesmo tempo).
17. `GET /api/semantic/reconciliation/report` → sem findings (ou explica-os);
    `POST /api/semantic/reconciliation/apply-safe` 2× seguidas → 2.ª sem nada
    a aplicar (idempotente).

### 21.8 Falha de upload
18. Envia um IFC inválido (sem IfcSpace/Reference) → upload falha no preflight;
    `model_versions` mostra a linha `failed` com failure_reason;
    `current_version_id` INALTERADO; viewer continua a servir a corrente.
19. Confirma que a falha IFC não tocou no grafo: a contagem de recursos do
    grafo operacional é a mesma de antes do upload falhado.

### 21.9 Viewer, sensores, frontend, Bruno
20. Viewer abre a versão corrente; painel de sensores responde; coleção Bruno
    (Models/Spaces/Reservation/Assets/NonModelled/Semantic) funcional.

### 21.10 Isolamento com grafo em baixo
21. Com o Fuseki parado: modelados, espaços, reservas de modelados E de não
    modelados JÁ projetados funcionam; só os fluxos 5B novos devolvem 503.

### 21.11 Rollback (APENAS em ambiente descartável)
22. Numa base descartável (nunca na dev): aplica
    `2026-07-18_concurrency_constraints_rollback.sql` e confirma que só o
    índice desaparece (nenhuma linha alterada); reaplica a migration.

### 21.12 Limpeza (opcional, decisão tua)
23. `cd back && npx tsx scripts/cleanupNonModelledGraphData.ts` — remove SÓ o
    universo 5B (SQL + RDF, direcionado, idempotente). Reservas de demo de
    ativos modelados: apagar à mão por id, se quiseres.

## 22. Prompt 7B1 — Semantic Artifact Registry e graphs imutáveis

**Manual infrastructure verification not performed.**

Este roteiro está **pendente** e deve correr apenas num ambiente local
descartável/reversível. Não foi executado pela implementação. Nunca apontar
estes comandos a produção nem carregar no dataset `oswadt-dev` sem decisão
humana explícita. É uma referência técnica para um futuro executor, não uma
tarefa obrigatória da investigadora. Futuras verificações manuais destinadas à
investigadora devem usar cenários funcionais observáveis, não inspeções de
locks, hashes, migrations, retries ou tabelas internas.

### 22.1 Preparação e migration manual

1. Guarda backup da base e confirma `git status --short`.
2. Inicia MySQL e o Fuseki local conforme §19. Confirma que as `GRAPH_*`
   apontam ao dataset escolhido para este teste e guarda, antes da carga, a
   contagem do graph `/graph/operational` com uma query `SELECT (COUNT(*) AS
   ?count) WHERE { GRAPH <.../graph/operational> { ?s ?p ?o } }`.
3. Revê e aplica manualmente
   `database/migrations/2026-07-20_semantic_artifact_registry.sql` no MySQL.
   Não existe migration ledger automático.
4. Confirma com `SHOW TABLES LIKE 'semantic_artifact%';` que existem exatamente
   as três tabelas novas e inspeciona os índices com `SHOW INDEX`.
5. Em `back/.env`, reutiliza as credenciais/endpoints `GRAPH_*` já existentes e
   define `SEMANTIC_ARTIFACT_LOADING_ENABLED=true`. Não duplica credenciais.

### 22.2 Integridade e dry-run

6. Em `back/`, corre `npm run semantic:artifacts:validate` → seis artefactos
   governados (cinco Turtle e um IDS/XML),
   hashes/tamanhos esperados e nota explícita de que não houve execução SHACL.
7. Corre `npm run semantic:artifacts:load-public -- --dry-run` → quatro chaves,
   zero writes SQL e zero writes no grafo.
8. Confirma que `semantic/artifacts` contém apenas os cinco `.ttl`, o IDS
   público, o manifesto e README; nenhum RDF/XML ou ficheiro privado do pacote
   externo.

### 22.3 Falha recuperável e retry

9. Antes da primeira carga real, para o Fuseki e executa, com uma chave pública,
   `npm run semantic:artifacts:load -- --key <artifactKey>
   --idempotency-key manual-retry-7b1` → erro controlado `graph_load_failed` e
   operação `failed_retryable`, sem current pointer.
10. Reinicia o Fuseki, obtém o `operation_uuid` diretamente em
    `semantic_artifact_load_operations` e corre `npm run
    semantic:artifacts:retry -- --operation <operationUuid>`.
11. Confirma que `artifact_uuid`, `named_graph_uri` e `sha256` não mudaram, a
    contagem coincide e a operação terminou. O erro SQL guardado não contém
    payload, query ou credencial.

### 22.4 Carga pública, registry e repetição

12. Corre `npm run semantic:artifacts:load-public` → quatro releases runtime;
    o fixture negativo não aparece.
13. Corre `npm run semantic:artifacts:status` e confirma uma família/revisão
    ativa por chave, `graph_verified`, operações concluídas e current pointers.
14. No Fuseki, consulta individualmente os quatro `named_graph_uri` devolvidos:
    contagens 457, 103, 72 e 115. Confirma o recurso semântico esperado nos
    graphs de ontologia, ponte e shapes.
15. Repete `npm run semantic:artifacts:load-public`; confirma que as mesmas
    revisões/graphs convergem, sem novos PUTs nem UUIDs de artefacto.
16. Repete a contagem do `/graph/operational` feita no item 2 → exatamente o
    mesmo valor. Nenhum URI do registry usa `/graph/operational`, `current`,
    `active` ou `latest`.

### 22.5 Rollback e histórico

17. Um rollback real exige duas revisões elegíveis da mesma família. Quando uma
    segunda release pública auditada existir, carrega-a, guarda os dois graph
    URIs e corre `npm run semantic:artifacts:rollback -- --family <familyKey>
    --to-version <previousVersion> --idempotency-key manual-rollback-7b1`.
18. Confirma que o current pointer voltou à revisão anterior, a revisão alvo
    está `active`, a outra está `superseded`, ambos os named graphs continuam
    consultáveis e `deleteGraph`/`CLEAR`/`DROP` não ocorreu. Repete a mesma
    operação e confirma convergência idempotente.
19. Enquanto só existe uma versão pública por família, limita esta verificação
    ao teste automatizado de rollback concorrente; não fabrica uma release nem
    edita um TTL para simular versão.

### 22.6 Privacidade, fixture e encerramento

20. Confirma no manifesto e SQL que o fixture negativo é `synthetic_test_only`,
    `testOnly=true`, `activationAllowed=false`, não possui current pointer e não
    foi carregado por `load-public`. A CLI normal não oferece carga desse fixture.
21. Inspeciona os cinco Turtle e os quatro graphs runtime somente para classes de
    privacidade aprovadas; confirma ausência de pessoas reais, identificadores
    institucionais privados e URIs individuais privadas.
22. Desativa novamente `SEMANTIC_ARTIFACT_LOADING_ENABLED=false`. Se o ambiente
    for descartável e houver aprovação, aplica manualmente o rollback SQL: ele
    remove apenas as três tabelas desta etapa e nunca toca Fuseki. Os graphs
    históricos são preservados por desenho e qualquer retenção futura deve ser
    dirigida por URI, nunca ampla.

## 23. Prompt 7B2 — demonstração funcional institucional

Este roteiro destina-se à investigadora e contém somente resultados funcionais
observáveis. A preparação técnica está separada em
`DEMO_INSTITUTIONAL_CONTEXT.md` e **não é um teste manual obrigatório da
investigadora**.

Estado local em 2026-07-20: preparação técnica concluída pelo executor; a
investigadora começa diretamente no passo 1 e não executa migrations, seeds,
SQL, SPARQL ou inspeções de infraestrutura.

1. Abrir `/semantic-demo` já preparado pelo executor técnico.
2. Selecionar `TEST-ACTOR-STUDENT-001` e observar pessoa sintética, número de
   estudante, grupo de investigação, dois papéis, supervisor e versões dos
   artefactos usados.
3. Selecionar `TEST-ACTOR-STUDENT-002` e observar contexto válido, número,
   cluster e papéis; confirmar a mensagem de que não existe assertion de
   supervisor no graph sintético ativo.
4. Selecionar `TEST-ACTOR-REVOKED-001` e observar que a ligação é encontrada,
   mas o contexto institucional corrente não é utilizado.
5. Confirmar visualmente os caveats: dados sintéticos, actor key não
   autenticado e nenhuma decisão de elegibilidade, autorização ou reserva.
6. Confirmar que nenhuma reserva foi criada, alterada ou aprovada.

Não pedir à investigadora que inspecione locks, hashes, migrations, retries,
tabelas internas, SPARQL, named graphs ou contagens técnicas.

## 24. Prompt 7C — demonstração funcional IDS

Este é o único roteiro manual destinado à investigadora. A migration, o perfil
ativo, as dependências, as fixtures, os serviços e o setup são preparados pelo
executor. Instruções técnicas em `DEMO_IDS_VALIDATION.md` são referência para
o executor e **Not intended as a required manual test for the researcher.**

1. Abrir `/ids-demo` no ambiente já preparado.
2. Escolher **Scenario A — Missing Reference**, executar a validação e observar
   `Overall: FAIL`, `IDS: FAIL`; compreender que o espaço não fornece
   `Pset_SpaceCommon.Reference`.
3. Escolher **Scenario B — Valid Model**, executar e observar `Overall: PASS`,
   `IDS: PASS`, `Project rules: PASS`.
4. Escolher **Scenario C — Duplicate Reference**, executar e observar
   `Overall: FAIL`, `IDS: PASS`, `Project rules: FAIL`; compreender que cada
   espaço satisfaz individualmente o IDS, mas dois espaços usam o mesmo código.
5. Confirmar que perfil, versão, hash e executor aparecem no relatório e que
   requisitos aprovados/falhados estão legíveis e separados por camada.
6. Confirmar o aviso permanente: a demonstração não decide reservabilidade,
   elegibilidade, autorização ou aprovação e não cria/altera reservas.

A investigadora não executa migrations, SQL, SPARQL, hashes, locks, instalação
de dependências, seeds, preparação de fixtures nem inspeção de tabelas.

## 25. Prompt 7D — controlled model intake

Manual evidence now requires inputs selected by the researcher. Preset-only
scenario pages are not sufficient. The technical executor prepares migrations,
mapping/IDS activation, services and flags; the researcher performs only the
functional steps in `MODEL_INTAKE_WALKTHROUGH.md`.

| Teste ou grupo | O que está sendo testado em linguagem comum | Resultado |
|---|---|---|
| Controlar IFC e IDS | Os ficheiros escolhidos são realmente processados e os hashes/requisitos apresentados vêm do backend. | Pendente do walkthrough |
| Alterar somente IDS | Mudar o perfil, sem mudar IFC, altera requisitos e findings. | Pendente do walkthrough |
| Preview sem persistência | Rever validação e RDF não cria versão, graph ou reserva. | Pendente do walkthrough |
| Criar V1 explicitamente | O botão separado cria versão e graph apenas após as verificações. | Pendente do walkthrough |
| Criar V2 | Nova manifestação/graph preserva identidades persistentes e V1 histórica. | Pendente do walkthrough |
| Isolamento | Nenhuma decisão ou alteração de reserva é produzida pelo intake semântico. | Pendente do walkthrough |

Future manual verification intended for the researcher must use observable
functional scenarios with researcher-controlled inputs, never SQL, SPARQL,
migrations, hashes computed by hand, locks, retries or internal tables.

## 26. Prompt 7E — governed SHACL structural validation

Technical preparation (migration, pySHACL, artifact activation, flags, setup
and services) belongs to the executor. The researcher controls the IFC, IDS
and shapes through the real dashboard pickers and follows
`SHACL_VALIDATION_WALKTHROUGH.md` only.

| Teste ou grupo | O que está sendo testado em linguagem comum | Resultado |
|---|---|---|
| Execução pySHACL real | O RDF e as shapes escolhidas chegam a um executor SHACL compatível, não a uma simulação de interface. | PASS — investigadora |
| Shapes governadas | O RDF do IFC cumpre a estrutura pública obrigatória da plataforma. | PASS — investigadora |
| Shapes temporárias | Um `.ttl` escolhido pela investigadora é inspecionado e executado sem ser governado/ativado. | PASS — investigadora |
| Mudança das shapes | Mantendo IFC, IDS e RDF, trocar somente as shapes altera hash, constraints e resultado. | PASS — investigadora; integridade criptográfica automatizada |
| Constraints visíveis | Filename, hash, target, path, cardinalidade, tipo e mensagem vêm das shapes recebidas. | PASS — investigadora; hash verificado automaticamente |
| Resultado explicável | Uma falha mostra focus node, path, value, severity, message e source shape. | PASS — investigadora |
| Preview sem persistência | Executar SHACL no preview não cria model version, model graph ou report graph. | PASS — integração automatizada/executor |
| Required protege versão | Só governed `conforms=true` permite criar/ativar; a versão corrente anterior permanece em falha. | PASS — investigadora e integração automatizada |
| Frontend/backend | Os pickers enviam multipart ao backend, sem acesso frontend a Python/Fuseki. | PASS — investigadora e integração automatizada |
| Relatórios/downloads | JSON, report Turtle e data Turtle correspondem ao run observado. | PASS — integração automatizada/executor |
| Pacote institucional | A evidência automatizada positiva/negativa usa o pacote imutável e a negativa gera sete resultados. | Cobertura automatizada; não é tarefa manual |
| Ausência de impacto em reservas | A validação estrutural não cria, altera, avalia ou aprova reservas. | PASS — investigadora e integração automatizada |
| Regressão completa | O comportamento 7D e os restantes fluxos continuam cobertos pela suíte completa. | Cobertura automatizada; não é tarefa manual |

Não pedir à investigadora SQL, SPARQL, migrations, pySHACL em linha de comando,
hashes manuais, locks, retries, seeds ou inspeção de tabelas/graphs internos.

## 27. Prompt 7F — reservation semantic evidence in shadow mode

Correction: the researcher controls only asset and interval. The current development actor is read-only, unauthenticated and cannot be impersonated. The revoked actor is automated and executor-level only.

Technical preparation belongs to the executor. The researcher controls actor
key, asset and interval in the real reservation form and follows only
`RESERVATION_EVIDENCE_WALKTHROUGH.md`.

| Teste ou grupo | O que está sendo testado em linguagem comum | Resultado |
|---|---|---|
| Ligação actor–instituição | O actor escolhido resolve a ligação e papéis institucionais atuais ou mostra revoked/expired. | Pendente do walkthrough |
| Evidência do asset/modelo | O asset escolhido resolve UUID, Tag, versão e manifestação correntes. | Pendente do walkthrough |
| SHACL estrutural | A conformidade estrutural da versão usada aparece separadamente. | Pendente do walkthrough |
| Eligibility shadow | pySHACL executa a policy real, mas o resultado não permite nem bloqueia. | Pendente do walkthrough |
| Disponibilidade SQL | O intervalo é verificado pelas regras temporais SQL existentes. | Pendente do walkthrough |
| Pedido real | Check evidence não cria; somente Create reservation request cria pending. | Pendente do walkthrough |
| Conflito | Eligibility pode continuar eligible enquanto SQL rejeita overlap real. | Pendente do walkthrough |
| Actor revogado | Trocar o actor muda evidência/policy sem ação automática. | Pendente do walkthrough |
| Evidence snapshot | Um pedido explícito liga o run com actor, asset e intervalo correspondentes. | Pendente do walkthrough |
| Ausência de autorização/aprovação | Nenhuma apresentação confunde shadow, disponibilidade e resultado operacional. | Pendente do walkthrough |
| Regressão completa | Reservas anteriores, IDS, model intake e SHACL estrutural mantêm comportamento. | Cobertura automatizada |

Não pedir SQL, SPARQL, migrations, seeds, setup, inspeção de graphs/tabelas,
hashes manuais ou comandos pySHACL à investigadora.
