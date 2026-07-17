# Prompt 4 — Identidade persistente dos ativos (2026-07-17)

Objetivo: `assets` deixa de ser "linhas por versão" e passa a representar
**recursos físicos persistentes**; cada versão liga-se a eles por
`asset_bindings`. **Invariante central: uma nova versão IFC nunca cria uma
nova identidade operacional para o mesmo recurso — as reservas sobrevivem à
troca de versão e não podem ser contornadas por um novo `asset_id`.**

Âmbito negativo (respeitado): sem RDF/SPARQL/ontologias/SHACL, sem ativos
não modelados vindos de grafos, sem novas políticas de reservabilidade, sem
aprovação de gestor, sem UI extensa de reconciliação, sem robustez completa
de concorrência (Prompt 6).

## 1. Auditoria do estado anterior (2026-07-17)

- `assets` tinha FK obrigatória `model_version_id` + `model_entity_id`/
  `current_space_entity_id`: cada upload criava linhas novas (8 grupos de
  GUID duplicados na linha do modelo 1, um por versão).
- Reservas: **0 linhas** em `res_reservations` no momento da migração — a
  migração de dados de reservas foi trivialmente limpa.
- Evidência de identidade nos IFCs reais: **sem** códigos institucionais e
  **sem** seriais nos equipamentos (nomes têm apenas sufixo de tag Revit,
  que não é evidência); logo, para linhas legadas o único mecanismo
  verificável é o IFC GUID dentro da mesma linha de modelo.
- Espaços persistentes (Prompt 3) existiam com códigos `SPC-*`/`R-*` e
  bindings — âncora pronta para os ativos-espaço.

## 2. Esquema (migração `2026-07-17_asset_identity.sql`, expand-and-contract)

- `assets`: `model_version_id` → NULLABLE; + `asset_uuid` (UNIQUE),
  `asset_code`, `semantic_uri` (reservado), `space_id` (UNIQUE, FK
  `spaces`), `linked_model_id` (FK), `source` ('ifc'), `lifecycle_status`
  ENUM('active','absent','pending_reconciliation','retired'), `updated_at`,
  `retired_at`. Colunas legadas preservadas (contract fica para etapa
  posterior).
- `asset_bindings`: (`asset_id`, `model_version_id`, `model_entity_id`
  UNIQUE, `space_id`, `space_entity_id`, `ifc_guid`, snapshots
  código/nome/tipo, `binding_status`, `reconciliation_status/method/
  confidence`); UNIQUE (`asset_id`,`model_version_id`).
- `asset_reconciliation_cases`: candidatos ambíguos/não resolvidos
  (`candidates_json`, `status` open/resolved_*/ignored, `resolved_asset_id`).
- `legacy_asset_mapping`: relatório persistente do backfill
  (promoted/merged/unrecoverable).
- `res_reservations`: + 5 colunas de snapshot NULLABLE (ADR-0014).
- Rollback: `2026-07-17_asset_identity_rollback.sql`.

## 3. Matriz de evidência de identidade (equipamentos — ADR-0011)

> **SUPERSEDED pela revisão (§14):** a ordem Reference>Serial>GUID abaixo
> foi substituída por IfcElement.Tag (EQP-) + serial como evidência separada.
> Mantida como registo histórico.

| Ordem | Evidência | Método | Confiança | Resultado |
|---|---|---|---|---|
| 1 | `Reference` em `Pset_*Common` (1.º por ordem alfabética) | `asset_code` | alta | matched/ambiguous/new |
| 2 | `Pset_ManufacturerOccurrence.SerialNumber` | `serial_number` | alta | idem |
| 3 | mesmo IFC GUID na MESMA linha de modelo | `ifc_guid` | média | matched/ambiguous |
| 4 | primeira versão inventariada da linha | `first_version` | média | new |
| 5 | nada disto (versão posterior) | — | — | **unresolved → caso humano** |

Nunca há correspondência por nome/espaço/tipo/semelhança. Resolver
substituível: env `ASSET_IDENTITY_PROVIDER`, registry em
`identity/assetIdentityProvider.ts`.

Ativos-espaço não usam esta matriz: identidade = `spaces.id` (1:1,
ADR-0015); espaço sem identidade persistente não gera ativo.

