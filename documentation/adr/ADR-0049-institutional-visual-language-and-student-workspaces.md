# ADR-0049 — Linguagem visual institucional e workspaces por função

## Contexto

O demonstrador precisava de apresentação coerente com a Universidade do Minho. A área student misturava exploração IFC, escolha de recursos, criação e acompanhamento de reservas. O primeiro walkthrough revelou ainda que IDs de `linked_models`, `models` e `model_versions` eram tratados como se fossem intercambiáveis, impedindo o carregamento observável do modelo.

## Decisão

- A fonte visual é o [Manual de Identidade UMinho](https://www.uminho.pt/PT/uminho/Simbolos-e-Hino/Identidade-grafica/Documents/MANUAL-IDENTIDADE-UMinho.pdf): token principal `#c5014b` e acento `#e16b03`.
- Não se inclui logótipo nem fonte institucional sem uma variante oficial verificadamente permitida. O cabeçalho é textual.
- Student possui três workspaces exclusivos: **Reservar através do modelo**, **Reservar sem modelo** e **Gerir reservas**.
- Manager mantém dois workspaces nas rotas existentes: **Gerir modelos** e **Reservas e decisões**.
- O contrato do viewer nomeia separadamente `linkedModelId`, `modelLineId` e `currentVersionId`. O IFC é obtido pela versão corrente explícita, com cookie e status HTTP preservados pelo proxy.
- Um elemento IFC só abre o pedido quando resolve um binding ativo da versão corrente para um persistent asset ativo e reservável. Ver um `IfcElement` não é suficiente.
- O catálogo global usa uma consulta read-only e uma única pesquisa. Binding da versão corrente significa `modelled`; projeção graph-authoritative sem binding corrente significa `non_modelled`; incoerências ficam `undetermined`.
- O browser recebe `persistentAssetId` (UUID). O ID SQL operacional é resolvido internamente antes de reutilizar o mesmo serviço de evidência e reserva.
- A gestão de reservas contém apenas reservas próprias e ações permitidas pelo lifecycle; o backend continua autoridade de cada transição.
- No workspace **Reservar através do modelo**, o painel compacto **Recurso selecionado** fica junto à logical model line, antes da árvore e do viewer. Só depois de resolver um binding corrente ele expõe **Iniciar pedido**.
- Os dois modos de criação reutilizam o mesmo `ReservationModal` em modo diálogo. O percurso pelo modelo acrescenta somente contexto de apresentação (logical model line e versão corrente); não cria outro formulário, endpoint, motor de evidência, verificação SQL ou criação de pedido.
- O viewer e a seleção de modelo são estado transitório do workspace. Ao sair e regressar, a pessoa escolhe novamente a logical model line; a aplicação não mantém uma instância gráfica oculta.

## Consequências

Não há migration, nova política de reservabilidade, alteração de reservas existentes ou mudança de autoridade. Ativos não modelados continuam graph-authoritative com projeção SQL operacional. A separação é de seleção e apresentação; disponibilidade, evidência, criação e lifecycle continuam nos serviços existentes. Filtro manager por modelo e agrupamento de pedidos concorrentes permanecem no 7J-B.
