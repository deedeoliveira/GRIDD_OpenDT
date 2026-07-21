# ADR-0045 — Session-resolved identity boundary

The backend alone resolves an opaque HttpOnly local-development cookie through
`ApplicationIdentityProvider`. `local_session` is refused in production. The
frontend never stores a token or submits an actor to establish identity; it can
only display the account returned by `/api/auth/session`. OIDC, SAML, LDAP,
MFA, manager authorization and production identity providers remain future
work.