## 4. Fluxo de upload (etapas novas)

`spatial_preflight → inventory (só entities) → spatial_identity →`
**`asset_reconciliation / asset_policy / asset_binding`** `→ activation →`
reconciliação pós-ativação (espaços + ciclo de vida dos ativos).

- O snapshot de inventário (`saveInventorySnapshot`) já **não cria ativos**
  — devolve os mapas guid→entity_id; a criação vive em
  `services/assetInventoryService.ts`.
- `failure_reason` com prefixo da etapa real (`asset_binding: ...` etc.).
- Compensações em falha: `asset_bindings`/`asset_reconciliation_cases` da
  versão removidos; ativos criados EXCLUSIVAMENTE pela operação só são
  removidos se não tiverem bindings de outras versões, reservas nem casos
  resolvidos a apontar (guardas `NOT EXISTS`); a versão anterior continua
  corrente.
- Casos pendentes **não bloqueiam a ativação**: a geometria fica visível,
  o inventário fica incompleto e sinalizado (log `pending_reconciliation`
  + `GET /api/asset/reconciliation/cases`).

## 5. Política de reservabilidade (preservada, ADR separada da identidade)

- allow → ativo criado/projetado `reservable=1`;
- deny em candidato **novo** → comportamento legado: sem ativo (IfcSensor);
- deny/undetermined/error em ativo **existente** → apenas projeção
  `reservable=0`; identidade, bindings e reservas intocados (estratégia
  defensiva documentada — nada é apagado por decisão de política).

## 6. Reservas (ADR-0013/0014)

- conflitos continuam por `asset_id` persistente (nunca por versão);
- `absent`/`pending_reconciliation`/`retired` bloqueiam **novas** reservas
  (`Asset is not available for new reservations (lifecycle: ...)`);
  reservas existentes nunca são alteradas/canceladas automaticamente;
- snapshots na criação: binding/versão correntes (via
  `models.current_version_id`), nome do ativo, espaço e código — NULLABLE.

## 7. Consultas do viewer (reescritas por bindings)

`utils/assetDatabase.ts`: GUID→ativo e espaço→ativos resolvem por
`asset_bindings` da versão pedida (ou da corrente explícita em
`by-guid-latest`); devolvem o ativo persistente (id estável). Nunca
`ORDER BY id DESC`.

## 8. API nova (montada em `/api/asset`)

- `GET /persistent/:assetId` — identidade + ciclo de vida + projeção;
- `GET /:assetId/bindings` — histórico de representação por versão;
- `GET /version/:versionId/bindings`;
- `GET /reconciliation/cases[?status=open|all|...]`;
- `POST /reconciliation/cases/:caseId/resolve` —
  `link_to_existing_asset` (exige `assetId`) | `confirm_as_new_asset` |
  `confirm_replacement` (exige `assetId` do substituído; retira-o) |
  `ignore_non_asset`; cria binding `manual`; `409` se o caso não está
  `open`. Mecanismo administrativo atual = API (sem autenticação na app).

Bruno: pasta **Assets** (5 pedidos).

## 9. Backfill (`scripts/backfillAssets.ts`)

Promover-e-mapear, só com evidência da BD (sem reprocessar IFC):

- espaços: linhas legadas agrupadas por `space_bindings.space_id`; promove
  a linha da versão corrente (senão a mais recente), mapeia as outras;
- equipamentos: agrupados por (modelo, IFC GUID) — códigos não são
  recuperáveis das linhas legadas; sem GUID/space_binding → `unrecoverable`
  (nada inventado);
- reservas de linhas não-promovidas re-apontadas para o promovido;
  **ambiguidade em reserva futura/bloqueante aborta o backfill** (decisão
  humana);
- `--report` por omissão; `--apply` transacional; idempotente
  (`legacy_asset_mapping` + `asset_uuid IS NULL`); linhas legadas
  duplicadas **não são apagadas** (expand-and-contract).

## 10. Ferramenta de reset (atualizada)

`scripts/resetOperationalData.ts` limpa também `asset_bindings`,
`asset_reconciliation_cases`, `legacy_asset_mapping` (ordem FK-safe).
⚠️ Correção de segurança importante: o storage root é agora **injetável**
e os testes usam um diretório descartável — ver §12.

