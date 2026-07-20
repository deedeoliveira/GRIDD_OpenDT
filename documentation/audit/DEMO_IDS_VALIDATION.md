# Technical preparation — IDS functional demonstrator

This document is for the technical executor. **Not intended as a required
manual test for the researcher.** The researcher follows only
`MANUAL_TESTS.md §24`.

## Safe local preparation

1. Install `back/python/requirements.txt` inside the project venv; never
   globally.
2. Apply `database/migrations/2026-07-20_ids_validation.sql` manually to the
   local demo database only. The setup command never applies migrations.
3. In ignored `back/.env`, set the exact flags:
   `IDS_VALIDATION_ENABLED=true`, `IDS_VALIDATION_MODE=required`,
   `IDS_PROFILE_FAMILY_KEY=oswadt-ifc4-model-requirements`, and
   `IDS_DEMO_MODE=true`.
4. From `back/`, run `npm run ids:demo:setup`. This dry-run checks migration,
   manifest/profile integrity, real executor loading and all three fixtures.
5. Run `npm run ids:demo:setup -- --execute`. It registers/activates only the
   governed IDS revision and persists demo reports. It does not write Fuseki,
   reset data, apply migrations, alter models or touch reservations.
6. Start/restart backend and frontend and open
   `http://localhost:3000/ids-demo`.

The command is idempotent and refuses production. Its allowlist is fixed to
Missing Reference, Valid Model and Duplicate Reference fixtures. It never
accepts a client path or arbitrary IDS XML.

## Expected functional results

| Scenario | IDS | Project rules | Overall |
|---|---|---|---|
| Missing Reference | FAIL | PASS/not primary cause | FAIL |
| Valid Model | PASS | PASS | PASS |
| Duplicate Reference | PASS | FAIL | FAIL |

No reservation, eligibility, authorization or approval decision occurs.
