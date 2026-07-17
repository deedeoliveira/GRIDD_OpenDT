# ADR-0015 — Ativo-espaço 1:1 com o espaço persistente

- **Estado**: aceite (Prompt 4, 2026-07-17); **substitui** o comportamento
  legado "cada versão cria o seu asset de espaço" (BASELINE §inventário)
- **Contexto**: o Prompt 3 criou a identidade persistente dos espaços
  (`spaces` + `space_bindings`); os ativos reserváveis de espaço tinham de
  ancorar nessa identidade em vez de nascer por versão.
- **Decisão**:
  - `assets.space_id` (UNIQUE, FK `spaces.id`): **um** espaço persistente
    tem **no máximo um** ativo-espaço, reutilizado por todas as versões
    (binding novo por versão, método `space_id`, confiança alta);
  - espaço SEM identidade persistente (sem código em modelo não
    autoritativo) **não gera ativo de espaço** — diagnóstico
    `spaces_without_identity`, upload prossegue. Regra explícita do
    Prompt 4 §6 que substitui a criação legada;
  - o ciclo de vida do ativo-espaço segue o estado do espaço (`active`/
    `absent`; `retired` intocável — ADR-0008/ADR-0013).
- **Consequências**: reservar "a Sala A" significa reservar sempre o mesmo
  `asset_id`, independentemente das versões do modelo espacial; um espaço
  não identificável simplesmente não é reservável (coerente com a regra
  estrita do preflight no modelo autoritativo).
