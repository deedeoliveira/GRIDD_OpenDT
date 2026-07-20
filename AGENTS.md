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
- Minimum verification: `cd back && npm test`, `cd back && npx tsc --noEmit`, `cd front && npx tsc --noEmit`, and `cd front && npm run build`.
