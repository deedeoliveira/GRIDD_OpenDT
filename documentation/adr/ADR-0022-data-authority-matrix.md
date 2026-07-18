# ADR-0022 — Autoridade dos dados: IFC, SQL e grafo

- **Estado**: aceite (Prompt 5A, 2026-07-17)
- **Contexto**: com a introdução do grafo passa a haver três meios de
  representação (ficheiros IFC imutáveis, SQL transacional, RDF). Sem uma
  matriz explícita de autoridade, cópias RDF tenderiam a ser tratadas como
  fonte de verdade — o que não são.

## Princípio

```text
Ter uma cópia RDF de um domínio NÃO torna o grafo autoridade desse domínio.
A autoridade muda apenas por decisão explícita (ADR), nunca por osmose.
```

## Matriz de autoridade

| Domínio | Autoridade atual | Representações/projeções |
|---|---|---|
| Ficheiro de uma versão IFC | ficheiro imutável (storage_key da model_version) | metadados SQL; futuro grafo da versão |
| Versão corrente | `models.current_version_id` | APIs e viewer |
| Entidades IFC | snapshot SQL da model_version | SQL; futuro named graph da versão |
| Espaço persistente | `spaces` | `space_bindings`; futura URI |
| Ativo persistente modelado | `assets` | `asset_bindings`; futura URI |
| Localização de ativo modelado | binding da versão corrente (`current_version_id` → asset_binding.space_id) | viewer e consultas operacionais |
| Reserva e conflito | SQL (`res_reservations`, asset_id persistente) | **nenhuma autoridade concorrente no grafo** |
| Ativo não modelado (futuro, 5B) | grafo operacional | projeção SQL para reservas/consultas |
| Localização de ativo não modelado (futuro) | grafo operacional | projeção SQL corrente |
| Observações de sensores (futuro) | fonte de observação | evidência para inferência; NUNCA localização validada automática |
| Políticas atuais | providers Node.js | logs estruturados `policy_evaluation` |
| Requisitos IFC atuais | provider `project-profile-v1` | futura substituição por IDS |

## Consequências

- SQL continua a autoridade transacional de reservas, conflitos, estados,
  checkout, overdue e snapshots — o grafo nunca participa dessas decisões;
- indisponibilidade do grafo não altera `current_version_id`, bindings,
  ativos nem reservas (isolamento garantido por guarda automatizada: nenhum
  módulo operacional importa `back/graph/`);
- não há dual-write nesta etapa; quando o 5B introduzir projeções
  grafo→SQL para ativos não modelados, a direção da projeção e a
  reconciliação serão decididas em ADR próprio.
