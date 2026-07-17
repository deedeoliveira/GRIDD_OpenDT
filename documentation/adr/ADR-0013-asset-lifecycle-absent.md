# ADR-0013 — Ciclo de vida dos ativos: absent bloqueia novas reservas, preserva existentes

- **Estado**: aceite (Prompt 4, 2026-07-17)
- **Contexto**: um ativo pode desaparecer da versão corrente sem ter sido
  removido fisicamente (omissão de modelação) — apagar seria destrutivo e
  reservas existentes não podem ser silenciosamente perdidas.
- **Decisão** — `assets.lifecycle_status`:
  - `active`: com binding na versão corrente da sua linha de modelo;
  - `absent`: tem histórico na linha mas não aparece na versão corrente —
    marcado na reconciliação pós-ativação; volta a `active` se reaparecer;
    ativos-espaço seguem o estado do espaço persistente (ADR-0008);
  - `pending_reconciliation`: reservado para estados intermédios de
    reconciliação;
  - `retired`: **apenas** por ação humana (resolução `confirm_replacement`
    ou operação administrativa); nunca inferido.
- **Regras**:
  - `absent`/`pending_reconciliation`/`retired` **bloqueiam reservas
    NOVAS** (`createReservation` rejeita com a razão do ciclo de vida);
  - reservas existentes **não são alteradas nem canceladas** — ficam
    visíveis para gestão humana;
  - ciclo de vida ≠ reservabilidade: `reservable` continua a ser a projeção
    da política; o ciclo de vida reflete presença física/modelada;
  - a reconciliação nunca apaga e corre após a ativação (falha é logada,
    não reverte o upload).
