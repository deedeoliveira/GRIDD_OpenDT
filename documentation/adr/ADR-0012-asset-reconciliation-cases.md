# ADR-0012 — Ambiguidade e pendência: casos de reconciliação humana

- **Estado**: aceite (Prompt 4, 2026-07-17)
- **Contexto**: um elemento sem evidência (ou com evidência ambígua) numa
  versão posterior pode ser: equipamento novo, identificador alterado, ou
  substituição física. Distinguir automaticamente seria inventar identidade.
- **Decisão**:
  - candidatos `ambiguous`/`unresolved` geram uma linha em
    `asset_reconciliation_cases` (`status='open'`, `candidates_json`) e
    **NÃO** geram asset nem binding:
    - não são reserváveis (não há ativo para reservar);
    - não contornam reservas existentes (nenhum `asset_id` novo é criado);
    - a geometria continua visível no viewer (a entity existe);
  - a versão **ativa na mesma** — o inventário fica incompleto e sinalizado
    (log estruturado `pending_reconciliation` + casos abertos consultáveis);
  - resolução administrativa via
    `POST /api/asset/reconciliation/cases/:caseId/resolve` com
    `link_to_existing_asset` | `confirm_as_new_asset` |
    `confirm_replacement` | `ignore_non_asset`; a resolução cria o binding
    (método = resolução, confiança `manual`); `confirm_replacement` também
    retira (`retired`) o ativo substituído — decisão humana explícita;
  - a aplicação não tem autenticação: o mecanismo atual de resolução é a
    API (Bruno/curl); UI extensa de reconciliação está fora do âmbito.
- **Consequências**: nenhuma identidade é inventada; o custo é intervenção
  humana quando os exports não trazem evidência estável.
