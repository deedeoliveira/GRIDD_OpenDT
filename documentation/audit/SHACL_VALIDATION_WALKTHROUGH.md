# Governed SHACL validation — researcher walkthrough

The technical executor prepares migrations, pySHACL, governed artifacts,
flags and services. The researcher performs no SQL, SPARQL, migrations,
commands, hashes by hand or infrastructure inspection. Use only synthetic
files selected through the real `/dashboard` file pickers.

Permanent interpretation: SHACL checks graph structure/quality. It does not
authenticate or authorize anyone and does not decide eligibility,
reservability, availability, approval, temporal conflicts or reservations.

| Teste ou grupo | O que está sendo testado em linguagem comum | Resultado |
|---|---|---|
| Teste A — shapes governadas | Testa se o RDF produzido pelo IFC satisfaz a estrutura que a plataforma declara como obrigatória. | PASS — investigadora |
| Teste B — trocar somente shapes | Testa se mudar somente as regras SHACL muda realmente o resultado sobre o mesmo RDF. | PASS — investigadora |
| Teste C — criar versão | Testa se uma versão só é ativada depois de o RDF real passar nas constraints estruturais governadas. | PASS — investigadora |

## Teste A — shapes governadas

1. Abrir `http://localhost:3000/dashboard`.
2. Selecionar a model line sintética, `model-v1.ifc` e o IDS que passa.
3. Executar **Validate and preview**.
4. Em **Semantic graph validation**, escolher **Active governed shapes** e
   **Inspect selected shapes**.
5. Conferir filename, versão, hash calculado pelo backend e a lista de
   constraints extraídas.
6. Executar SHACL e observar `conforms=true`, zero resultados e os hashes de
   data/shapes.

## Teste B — trocar apenas as shapes

1. Manter o mesmo IFC, IDS e RDF preview.
2. Escolher **Upload temporary shapes** e selecionar
   `documentation/demo-inputs/shacl/temporary-manifestation-description-required.ttl`.
3. Inspecionar e confirmar que o filename, hash e constraints mudaram.
4. Executar SHACL e observar `conforms=false`.
5. Localizar manifestações como focus nodes, o path
   `http://purl.org/dc/terms/description` e a mensagem do requisito ausente.

## Teste C — criar versão com shapes governadas

1. Restaurar **Active governed shapes**, inspecionar e executar SHACL.
2. Confirmar `conforms=true` e clicar separadamente em **Create model
   version**.
3. Observar o model graph, o report graph imutável, a conformidade e as
   versões de mapping/IDS/shapes usadas.
4. Confirmar que nenhuma reserva foi criada, alterada, avaliada ou aprovada.

Os ficheiros nunca são pré-selecionados. Registe o resultado observável dos
três testes e pare; a organização de commits é um pedido posterior.

Researcher-controlled functional walkthrough passed. Cryptographic integrity and graph immutability were verified automatically and through executor-level integration checks, not independently inspected by the researcher.
