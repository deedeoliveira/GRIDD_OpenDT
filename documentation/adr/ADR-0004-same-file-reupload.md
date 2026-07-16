# ADR-0004 — Reenvio do mesmo ficheiro cria uma nova versão

- **Estado**: aceite (Prompt 2, 2026-07-16)
- **Contexto**: com `file_hash` registado passou a ser possível detetar que um upload
  é byte-a-byte idêntico a uma versão existente. Era preciso uma política explícita.
- **Decisão**: **preservar o comportamento atual** — cada upload cria uma nova
  `model_version`, mesmo com hash idêntico a uma versão anterior. Não há deduplicação
  silenciosa nem rejeição. O hash serve para integridade (verificação pós-promoção) e
  diagnóstico (comparar versões), não para deduplicar.
- **Racional**: era o comportamento observável da baseline (re-uploads do mesmo IFC
  aconteceram nos testes manuais dos Prompts 0–1 e criaram versões novas); qualquer
  rejeição/dedup seria uma regra de negócio nova, que pertence a uma decisão futura
  com a utilizadora.
- **Coberto por teste**: `uploadFlow.test.ts` — "mesmo ficheiro reenviado: cria nova
  versão".