## 11. Testes (198 total; 157 do Prompt 3 preservados ou atualizados com justificação)

Novos (`tests/assets/`): `assetResolver` (evidência/ordem/registry),
`assetInventory` (espaço 1:1, matched/ambíguo/unresolved, política,
ciclo de vida, compensação guardada), `reservationContinuity` (lifecycle
bloqueia novas/preserva existentes, conflito por asset_id, snapshots),
`assetUploadFlow` (integração, casos não bloqueiam ativação,
failure_reason por etapa, compensações), `assetBackfill` (report/apply/
aborta-ambíguo/unrecoverable/idempotente).

Atualizados com justificação (comportamento explicitamente alterado pelo
Prompt 4): `characterization/inventory.test.ts` (snapshot já não cria
ativos), `characterization/asset.test.ts` (consultas por bindings),
`policies/policy.test.ts` (provas de política no fluxo persistente),
`versioning/uploadFlow.test.ts` e `spaces/spaceUploadFlow.test.ts` (rotas
do fluxo de ativos; espaço sem identidade já não gera ativo),
`spaces/resetTool.test.ts` (tabelas novas + storage descartável).

## 12. Incidente: perda de ficheiros IFC causada pelos testes do reset (2026-07-17)

Durante a organização de commits do Prompt 3, o teste do reset executava
`runOperationalReset(true)` com BD falsa mas **filesystem real**: cada
`npm test` apagava `back/cdn_resources/models/*/versions/*` reais e
sobrescrevia o backup `_backup_reset_2026-07-17/db_operational_data.json`
com dados fake. Consequência: os ficheiros das versões 1–12 (uploads dos
modelos 1–7) foram perdidos; o backup JSON do reset do P3 foi sobrescrito
(o backup do wipe `_backup_2026-07-16` está intacto). Correção aplicada:
`ResetOptions.storageRoot` injetável, testes usam `mkdtemp` descartável,
nome do diretório de backup com timestamp ISO completo (único por
execução), aviso no próprio teste. Os IFCs de origem existem fora da app;
o roteiro §17 parte de uploads novos.

## 13. Limitações conhecidas

- IFCs reais sem código/serial: continuidade de equipamentos legados
  assenta em GUID (média confiança); recomenda-se incluir
  `Pset_*Common.Reference` nos exports futuros;
- `semantic_uri` reservado (integração semântica fora do âmbito);
- resolução de casos sem UI dedicada (API/Bruno) e sem autenticação;
- concorrência (uploads/resoluções simultâneos) tratada apenas ao nível
  das transações existentes — robustez completa é Prompt 6;
- contract das colunas legadas de `assets` (remoção) fica para etapa
  posterior, após validação em uso.

---

# Revisão do Prompt 4 (2026-07-17) — Tag EQP-, classificador e model_requirements_preflight

## 14. Decisões fixadas do perfil

- **Esquema IFC**: o perfil suportado e testado é **IFC4** (sem dependências
  de IFC4x3/IFC4.3; outro esquema não é rejeitado automaticamente — apenas
  IFC4 é testado). Fixtures geradas com `version="IFC4"`.
- **Espaços** (inalterado): `Pset_SpaceCommon.Reference` = código
  institucional e identidade persistente; não determina reservabilidade.
- **Equipamentos modelados**: `IfcElement.Tag` = código institucional
  controlado pelo gestor; válida = string, não vazia, prefixo EXATO `EQP-`,
  com conteúdo após o prefixo (fonte única:
  `classification/equipmentTag.ts`).
- **Serial**: opcional; evidência da instância física; campo SEPARADO
  (`assets.serial_number` + `asset_bindings.serial_snapshot` — migration
  `2026-07-17_equipment_tag_serial.sql`, aplicada); nunca substitui Tag,
  nunca em `asset_code`.
- **Manufacturer/marca/modelo comercial**: nunca identidade, chave,
  confiança ou reconciliação (guarda automatizada); apenas metadados.
