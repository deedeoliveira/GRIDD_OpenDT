# ADR-0046 — Application authorization and management scopes

`reservation_manager` is an application role, not an institutional role. An
active session for an active account with that role resolves to the manager
application area and grants access to the dashboard and controlled model
intake. It does not grant authority over every asset.

An explicit active `reservation_management_scope` remains mandatory to list,
open review evidence for, approve, reject, or cancel a reservation for its
asset. A manager with no active scopes receives an empty reservation queue and
cannot act on any reservation. Institutional Professor/Doctoral roles never
grant application authorization. This is a demonstrator authorization boundary,
not a claim of complete production RBAC.
