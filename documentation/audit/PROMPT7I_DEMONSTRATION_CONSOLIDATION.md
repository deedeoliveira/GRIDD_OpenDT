# Prompt 7I — demonstration consolidation

The interface now separates student and manager navigation from the
server-resolved local session. The manager sees existing models and reservation
decisions; the student sees resources, a request flow and own reservations.

No building registration, building schema, model-line creation or migration is
part of this prompt. Two synthetic model contexts will be created later through
the existing Bruno contracts: a context name/key, linked model or logical model
line, active state, and the mandatory foreign keys required by those contracts.

The application remains a research demonstrator. Local synthetic
authentication is not production authentication. SQL and the scoped manager
remain operational authorities; semantic eligibility remains shadow.

The model-intake workspace requires a manager role with an active management
scope. The current schema has no scope assigned directly to a logical model
line, so model visibility is workspace-level at this stage; reservation
decisions remain limited by their asset scope. Fine-grained model-management
scope is future work.

## Estado do walkthrough

O walkthrough funcional e visual foi concluído e aprovado pela investigadora.
As etapas 1 a 6 foram verificadas com os inputs sintéticos controlados.

As logical model lines sem `currentVersion` continuam visíveis no selector e
uma tentativa `failed` nunca é apresentada como versão ativa. O gestor escolhe
explicitamente a model line; o workspace só abre por ação explícita, e IFC e
IDS começam sem pré-seleção.

## Reprodutibilidade do frontend

O demonstrador usa uma stack de fontes do sistema para os estilos sans e mono.
Isto remove a dependência de `next/font/google` e de downloads de fontes durante
o build, sem distribuir ficheiros de fontes nem alterar a hierarquia visual.