- **ObjectType — âmbito exclusivo do proxy (clarificação final)**: só é
  relevante quando a entidade é IfcBuildingElementProxy (obrigatório +
  Tag EQP-; explica o tipo definido pelo modelador; nunca identidade).
  Em classes IFC específicas: não exigido, sem papel em requisitos,
  classificação, identidade, reconciliação, confiança, fallback de Tag ou
  distinção substituição/continuidade; `object_type_snapshot` NULL em
  não-proxies mesmo com valor no export (payload bruto pode mantê-lo para
  diagnóstico, sem efeito de domínio).
- **GUID**: rastreabilidade no binding + compatibilidade histórica no
  backfill (`legacy_ifc_guid`, confiança média); sem fallback em novos
  uploads; nunca vira `asset_code`.
- **Ativos não modelados**: intocados; terão perfil de identidade próprio
  (UUID da aplicação, código do gestor opcional, serial opcional); as regras
  IFC deste prompt não se lhes aplicam; nenhuma informação IFC será
  fabricada para eles.

## 15. Auditoria e matriz de classificação (2026-07-17)

Classes efetivamente presentes na BD (entities) e fixtures:

| Classe IFC | Exemplo real | Tratamento anterior | Classificação nova | Propriedades exigidas | Razão |
|---|---|---|---|---|---|
| IfcSpace | Sala P4 A | entity space + ativo-espaço | space | Pset_SpaceCommon.Reference | identidade espacial (P3/ADR-0015) |
| IfcBoiler | HVAC_Boilers_LAARS… | candidato (política allow) | managed_equipment | Tag EQP- | IfcEnergyConversionDevice (MEP operacional) |
| IfcUnitaryEquipment | HVAC_Boilers_FT-TESTE | idem | managed_equipment | Tag EQP- | idem |
| IfcElectricAppliance | HVAC_Boilers…(elétrico) | idem | managed_equipment | Tag EQP- | IfcFlowTerminal |
| IfcLightFixture | Sensor3_GenericModel… | idem | managed_equipment | Tag EQP- | IfcFlowTerminal |
| IfcOutlet | Sensor2_DataDevice… | idem | managed_equipment | Tag EQP- | IfcFlowTerminal |
| IfcBuildingElementProxy | Betoneira P4 (fixture) | candidato | managed_equipment SÓ com ObjectType + Tag EQP-; senão invalid_proxy → 422 | ObjectType + Tag EQP- | regra do perfil (ADR-0018) |
| IfcSensor | fixtures de teste | entity SEM asset (política nega) | managed_equipment (política continua a negar reservabilidade) | Tag EQP- | elemento operacional; exclusão é da POLÍTICA, não da classificação |
| IfcFurniture | "Mesa" (testes) | candidato | managed_equipment | Tag EQP- | mobiliário gerido |
| (famílias IFC4 arq/estrutura) | — | candidato se contido em espaço | architectural/structural_element | — (sem Tag) | taxonomia IFC4 |
| qualquer outra | — | candidato | **undetermined** (entity sem asset, diagnóstico explícito) | — | nada é inventado nem silenciosamente ignorado |

O classificador anterior era implícito ("não-espaço = equipamento") e usava
a política para excluir IfcSensor; agora a classificação é central
(`classification/`, ADR-0017), substituível
(`EQUIPMENT_CLASSIFIER_PROVIDER=project-profile`) e nunca consulta a
política nem a presença de Tag para classes normais.

## 16. model_requirements_preflight (ADR-0016)

`Python extraction → model_requirements_preflight (SPACE → PROXY →
EQUIPMENT) → entities → identidade dos espaços → reconciliação de ativos →
política → ativação`.

Requisitos do **current project information-requirement profile**
(`MODEL_REQUIREMENTS_PROVIDER=project-profile-v1`; NÃO é IDS — ver
ADR-0016):

- `SPACE-001` modelo espacial autoritativo tem ≥1 IfcSpace;
- `SPACE-002` todos os IfcSpace relevantes têm `Pset_SpaceCommon.Reference`
  válido;
- `SPACE-003` códigos de espaço únicos no âmbito configurado;
- `EQUIPMENT-001` candidato managed_equipment tem `IfcElement.Tag`;
- `EQUIPMENT-002` a Tag começa por `EQP-` (não vazia, não whitespace, com
  sufixo);
- `EQUIPMENT-003` Tags únicas no âmbito de identidade (duplicação na mesma
  versão → falha; entre modelos da federação, a mesma Tag liga ao MESMO
  ativo — nunca segundo ativo silencioso);
