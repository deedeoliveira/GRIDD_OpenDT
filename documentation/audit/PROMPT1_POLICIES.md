# Prompt 1 — Fronteiras de políticas (sem alteração de comportamento)

> Etapa executada em 2026-07-15, sobre a baseline verificada (commits `3d19f1c` + `546e3d2`).
> O comportamento visível da aplicação é idêntico ao da baseline.

## 1. Onde a regra de reservabilidade estava (auditoria)

| Pergunta | Resposta verificada |
|---|---|
| Onde a regra é executada? | **Só no Node**: `back/utils/inventoryDatabase.ts` → `saveInventorySnapshot`, no momento em que o snapshot de inventário é gravado (upload/atualização de modelo, dentro da transação) |
| Quais classes IFC são consideradas? | Candidatos vêm do Python: `IfcSpace` (todos) e elementos `IfcElement` contidos num espaço via `IfcRelContainedInSpatialStructure` (`extract_inventory_by_space`) |
| Quais exclusões existem? | Uma única: elementos com classe exatamente `'IfcSensor'` não viram assets (comparação estrita de string). Nota: em modelos IFC2X3 os sensores chegam como `IfcDistributionControlElement` e **não** eram (nem são) excluídos — preservado deliberadamente |
| A regra está no Node? | Sim — era o `if (element.type !== 'IfcSensor')` + `reservable: true` hardcoded nos dois INSERTs de assets |
| Está no Python? | Não. O Python só extrai candidatos (filtro `is_a("IfcElement")` + agrupamento por espaço); não decide reservabilidade. O filtro IfcSensor/IfcDistributionControlElement em `ifcopenshell_utils.py` pertence ao fluxo separado de **sensores** (`process_ifc_file`), não ao inventário |
| Usa IfcOpenShell? | Só na extração de candidatos (Python), não na decisão |
| Está duplicada? | Não. O frontend apenas **lê** `asset.reservable` para mostrar o botão "Reservar" — não é autoridade |
| Quando um ativo é criado? | Durante `saveInventorySnapshot`, logo após o INSERT da entity correspondente |

A validação de submissão de pedido estava inline em `reservationDatabase.createReservation`
(fim > início; início no futuro), seguida — e agora continuada — pelas verificações de
conflito temporal (`hasApprovedConflict`/`hasActorConflict`), que ficam **fora** da política.

## 2. Nova camada `back/policies/`

```
back/policies/
├── types.ts                             # Contratos: PolicyDecision, PolicyEvaluationResult,
│                                        #  PolicyContext, ReservabilityCandidate,
│                                        #  ReservationValidationRequest + as 2 interfaces
├── legacyIfcReservabilityEvaluator.ts   # Reproduz a regra da baseline (espaço→allow;
│                                        #  elemento→allow exceto 'IfcSensor'→deny)
├── legacyReservationRequestValidator.ts # Reproduz as validações técnicas da baseline
│                                        #  (fim>início primeiro; início no futuro),
│                                        #  com as MESMAS mensagens de erro
└── policyProvider.ts                    # Ponto único de escolha (env vars), setters para
                                         #  substituição e log estruturado de decisões
```

Contrato central (não é um booleano):

```ts
{ decision: "allow" | "deny" | "undetermined" | "error",
  reasons: string[], evaluatorId: string, rulesVersion?: string, evaluatedAt: string }
```

As implementações legadas só devolvem `allow`/`deny` (comportamento atual); os pontos de
uso tratam `undetermined`/`error` como não-allow, portanto o contrato completo já é suportado.

Configuração (defaults aplicados se as variáveis não existirem — o `.env` atual não precisa de mudar):

```
RESERVABILITY_POLICY_PROVIDER=legacy
RESERVATION_VALIDATION_PROVIDER=legacy
```

Pontos de uso (únicos):
- `inventoryDatabase.saveInventorySnapshot` → `getReservabilityEvaluator().evaluate(...)`
  por espaço e por elemento; `allow` → INSERT do asset (com `reservable: true`, como antes);
  qualquer outra decisão → sem asset (a entity continua a ser criada, como antes com os sensores).
