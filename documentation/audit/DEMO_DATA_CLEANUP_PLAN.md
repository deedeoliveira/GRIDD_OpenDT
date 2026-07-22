# Local demonstration data cleanup plan — not executed

This is a future, local-only plan. It must be explicitly authorized before any
action and must never use a full reset, indiscriminate deletion, or graph-wide
drop.

1. Inventory the local records and preserve migrations, public semantic
   artefacts and registry state, approved ontology/IDS/shapes/mapping/policy,
   required synthetic accounts, roles, scopes and configuration.
2. Identify technical reservations, revoked sessions, evidence runs, review
   evidences, smoke decisions, temporary uploads, technical model versions and
   exclusively technical graphs by their documented synthetic provenance.
3. Archive or remove only the approved identifiers in dependency order:
   review evidence and run references first, then smoke decisions and technical
   reservations, then temporary model/version material. Historical governed
   graphs are never deleted by pointer rollback.
4. Verify that retained accounts, scopes, current model pointers and public
   artefact integrity remain intact before and after each scoped operation.

Risks: an incomplete provenance inventory can remove useful research evidence;
foreign keys can block the intended order; technical and demonstration data may
be mixed. Therefore the plan is not a command and has not been executed.