- `PROXY-001` todo IfcBuildingElementProxy tem ObjectType não vazio;
- `PROXY-002` todo proxy tem Tag EQP- válida;
- `PROXY-003` proxy conforme é managed_equipment.

Regras espaciais: só no modelo autoritativo (como antes). Regras de
equipamento: qualquer modelo com candidatos geridos (mesmo não
autoritativo); modelo sem equipamentos passa; elementos arquitetónicos/
estruturais não precisam de Tag. Regras PROXY: qualquer proxy, em qualquer
modelo (incluindo proxies fora de espaços — sweep dedicado do Python).

Falha → `422` estruturado (requirement, classe, GUID, Name, ObjectType,
Tag, motivo; sem stack trace), zero persistência, versão anterior corrente,
nova versão `failed` com
`failure_reason = "model_requirements_preflight: <REQ-IDs> — …"`,
compensação de ficheiros. (O prefixo `spatial_preflight:` das versões
falhadas ANTERIORES permanece nos dados históricos — não é reescrito.)

## 17. Resolver revisto (ADR-0011) e reconciliação Tag/serial

`ifc-tag-serial-guid` (alias de configuração: nome antigo). `asset_code` ←
Tag apenas. Regras: mesma Tag+mesmo serial → matched forte; mesma Tag sem
serial → matched com evidência reduzida documentada; mesma Tag+seriais
diferentes → caso (`serial_conflict`); mesmo serial+Tags diferentes → caso
(`serial_renumbering`); sem merge automático em nenhum conflito. ObjectType
→ `object_type_snapshot` no binding (nunca identidade/reconciliação).
Serial enriquece o ativo apenas quando ausente (`setAssetSerialIfMissing`);
divergência nunca é sobrescrita.

## 18. Backfill (relatório; NÃO aplicado)

Método legado renomeado `legacy_ifc_guid` (confiança média nos bindings);
relatório diferencia `legacy_match_by_ifc_guid`, `missing_equipment_tag`
(todas as linhas legadas — Tags nunca foram persistidas),
`requires_reconciliation` (reservas históricas ambíguas), `unrecoverable`;
`matched_by_equipment_tag`/`matched_by_tag_and_serial`/`serial_conflict`/
`tag_conflict` ficam disponíveis para dados que tenham essa evidência.
Versões já ativas aceites antes da regra estrita NÃO são modificadas
retroativamente; ativos/reservas/SmokeP4/bindings antigos intocados.

## 19. Segurança dos testes e storage (reforço pós-incidente)

- `OSWADT_STORAGE_ROOT`: o helper de testes redireciona TODO o storage para
  um diretório temporário descartável — nenhum teste toca em
  `back/cdn_resources`;
- `NODE_ENV=test` é imposto pelo helper; nesse ambiente o reset SEM
  `storageRoot` explicitamente injetado falha de forma segura, e um root
  dentro do storage real é rejeitado (guardas testadas);
- reset não executado; nenhum ficheiro apagado; nenhum IFC reenviado
  automaticamente.

## 20. Mensagens e frontend

Mensagens distintas por requisito (as espaciais preservadas; novas para
Tag ausente/prefixo/duplicada, proxy sem ObjectType, proxy sem Tag EQP-,
conflitos Tag/serial). A aplicação NÃO tem UI de upload (uploads via
Bruno/curl): o diagnóstico completo segue no corpo da resposta 422 da API.
O modal de reservas do frontend já apresenta as mensagens de erro do
backend (incluindo as de ciclo de vida) — nenhuma alteração adicional foi
necessária.

## 21. Testes (249) e validação

Novos: `tests/classification/classifier.test.ts`,
`tests/requirements/requirementsPreflight.test.ts`; reescritos:
`tests/assets/assetResolver.test.ts` (Tag/serial + guardas Manufacturer/
GUID/instanciação); atualizados com justificação: assetInventory,
assetUploadFlow (cenários de preflight EQUIPMENT/PROXY + conflito de
serial), policy, versioning/spaces upload flows (Tags nas fixtures; prefixo
`model_requirements_preflight: SPACE-00x`), resetTool (guardas novas).
