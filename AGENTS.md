# AGENTS.md

## Limpeza obrigatória do Playwright

- Após concluir qualquer validação visual com Playwright, remova somente os artefatos temporários criados pela tarefa atual em `.playwright-cli/`, `test-results/` e `output/`, incluindo screenshots intermediários, traces, vídeos, snapshots, YAMLs e logs.
- Preserve evidências finais e registros úteis de falhas, movendo os itens da tarefa para o destino definitivo antes da limpeza. Não remova artefatos preexistentes ou pertencentes a outra tarefa.
- Nunca remova `output/worktree-archives/`; esse diretório contém backups e não faz parte da limpeza do Playwright.
- Antes de encerrar a tarefa, rode `git status --short` e confirme que nenhum artefato temporário do Playwright ficou acumulado ou inflando a contagem de linhas do repositório.

## Limpeza obrigatória de worktrees

- Depois que o trabalho de uma worktree tiver sido integrado e publicado na `main`, confirme que o commit esperado está em `main`, `origin/main` e no remoto; então remova somente a worktree secundária criada por esta tarefa e seus `node_modules`, após verificar processos ativos, status, branch e HEAD.
- Conclua a limpeza das worktrees criadas pela tarefa e já integradas; preserve as de outras tarefas, mesmo quando parecerem paradas.
- Nunca remova uma worktree dirty ou com commits ainda não integrados. Preserve primeiro o trabalho em commit, stash ou arquivo de handoff e informe onde ele ficou.
- Antes de encerrar a tarefa, rode `git worktree list --porcelain` e confirme que as worktrees da tarefa elegíveis para limpeza foram removidas e que os demais checkouts permaneceram íntegros.

## Higiene do repositório

- Consulte `docs/repository-map.md` antes de remover ou reorganizar arquivos por volume.
- Não confunda testes co-localizados, workers de processos filhos ou entrypoints MCP com código sem uso.
- Mantenha estado de ferramentas, relatórios temporários, dados de execução e dependências fora do Git; execute `pnpm check:repository` antes de integrar.
- Preserve decisões duráveis em `docs/architecture`; planos de execução concluídos devem ficar no histórico, sem acumular duplicatas no checkout.
