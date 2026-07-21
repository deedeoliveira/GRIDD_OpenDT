# Researcher-controlled reservation evidence walkthrough

The executor prepares the local migration, governed artefacts, synthetic
links/model, flags and services. The researcher uses the real `/student`
reservation form, chooses an asset and interval, and sees the current local
development identity as read-only. It is not an authenticated account.

Semantic eligibility is permanently shadow-only and non-binding. SQL remains
the authority for availability and temporal conflicts; no authorization or
approval decision is made here.

## Test A — current actor with verified synthetic link

1. Open `/student`, choose an available synthetic asset and open its form.
2. Confirm the displayed current development actor; choose a future interval.
3. Select **Check evidence** and confirm current verified link, institutional
   dataset, synthetic agent, allowed role, resource evidence, structural
   `conforms`, shadow `eligible`, and independent SQL availability.
4. Select **Create reservation request** explicitly and observe `pending` with
   the matching evidence snapshot.

## Test B — SQL conflict remains independent

1. Keep the same actor and asset and choose an overlapping interval.
2. Check evidence: shadow eligibility may remain `eligible` while SQL reports
   the conflict.
3. Try the explicit request and observe the existing SQL rejection.

## Revoked actor coverage

`Automated and executor-level scenario; not a researcher-facing manual test.`
The normal student interface has no actor dropdown or impersonation.

| Teste ou grupo | O que está sendo testado em linguagem comum | Resultado |
|---|---|---|
| Identidade atual | Uma única identidade local read-only é usada na evidência e no pedido. | Pendente do walkthrough |
| Ligação institucional | O actor atual mostra uma ligação sintética verificada e papel permitido. | Pendente do walkthrough |
| Cenário positivo | Evidência de actor, asset/modelo e SHACL estrutural produz `eligible` shadow. | Pendente do walkthrough |
| Conflito SQL | Um overlap continua bloqueado pelo SQL, independentemente do resultado shadow. | Pendente do walkthrough |
| Actor revogado | A ligação revogada continua coberta automaticamente e pelo executor. | Cobertura automatizada/executor |
| Snapshot | O pedido explícito liga o run com os mesmos actor, asset e intervalo. | Pendente do walkthrough |
