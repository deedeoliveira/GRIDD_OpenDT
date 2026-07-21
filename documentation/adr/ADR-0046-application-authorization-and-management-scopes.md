# ADR-0046 — Application authorization and management scopes

`reservation_manager` is an application role, not an institutional role. A
manager action requires an active session, active application account, role and
an explicit active asset scope. Institutional Professor/Doctoral roles never
grant application authorization.
