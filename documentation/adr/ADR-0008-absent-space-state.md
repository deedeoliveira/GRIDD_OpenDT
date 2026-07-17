# ADR-0008 — Estado dos espaços ausentes de uma versão autoritativa

- **Estado**: aceite (Prompt 3, 2026-07-16)
- **Contexto**: quando uma versão ativa do modelo espacial autoritativo deixa
  de conter um código, o espaço persistente não pode ser apagado (tem
  histórico, e no Prompt 4 poderá ter ativos/reservas ligados).
- **Decisão** — estados de `spaces`:
  - `active`: o código está presente na versão corrente do modelo autoritativo;
  - `absent`: o código deixou de aparecer na versão corrente autoritativa —
    marcado automaticamente na reconciliação pós-ativação; volta a `active`
    se o código reaparecer;
  - `retired`: reservado para uma operação humana explícita futura (com
    `retired_at`); **nunca** é atribuído automaticamente nesta etapa.
- **Regras**:
  - a reconciliação corre APÓS ativação bem-sucedida, e apenas para o modelo
    autoritativo; falha na reconciliação é registada (`reconcile_failed`) e não
    reverte a ativação — o estado reconcilia-se no upload seguinte;
  - ausência em modelos não autoritativos nunca altera estado;
  - bindings históricos são sempre preservados;
  - reservas e ativos não são tocados (a reconciliação com ativos é trabalho
    explícito do Prompt 4 — os casos `absent` são o input dessa etapa).
