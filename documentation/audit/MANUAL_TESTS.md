# Procedimento de teste manual — Baseline

Procedimento reproduzível para validar o comportamento atual descrito em `BASELINE.md`.
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

## 3. Atualização do mesmo modelo (2.ª versão)

Repete o Upload model acrescentando o campo `modelId` = `<modelId>` do passo 2.

> ⚠️ Usa um IFC **com IfcSpace**. Um IFC sem espaços cria silenciosamente uma versão
> com inventário vazio (P13 no BASELINE.md) e o passo 5 passa a mostrar
> "não pertence ao inventário" para todos os elementos. Se acontecer, faz nova
> atualização com o ficheiro correto (o anterior fica em `cdn_resources/models/archive/`).

**Esperado:** `200` com novo `versionId`; o IFC anterior movido para
`back/cdn_resources/models/archive/<timestamp>_<modelId>.ifc`; novas linhas em entities/assets para a nova versão (as antigas mantêm-se).

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
- Reserva `approved` com início a menos de 24h → `400` "Cancellation allowed only up to 24h before start time" (a regra das 24h só se aplica a aprovadas).
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
Com `end ≤ start` → `400 "End time must be after start time"`; datas inválidas → `400`.
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
