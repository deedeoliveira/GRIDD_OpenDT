# ADR-0014 — Snapshots de contexto no momento da reserva

- **Estado**: aceite (Prompt 4, 2026-07-17)
- **Contexto**: a reserva referencia o ativo persistente (`asset_id`), mas
  o contexto em que foi feita (versão corrente, nome, espaço) muda com o
  tempo; para auditoria e para exibir reservas históricas fielmente é
  preciso congelar esse contexto.
- **Decisão** — `res_reservations` ganha 5 colunas NULLABLE preenchidas em
  `createReservation`:
  - `asset_binding_id_at_booking`, `model_version_id_at_booking`:
    binding/versão correntes do ativo no momento (binding cuja versão é a
    `models.current_version_id` do seu modelo — nunca o maior id);
  - `asset_name_snapshot`, `space_id_at_booking`, `space_code_snapshot`.
- **Regras**:
  - snapshots são **contexto**, não identidade: conflitos e continuidade
    usam SEMPRE `asset_id`;
  - ativos sem binding corrente (ex.: legados pré-backfill) reservam com
    snapshots NULL — a ausência de snapshot nunca impede a reserva;
  - snapshots nunca são atualizados retroativamente por uploads.
