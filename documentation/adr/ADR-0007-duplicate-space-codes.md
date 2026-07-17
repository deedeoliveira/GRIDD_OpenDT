# ADR-0007 — Política para códigos de inventário duplicados

- **Estado**: aceite (Prompt 3, 2026-07-16); **atualizado pelo ADR-0009** — a deteção primária de duplicados no modelo autoritativo passou para o `spatial_preflight`, ANTES de qualquer persistência (a persistência mantém verificação defensiva com a mesma lógica)
- **Contexto**: duas entidades IfcSpace da mesma versão podem trazer o mesmo
  código normalizado. Escolher uma silenciosamente corromperia a identidade.
- **Decisão**:
  - a validação corre sobre TODOS os candidatos espaciais da versão antes de
    qualquer escrita de bindings;
  - o diagnóstico regista código, entidades, GUIDs, nomes, versão, modelo e
    federação (log estruturado `space_identity`/`duplicate_reference`);
  - **modelo autoritativo**: duplicação ambígua impede a ativação — a versão
    fica `failed` (razão `spatial_identity: Duplicate space inventory code...`),
    a corrente anterior permanece, e a compensação remove bindings, inventário
    parcial, ficheiro promovido e temporários (regras do Prompt 2), sem nunca
    apagar espaços preexistentes;
  - **modelo não autoritativo** (ou autoridade indeterminada): os candidatos
    duplicados não geram binding (nenhuma escolha silenciosa), os restantes
    seguem, a ativação não é bloqueada;
  - **backfill histórico**: duplicações são diagnosticadas e ignoradas — versões
    já ativas/arquivadas nunca são desativadas retroativamente.
- **Caso legítimo futuro**: se a auditoria demonstrar um cenário real de
  múltiplas representações válidas do mesmo código na mesma versão, a exceção
  deve ser introduzida por regra explícita e documentada, não por desempate
  automático (GUID/nome/geometria continuam proibidos como desempate).