- `reservationDatabase.createReservation` → `getReservationRequestValidator().validate(...)`
  antes das verificações de conflito; não-allow → `throw Error(reasons[0])`, que os handlers
  HTTP devolvem como `400` com a mesma mensagem da baseline.

**Separações garantidas:**
- O validador decide se o pedido pode ser **submetido** — não aprova nada; pedido permitido
  entra como `pending`, exatamente como antes.
- Disponibilidade temporal e conflitos continuam onde estavam (`hasApprovedConflict`,
  `hasActorConflict`, `getAvailability`), fora da política.
- Nenhum endpoint de aprovação/rejeição foi criado; nenhum portal de gestor; nenhum estado novo.
- Nenhuma infraestrutura semântica foi introduzida (há um teste que o verifica).

**Log estruturado:** cada validação de pedido emite uma linha JSON no stdout do backend:
`{"type":"policy_evaluation","stage":"reservation_request","evaluatorId":...,"decision":...,"reasons":[...],"evaluatedAt":...,"assetId":...,"actorId":...}`.
A reservabilidade não é logada por omissão (uma linha por elemento em cada snapshot seria ruído).

## 3. Testes

`back/tests/policies/policy.test.ts` (14 testes novos; total do projeto 57), cobrindo as 12
provas exigidas pelo prompt. Os 43 testes de caracterização da baseline continuam a passar
sem alterações — é essa a prova principal de que o comportamento não mudou.

## 4. Testes manuais (comparação com a baseline)

Pré-requisitos: os 3 serviços a correr (ver MANUAL_TESTS.md §1). **Reinicia o backend**
para carregar o código novo.

1. **Contagem de assets antes** (SQL):
   ```sql
   SELECT model_version_id, asset_type, COUNT(*) FROM assets GROUP BY model_version_id, asset_type;
   ```
   Guarda o resultado (ex.: última versão do ModeloX: 2 space + 6 equipment).

2. **Recarregar o mesmo IFC da baseline**: Bruno **Models → Upload model** com o mesmo
   ficheiro e `modelId` do modelo existente (cria nova versão). Esperado: `200` com novo
   `versionId`.

3. **Comparar assets**: repete o SQL do passo 1. Esperado: a nova versão tem **exatamente
   as mesmas contagens** por `asset_type` que a versão anterior, e os sensores continuam
   sem asset:
   ```sql
   SELECT e.ifc_type, COUNT(*) FROM entities e
   LEFT JOIN assets a ON a.model_entity_id = e.id
   WHERE e.model_version_id = <novaVersao> AND a.id IS NULL GROUP BY e.ifc_type;
   ```
   → só classes de sensor (ex.: `IfcSensor`).

4. **Mesmos elementos reserváveis**: `http://localhost:3000/student` → seleciona o modelo →
   duplo-clique num equipamento → **Selected** mostra `Asset ID` + botão **Reservar**
   (igual à baseline). Elemento fora do inventário → mesma mensagem de sempre.

5. **Pedido válido**: Bruno **Reservation → Request reservation** com datas futuras →
   `201` `{"message":"Reservation request created","reservationId":N}`; SQL:
   `SELECT status FROM res_reservations WHERE id = N;` → **`pending`** (mesmo estado da baseline).

6. **Datas tecnicamente inválidas**: mesmo request com `endTime` ≤ `startTime` →
   `400 "End time must be after start time"`; com `startTime` no passado →
   `400 "Cannot create reservation in the past"` (mesmas mensagens).

7. **Ativo indisponível**: cria conflito (aprova uma reserva via SQL e tenta o mesmo
   intervalo) → `400 "Asset already reserved for this period"` — prova que a
   disponibilidade temporal continua a funcionar fora da política.

8. **Nenhum efeito de aprovação**: 
   ```sql
   SELECT DISTINCT status FROM res_reservations;
   ```
   → apenas estados já conhecidos (`pending`, `approved`, `in_use`, `completed`,
   `cancelled`, `no_show`, `overdue`); nenhuma tabela nova:
   `SHOW TABLES;` → mesmas tabelas do snapshot. Não existe endpoint
   `POST /api/reservation/approve` (→ `404 Cannot POST`).

