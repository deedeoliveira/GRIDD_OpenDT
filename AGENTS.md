# Repository instructions

- Respect the documented SQL/graph authority for each entity and property.
- Never commit personal data, personal URIs, private institutional identifiers, or real-person fixtures.
- Semantic releases and their source payloads are immutable. Add a new version instead of editing an existing release.
- Every forward SQL migration requires a scoped rollback migration.
- The frontend must never write directly to Fuseki or to SQL projection tables.
- Never use `CLEAR` or `DROP` with `ALL`, `NAMED`, or `DEFAULT`.
- Rollback of semantic activation moves the SQL current pointer; it never deletes a historical graph.
- Default fixtures and demonstrations committed to the repository must be synthetic.
- Distinguish implemented, prepared, and future capabilities in code and documentation.
- Do not claim IDS, IFC-to-RDF, SHACL execution, or semantic eligibility without executable evidence.
- Do not change reservations or policy behaviour as a side effect unless that change is explicitly in scope.
- Do not apply migrations, commit, or push unless explicitly requested.
- Do not commit before the researcher's functional walkthrough unless an explicit later instruction authorizes it.
- Manual tests for the researcher must be functional and observable; technical setup is the executor's responsibility.
- Every test list must explain in plain language what is being tested, not only name files or suites.
- Researcher manual evidence must use researcher-selected inputs; preset-only pages are insufficient.
- Backend-computed hashes identify uploaded evidence. The frontend must not simulate hashes, requirements, RDF or validation results.
- Model-intake preview must not persist a model version; creation is always a separate explicit action.
- Test harness pages are not a substitute for integration into the real management UX.
- Never call a custom validator IDS; IDS claims require a genuine standard-compatible executor.
- Loading a shapes graph is not SHACL execution.
- SHACL claims require the real pinned pySHACL provider over the exact data and
  shapes bytes; frontend labels or TypeScript checks are not execution evidence.
- Keep IDS requirements, project rules, SHACL structural constraints and
  operational decisions visibly separate in contracts, UI and documentation.
- Temporary shapes are local/dev, non-governed and ephemeral; they must never
  enter the registry/Fuseki or decide activation in required mode.
- Keep IDS results, project rules, eligibility decisions, and reservation decisions as separate layers.
- Semantic reservation eligibility is shadow-only until a later explicit scope;
  it must never disable creation, authorize, approve or replace SQL conflicts.
- Evidence preview and reservation creation are separate explicit actions. A
  preview must not create, cancel or modify a reservation.
- Reservation evidence graphs must be minimal, immutable and free of actor
  keys, person labels, student numbers, credentials and complete payloads.
- Minimum verification: `cd back && npm test`, `cd back && npx tsc --noEmit`, `cd front && npx tsc --noEmit`, and `cd front && npm run build`.
- Application accounts are distinct from institutional agents, roles and actor
  links. In local-session mode, identity must be resolved server-side from the
  opaque cookie; frontend actor fields are never authority.
