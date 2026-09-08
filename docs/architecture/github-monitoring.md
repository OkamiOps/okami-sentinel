# GitHub: acompanhamento e automação

Decisões confirmadas em 2026-09-08. Complementa a arquitetura de Guardrails
remotos: identidade GitHub App, snapshots por SHA e policy da branch protegida
continuam sendo a base de autoridade.

## Comportamento aprovado

- Novos PRs e pushes em branches acompanhadas podem disparar scans automáticos
  após configurar e ativar uma regra com orçamento obrigatório.
- Observar atividade não exige iniciar um scan. O primeiro sincronismo registra
  o estado atual; não transforma todos os PRs antigos em uma fila paga.
- O Sentinel também oferece fetch e pull de checkouts locais cadastrados. Pull
  é fast-forward, exige árvore limpa e tracking válido e preserva divergências.
- Mounts Docker continuam somente leitura. Atualizar um checkout de origem é
  uma operação do host; o Sentinel não obtém acesso de escrita por esse recurso.

## Fronteiras

Uma conexão GitHub App autoriza repositórios. Uma regra de acompanhamento define
eventos, branches, executor e custo. Uma execução congela os SHAs e a seleção de
scanner. O painel apresenta conexão, atividade, regras e resultados sem exigir
que o usuário entenda os detalhes de materialização para listar PRs.

A sincronização periódica funciona em pnpm e Docker sem webhook público.
Paginação e limites explícitos evitam truncamento silencioso; falhas preservam
o último estado válido. Execuções externas do Actions são atividade observada,
não evidência Sentinel aprovada sem validação do artifact correspondente.

Deduplicação, reservas persistentes de orçamento e estado de despacho impedem
que reinícios ou eventos repetidos iniciem chamadas pagas sem controle. Uma
falha ambígua depois do despacho exige reconciliação em vez de retry cego.

O teto de custo das engines é uma estimativa operacional: uma requisição já
em voo pode ultrapassá-lo. A UI deve informar a diferença entre esse teto e um
limite rígido de faturamento do provedor. Engines sem enforcement de custo não
podem ser oferecidas para automação com promessa de teto.

## Validação exigida

Cobrir PR novo e atualizado, branch acompanhada, duplicação de eventos,
reinício, primeira sincronização, orçamento ausente/esgotado, erro do GitHub,
revogação de acesso e despacho com revisão obsoleta. Para Git local: checkout
limpo, dirty, divergente, sem upstream, concorrência e container somente leitura.
QA não deve iniciar scans pagos nem alterar workflows externos sem regra e
configuração concretas do operador.
