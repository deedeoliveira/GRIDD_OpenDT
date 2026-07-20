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

**Not intended as a required manual test for the researcher.** Manual infrastructure verification not performed. Infrastructure preparation was not performed during implementation.

In a disposable approved environment, the executor applies the 7B1 and 7B2 migrations, starts MySQL/Fuseki, configures `GRAPH_*`, enables semantic loading plus institutional/demo flags, and may run:

```bash
cd back
npm run semantic:institutional:demo-setup
npm run semantic:institutional:demo-setup -- --execute
```

The first command is dry-run. The explicit execution validates/loads public artefacts and seeds only the four documented synthetic SQL links; it applies no migration, performs no reset and deletes nothing. Then start backend/frontend and open the URL printed by the command.
