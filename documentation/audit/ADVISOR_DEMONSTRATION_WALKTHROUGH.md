# Advisor demonstration walkthrough (15–25 minutes)

## 1. Overview

Explain that IFC, institutional evidence, validation and reservation decisions
have distinct authorities. Do not claim that SHACL authorizes a reservation or
that semantic eligibility is binding.

## 2. Models

Login as manager, open **Modelos**, show the three existing logical model lines,
select one, choose an IFC and IDS, then use **Validar e pré-visualizar**.
Explain the distinct IDS, project-rule, RDF and SHACL results. Create a version
only if the prepared data permits it; version creation is explicit.

## 3. Student

Login as student and choose **Reservar através do modelo**, **Reservar sem modelo**
or **Gerir reservas**. The model flow loads the explicit current version and
only a current persistent binding can be selected for a request. Its compact
selected-resource panel stays beside the logical model line; **Iniciar pedido**
opens the same accessible dialog used by the catalogue, without an inline
form. Leaving and returning to the model workspace deliberately requires a
new model selection. The catalogue uses one search across modelled and
non-modelled resources. Reservation
management contains existing requests and lifecycle actions, not creation.
Explain that both creation paths reuse the same evidence/reservation services
and that a request produces pending, not approval.

## 4. Manager

Use the persistent manager navigation between **Gerir modelos** and
**Reservas e decisões**. In reservations, use **Abrir análise**, then approve, reject or
cancel with a reason. Explain that approval rechecks transactional conflicts.
Return to the student area to show the status and recorded reason.

## 5. Contribution and limits

Point to provenance, immutable model versions, persistent spaces/assets and
separated validation layers. State that building onboarding, production
authentication, notifications, geometry/full-ifcOWL and binding semantic
eligibility are future work.
