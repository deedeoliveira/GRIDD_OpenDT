# Prompt 7G — Persistent application accounts and session-resolved identity

## Boundary

`CURRENT_APPLICATION_ACTOR_KEY` is a legacy development fallback used only
when identity mode is disabled. In `local_session`, the backend resolves the
application account from an opaque cookie and ignores browser-supplied actor
keys for evidence, requests and own-reservation actions.

Accounts are distinct from institutional agents and links. A valid session can
therefore resolve to a revoked institutional link; a disabled account cannot
start a session. Semantic eligibility remains shadow-only and SQL remains the
availability/conflict authority.

## Local setup

Apply the scoped migration separately, set the five `APPLICATION_*` /
`LOCAL_SYNTHETIC_LOGIN_ENABLED` flags only in ignored `.env`, then run
`npm run application-identity:setup` (dry-run) and
`npm run application-identity:setup -- --execute`. The setup is idempotent,
does not apply migrations, create reservations, reset data or alter RDF.

## Short audit

Before 7G, `currentApplicationActor.ts` read a process-wide actor key and the
student view derived its read-only identity from the reservation API. Reservation
rows stored legacy `actor_id`; actor links were searched by normalized actor
key; 7F evidence stored the normalized actor key. No session/cookie middleware
existed. The 7G local provider is the only direct cookie reader; services receive
a typed resolved identity.

## Walkthrough acceptance

The disabled account was verified by automated coverage and executor smoke with
HTTP 403. Its disabled visual login option was not manually executable and is
accepted for this stage; the final login and account interface will be reviewed
in the later UX consolidation. A local synthetic session is not production
authentication. An active application account may have a revoked institutional
link; that makes shadow eligibility `not_eligible` but does not replace SQL as
the temporal authority or create application authorization.
