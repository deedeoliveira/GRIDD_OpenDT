# ADR-0002 — Armazenamento imutável por versão e promoção antes do processamento

- **Estado**: aceite (Prompt 2, 2026-07-16)
- **Contexto**: o fluxo antigo gravava sempre `models/<modelId>.ifc` (sobrescrevendo a
  versão corrente) e movia o anterior para `models/archive/<timestamp>_<modelId>.ifc` —
  sem ligação registada entre ficheiro e versão, sem hash, sem nome original.
- **Decisão**:
  - convenção `models/{modelId}/versions/{versionId}/model.ifc`, relativa ao storage
    root (`back/cdn_resources`), separadores POSIX, persistida em
    `model_versions.storage_key`;
  - o caminho é construído exclusivamente pela aplicação a partir de ids numéricos
    validados; o nome original do upload é só metadado (`original_filename`);
  - `resolveStorageKey` rejeita caminhos absolutos e path traversal;
  - a escrita usa `COPYFILE_EXCL` — uma versão nunca sobrescreve outra;
  - SHA-256 calculado sobre o temporário e verificado novamente sobre o ficheiro
    efetivamente armazenado após a promoção (`file_hash`, `file_size`);
  - temporários continuam em `models/temp` (multer), separados do definitivo.
- **Desvio deliberado da ordem sugerida no prompt** (promoção era o passo 10, após o
  processamento): aqui a promoção acontece ANTES do processamento Python, porque o
  Python obtém o ficheiro por HTTP (`GET /api/model/versions/:id/download`) — a área
  temporária não é exposta por rota e o serviço Python permaneceu intocado (recebe o
  URL no campo `path` que o `main.py` já suportava). A segurança mantém-se: uma versão
  `processing` nunca é corrente, e a compensação de falha remove o ficheiro promovido.
- **Ficheiros legados**: `models/<id>.ifc` e `models/archive/...` passam a ser lidos
  via `storage_key` (backfill) e tornam-se imutáveis de facto — o novo fluxo nunca
  mais escreve nesses caminhos.