9. **Estados existentes intactos**: as reservas `overdue` da baseline continuam visíveis
   em **Your Reservations → In Use** com a etiqueta "Reserva terminada — checkout pendente".

10. **Regras de cancelamento**: Bruno **Cancel reservation** — `pending` cancela a qualquer
    momento (`200`); `approved` a <24h do início → `400` com a mensagem das 24h.

11. **Consultar a reserva**: `GET http://localhost:3001/api/reservation/actor/pg202404` →
    lista igual à da baseline.

12. **Logs estruturados**: no terminal do backend, cada pedido de reserva (passos 5–7)
    imprime uma linha `{"type":"policy_evaluation","stage":"reservation_request",...}`
    com `decision` (`allow`/`deny`) e `reasons`.

## 5. Clarificações dos testes manuais (feedback 2026-07-15)

- **Teste 3 (LEFT JOIN vazio)**: `empty set` é o resultado **esperado** quando o modelo
  não tem nenhum elemento da classe exata `IfcSensor` — nesse caso nenhum elemento é
  excluído e todas as entities têm asset. Os "sensores" do ModeloX vêm do Revit como
  outras classes (ex.: `IfcDistributionControlElement`) e, tal como na baseline, viram
  assets. A query só devolve linhas em modelos IFC4 com `IfcSensor` verdadeiros.
- **Teste 10 (cancelamento approved <24h)**: para ver a mensagem das 24h, a reserva tem
  de estar `approved` com início **no futuro** (ex.: daqui a 2h). Se o início já passou
  há mais de 10 minutos sem check-in, o update lazy converte-a primeiro em `no_show`, e o
  cancelamento responde corretamente "Reservation cannot be cancelled" (estado final não
  cancelável) — foi o que aconteceu no teste.
- **Teste 12 (logs)**: os logs `policy_evaluation` só existem no código novo — é preciso
  **reiniciar o backend** depois desta etapa.
- **Pedido duplicado do mesmo utilizador**: a regra **já existe desde a baseline** —
  `hasActorConflict` bloqueia no backend um segundo pedido do mesmo ator para o mesmo
  asset com período sobreposto, enquanto o primeiro estiver `pending` ou `approved`
  (`400 "You already have a reservation overlapping this period"`). Está coberta pelo
  teste de caracterização "auto-conflito do ator" e confirmada na BD (zero sobreposições
  do mesmo ator). Nenhuma alteração foi necessária.

## 6. Regra futura registada (NÃO implementada — decisão 2026-07-15)

**Aprovação com auto-rejeição de sobreposições**: vários utilizadores podem ter pedidos
`pending` sobrepostos para o mesmo asset (comportamento desejado). Quando o gestor
aprovar um deles, o sistema deverá **automaticamente rejeitar** os restantes pedidos
`pending` do mesmo asset com período sobreposto. Notas para a implementação futura:

- o valor `rejected` **já existe** no ENUM de `res_reservations.status` (nunca usado pelo código);
- a transição deve ser atómica com a aprovação (mesma transação);
- depende da existência da operação de aprovação (portal/endpoint de gestor), que
  continua por implementar — ver P1 no BASELINE.md;
- ponto natural de implementação: futura operação `approveReservation` na camada de
  reservas, atrás da fronteira de políticas criada nesta etapa.

## 7. Riscos conhecidos desta etapa

- O evaluator corre agora **dentro da transação** do snapshot (uma chamada async por
  elemento). Com o provider legacy é síncrono na prática (sem I/O); um provider futuro
  com I/O externo deve avaliar fora da transação ou em lote.
- As mensagens de erro do validador legado são contrato de facto com o frontend/Bruno —
  não alterar as strings sem etapa própria.
- `resetPolicyProviders`/setters são globais ao processo — em produção só devem ser
  usados no arranque; a escolha por env var é lida uma vez (cache) por processo.
