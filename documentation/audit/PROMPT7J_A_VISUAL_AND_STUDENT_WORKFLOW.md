# Prompt 7J-A — identidade visual e workspaces student/manager

## Implementado

A apresentação usa marca textual Universidade do Minho, superfícies claras, foco acessível e tokens derivados do manual oficial (`#c5014b`, `#e16b03`). A autenticação continua explicitamente local; números visuais no login não são identificadores.

O defeito do viewer estava no contrato de seleção: IDs numéricos vindos do backend eram comparados estritamente com a string do `<select>`, deixando o contexto React nulo. A cadeia seguinte também usava `childModels` e download por model ID, sem tornar explícita a versão corrente nem preservar erro/status no proxy. O contrato corrigido separa `linkedModelId`, `modelLineId` e `currentVersionId`; o viewer descarrega exatamente a versão corrente, valida status/content type/body, constrói a árvore e comunica estados de loading/loaded/error.

Student tem três workspaces:

1. **Reservar através do modelo** — logical model line, versão corrente, painel compacto do recurso, viewer, árvore, Eye/EyeOff, binding corrente, evidência e criação explícita. O painel fica antes da área gráfica e só abre o diálogo partilhado depois de um binding corrente reservável.
2. **Reservar sem modelo** — catálogo global, uma pesquisa e grupos modelados/não modelados. A ausência de localização é mostrada, não inventada.
3. **Gerir reservas** — reservas próprias, decisão/razão/data e ações cancel/check-in/checkout, sem formulário de novo pedido.

Manager usa **Gerir modelos** em `/dashboard` e **Reservas e decisões** em `/dashboard/reservations`. As rotas existentes evitam duplicar workflows.

## Autoridade e API

Um binding da versão corrente classifica `modelled`. Uma projeção `source='graph'` com URI semântica e sem binding corrente classifica `non_modelled`; uma origem inconsistente fica `undetermined`. A consulta deduplica por persistent asset e não executa escrita. O browser recebe UUID persistente, nome, Tag/Reference, localização e representação; não recebe binding/graph URI/ID SQL. O backend resolve o UUID para o ID operacional antes de chamar os mesmos serviços de evidência, disponibilidade e reserva.

O pedido via modelo e o pedido pelo catálogo usam o mesmo `ReservationModal`: datas, validação, evidência, disponibilidade SQL, criação e mensagens não são duplicadas. Pelo modelo, o diálogo identifica a logical model line e a versão corrente usadas para a seleção; a identidade operacional continua a ser o persistent asset com binding corrente. Abrir o diálogo não cria pedido. Viewer e seleção do modelo são estado transitório do respetivo workspace: ao trocar de workspace e regressar, a investigadora volta a escolher a logical model line, evitando instâncias gráficas ocultas ou inconsistentes.

O estado local auditado contém quatro ativos modelados ativos/reserváveis e nenhum ativo `source='graph'`; por isso o grupo não modelado é apresentado vazio sem inventar uma fixture ou alterar política. Nenhuma reserva técnica foi criada nesta preparação.

## Testes automatizados em linguagem comum

| Teste ou grupo | O que está sendo testado em linguagem comum | Resultado |
|---|---|---|
| Contrato do modelo | Contexto, logical model line e versão corrente não são confundidos. | Passou |
| Viewer e árvore | O IFC real é descarregado, validado, aberto e usado para construir a árvore. | Passou |
| Troca de contexto | Sair, regressar ou trocar de modelo limpa apenas seleção transitória. | Passou |
| Sem versão ativa | Uma falha histórica não é apresentada como modelo aceite nem abre o viewer. | Passou |
| Binding corrente | Só um ativo persistente ligado à versão corrente pode iniciar pedido via modelo. | Passou |
| Painel e diálogo via modelo | O recurso aparece junto à seleção do modelo; **Iniciar pedido** abre o mesmo diálogo acessível do catálogo, sem formulário inline. | Passou |
| Catálogo | A listagem exige student, deduplica, classifica e não escreve dados. | Passou |
| Pesquisa e grupos | Uma pesquisa normalizada cobre nome, código e localização nos grupos visuais. | Passou |
| UUID backend | O browser usa identidade persistente e o backend resolve o ID operacional. | Passou |
| Gestão de reservas | Criação fica separada; cancel, check-in, checkout e razões são preservados. | Passou |
| Manager | Os dois workspaces existentes permanecem separados e acessíveis. | Passou |
| Regressão completa | As áreas anteriores, Python real, semântica e reservas continuam cobertas. | 634/634 passaram |

## Walkthrough funcional

A investigadora escolhe os inputs e usa apenas a interface:

- em **Reservar através do modelo**, selecionar uma linha com versão ativa, carregar, usar árvore/Eye e escolher um equipamento modelado;
- em **Reservar sem modelo**, pesquisar e escolher um ativo disponível no estado preparado;
- em **Gerir reservas**, confirmar que criação não aparece e que as ações refletem o estado;
- em manager, alternar entre os dois workspaces.

Não são pedidos SQL, SPARQL, migrations, seeds, hashes ou inspeções de infraestrutura. O 7J-B (filtro manager por modelo e agrupamento de concorrência) permanece futuro imediato.
