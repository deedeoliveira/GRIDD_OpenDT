# Institutional context functional demonstration

## Researcher walkthrough

This is the only manual walkthrough intended for the researcher. Infrastructure preparation is performed beforehand by a technical executor.

1. Open `/semantic-demo`.
2. Select **Scenario A — complete context**. Observe the synthetic person, student number, research group, doctoral/member roles, supervisor and governed artifact versions.
3. Select **Scenario B — no supervisor assertion**. Observe a valid synthetic person, student number, research cluster and roles. Confirm the message: “No supervisor assertion is present in the active synthetic graph.”
4. Select **Scenario C — revoked link**. Observe that the link is found but current institutional evidence is not used.
5. Confirm the permanent warning that data is synthetic, the actor key is not authenticated and the evidence does not authorize or approve a reservation.

No reservation is created, changed, approved or assessed during this demonstration.

## Technical executor preparation

**Not intended as a required manual test for the researcher.** The local technical preparation was completed by the executor on 2026-07-20. The researcher must not repeat the migration, loading, seed or infrastructure checks.

In a disposable approved environment, the executor applies the 7B1 and 7B2 migrations, starts MySQL/Fuseki, configures `GRAPH_*`, enables semantic loading plus institutional/demo flags, and may run:

```bash
cd back
npm run semantic:institutional:demo-setup
npm run semantic:institutional:demo-setup -- --execute
```

On Windows PowerShell, if the `npm` script wrapper drops forwarded arguments,
use the equivalent `npm.cmd run semantic:institutional:demo-setup -- --execute`
and require the final output to contain `"ok": true` rather than another
dry-run plan.

The first command is dry-run. The explicit execution validates/loads public artefacts and seeds only the four documented synthetic SQL links; it applies no migration, performs no reset and deletes nothing. Then start backend/frontend and open the URL printed by the command.

## Local preparation record — 2026-07-20

- The 7B1 registry and 7B2 actor-link migrations were applied because their
  four required tables were absent.
- `SEMANTIC_ARTIFACT_LOADING_ENABLED`, `INSTITUTIONAL_GRAPH_ENABLED` and
  `INSTITUTIONAL_DEMO_MODE` were enabled only in the ignored local `back/.env`.
- Dry-run reported four public runtime artefacts, four synthetic links and zero
  destructive operations.
- Explicit execution activated exactly the ontology, bridge, structural shapes
  and positive synthetic dataset and created the four documented `TEST-*`
  links. The negative fixture and private data were not loaded.
- Student 001, Student 002 without a supervisor assertion, and the revoked-link
  scenario were observed through the application API used by `/semantic-demo`.
- The reservation table count and checksum were unchanged before/after.
