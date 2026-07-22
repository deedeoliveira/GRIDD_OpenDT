# ADR-0045 — Session-resolved identity boundary

The backend alone resolves an opaque HttpOnly local-development cookie through
`ApplicationIdentityProvider`. `local_session` is refused in production. The
frontend never stores a token or submits an actor or role to establish identity;
it can only display the account and server-resolved `applicationArea` returned
by `/api/auth/session`. An active `reservation_manager` role resolves the
manager area independently of reservation asset scopes. OIDC, SAML, LDAP, MFA
and production identity providers remain future work.
