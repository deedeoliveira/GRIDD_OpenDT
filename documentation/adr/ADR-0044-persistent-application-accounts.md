# ADR-0044 — Persistent application accounts

Application accounts are persistent local application records, separate from
institutional agents and roles. They use synthetic opaque keys, immutable UUIDs
and status (`active`, `suspended`, `disabled`); no password, personal identity
or institutional URI is stored. New local-session reservations and semantic
evidence retain the resolved account FK while legacy actor snapshots remain for
compatibility. This is not production authentication.
