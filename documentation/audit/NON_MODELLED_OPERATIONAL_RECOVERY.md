# Ativos não modelados — política operacional e recovery auditável

## Autoridade e projeção

O graph operacional é a autoridade dos ativos não modelados. Nele residem a
identidade persistente do ativo, o tipo de recurso, o ciclo de vida e a sua
localização corrente. A tabela SQL `assets` é uma projeção operacional para a
aplicação; não é fonte suficiente para reconstruir um recurso RDF, as suas
relações ou a sua história.

Assim, a ausência do recurso no graph falha fechada: a projeção SQL não torna o
ativo reservável. Uma falha para consultar ou verificar a autoridade produz
`undetermined`, e não uma autorização implícita.

## Perfil de reservabilidade operacional

O provider `operational` mantém o perfil IFC anterior para candidatos modelados.
Para um ativo não modelado, o resultado é calculado somente a partir de factos
verificados no graph e da coerência da projeção operacional:

- `allow`: identidade persistente válida, recurso operacional suportado, ciclo
  de vida ativo, uma localização corrente verificável, graph autoritativo
  disponível e sincronização/projeção SQL coerente;
- `deny`: a autoridade confirmou a ausência ou inconsistência de um requisito
  determinístico, como identidade, tipo, ciclo de vida ou localização;
- `undetermined`: a autoridade, a sincronização ou a verificação necessária não
  está disponível.

Só `allow` projeta `reservable=true`; `deny`, `undetermined` e erro conservam o
ativo não reservável. Não há exceção baseada em código de demonstração e não há
atribuição fixa de `reservable=true`.

## Reavaliação e recovery

A reconciliação relê a autoridade, reavalia o resultado e atualiza apenas a
projeção SQL de reservabilidade. Ela não altera nem reconstrói o graph.

Quando uma falha operacional elimina um recurso que já tinha sido registado, o
recovery localiza o registo `completed` original, verifica o seu hash e repõe o
RDF pelo replay do comando canónico: mesmos UUID, IRI, payload e timestamps
originais. Em seguida, cria uma nova operação append-only de recuperação. O
estado atual de `assets` não é usado para inventar autoridade; SQL sozinho não
permite recuperar o graph.

## Isolamento de testes

O reset que suporta testes com SQL de teste não pode limpar o dataset Fuseki
operacional. Em `NODE_ENV=test`, a limpeza de recursos não modelados no graph
operacional é bloqueada. Testes que precisem de um graph devem apontar
explicitamente para um dataset de teste isolado; o dataset operacional só pode
ser alvo de operações operacionais deliberadas.
