# Reservation approval walkthrough

The technical executor prepares synthetic accounts and any scoped reservation
fixtures required for a decision walkthrough. The researcher uses `/student`,
`/login` and `/dashboard/reservations`; no SQL, migrations, locks or commands
are required. An active `reservation_manager` role opens the manager workspace;
asset scopes only authorize reviews and decisions for their assigned assets.

## Manager with no assigned assets

1. Sign in as an active manager with no reservation-management scopes.
2. Open `/dashboard`, then **Gerir modelos**: the controlled intake workspace
   opens even when the model list is empty.
3. Open **Reservas e decisões**: the queue responds normally with zero items.
4. Do not create a reservation or scope. Any direct review, refresh, approval,
   rejection, or manager cancellation for an unassigned asset must be refused.

This verifies workspace access without broadening reservation-decision
authority.

## Approved walkthrough outcome

The controlled researcher walkthrough was approved. Test A confirmed explicit
approval; Test B confirmed that a second overlapping request remains pending
when the SQL transaction finds a conflict; Test C confirmed the separate
shadow-not-eligible acknowledgement and rejection paths; and Test D confirmed
manager cancellation before check-in, including the decision reason shown to
the student. The initial pending labels in the preparation table below are
therefore superseded by this approved record.

| Teste ou grupo | O que está sendo testado em linguagem comum | Resultado |
|---|---|---|
| A — approval | Um pedido pending é revisto e aprovado explicitamente por um gestor autorizado. | Pendente do walkthrough |
| B — conflict | Dois pedidos podem aguardar, mas o SQL impede a segunda aprovação sobreposta. | Pendente do walkthrough |
| C — revoked evidence | Evidência shadow negativa é mostrada ao gestor, que rejeita com motivo. | Pendente do walkthrough |
# Test D — manager cancellation

The researcher submits a synthetic request, the manager approves it, then
cancels it before check-in with a reason; the student sees `cancelled` and the
reason. The in-use variant is executor-level automation: after check-in, only
the student can complete checkout.

Evidence expiry and refresh were verified automatically and by executor-level integration smoke; the researcher-facing expired fixture was not exercised.
