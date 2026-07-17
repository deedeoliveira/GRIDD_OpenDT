# ADR-0016 — Arquitetura geral de requisitos de informação (e futura substituição por IDS)

- **Estado**: aceite (revisão do Prompt 4, 2026-07-17)
- **Contexto**: o `spatial_preflight` (ADR-0009) validava apenas requisitos
  espaciais. A revisão exige requisitos de equipamentos e proxies, e o
  projeto quer, no futuro, requisitos exprimíveis por IDS (buildingSMART)
  registados por um gestor — sem reescrever o upload.
- **Decisão**:
  - etapa única `model_requirements_preflight` no upload, DEPOIS da extração
    Python e ANTES de qualquer persistência (entities/assets/bindings/casos);
  - contrato `ModelInformationRequirementsValidator` (`requirements/`):
    `validate(ExtractedIfcModel, ctx) → {status: conforms|does_not_conform|
    error, profileId, profileVersion, findings[], evaluatedAt}`; cada finding
    tem `requirementId` estável, severidade, entidade (guid/classe/nome/
    ObjectType/Tag), mensagem e detalhes estruturados;
  - seleção central `MODEL_REQUIREMENTS_PROVIDER=project-profile-v1`
    (registry; provider substituível em testes);
  - o provider atual (`ProjectProfileRequirementsValidator`) orquestra
    validadores INDEPENDENTES e modulares:
    `SpatialInformationRequirementsValidator` (o serviço do ADR-0009,
    preservado; SPACE-001..003), `ProxyInformationRequirementsValidator`
    (PROXY-001..003) e `EquipmentInformationRequirementsValidator`
    (EQUIPMENT-001..003);
  - as regras atuais são o **current project information-requirement
    profile** — implementadas diretamente pela aplicação. **Não são IDS.**
    Algumas poderão futuramente ser expressas por IDS, mas a cobertura exata
    terá de ser verificada nessa implementação futura;
  - falha → HTTP 422 estruturado (sem stack trace), versão `failed` com
    `failure_reason = "model_requirements_preflight: <REQUIREMENT-IDs> ..."`,
    versão anterior continua corrente, compensações completas.
- **Preparação para IDS (não implementado nesta etapa)**: um futuro
  `IdsModelRequirementsValidator` regista-se no mesmo provider; um IDS
  carregado por um gestor poderá ser associado a linked_model/model/tipo de
  modelo/upload sem alterar `modelUploadService`, identidade de espaços/
  ativos, reservas ou frontend. Sem upload/armazenamento/parser/validação
  IDS, sem UI de configuração, sem SHACL, sem ontologia por agora.
