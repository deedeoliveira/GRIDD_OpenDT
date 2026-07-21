# Reservation approval walkthrough

The technical executor prepares synthetic accounts and scopes. The researcher
uses `/student`, `/login` and `/dashboard/reservations`; no SQL, migrations,
locks or commands are required.

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
