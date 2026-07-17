# ADR-0005 — Âmbito de unicidade do código de inventário dos espaços

- **Estado**: aceite provisoriamente (Prompt 3, 2026-07-16) — **hipótese a
  confirmar com a instituição**
- **Contexto**: a identidade persistente de um espaço é o seu código de
  inventário (convenção do projeto: `Pset_SpaceCommon.Reference`). Era preciso
  fixar o âmbito dentro do qual o mesmo código significa o mesmo espaço.
  Na auditoria (2026-07-16), a BD tinha 4 federações com exatamente 1 modelo
  cada e nenhum IFC real com o pset preenchido — não há evidência empírica de
  códigos globais entre instalações.
- **Decisão provisória**: `UNIQUE(linked_model_id, inventory_code_normalized)` —
  o mesmo código em federações (instalações) diferentes identifica espaços
  diferentes; dentro da mesma federação, identifica o mesmo espaço persistente,
  independentemente do modelo/disciplina que o declara.
- **Alternativas**: unicidade global (rejeitada sem evidência de convenção de
  códigos única entre edifícios); por model (rejeitada: impediria dois modelos
  da mesma federação de referirem o mesmo espaço físico).
- **Revisão futura**: se a instituição confirmar códigos únicos por edifício ou
  campus, migrar o âmbito exige nova migration + reconciliação — registar como
  trabalho explícito, não alterar silenciosamente.
