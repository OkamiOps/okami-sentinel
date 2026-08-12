# AGENTS.md

## Limpeza obrigatória do Playwright

- Após concluir qualquer validação visual com Playwright, remova os artefatos temporários gerados em `.playwright-cli/`, `test-results/` e `output/`, incluindo screenshots intermediários, traces, vídeos, snapshots, YAMLs e logs.
- Preserve somente as imagens ou evidências finais solicitadas pelo usuário, movendo-as para o destino definitivo do projeto antes da limpeza.
- Nunca remova `output/worktree-archives/`; esse diretório contém backups e não faz parte da limpeza do Playwright.
- Antes de encerrar a tarefa, rode `git status --short` e confirme que nenhum artefato temporário do Playwright ficou acumulado ou inflando a contagem de linhas do repositório.

## Limpeza obrigatória de worktrees

- Depois que o trabalho de uma worktree tiver sido integrado e publicado na `main`, confirme que o commit esperado está em `main`, `origin/main` e no remoto; então remova a worktree secundária e seus `node_modules`.
- Não deixe worktrees já integradas ou paradas acumuladas após o encerramento da tarefa.
- Nunca remova uma worktree dirty ou com commits ainda não integrados. Preserve primeiro o trabalho em commit, stash ou arquivo de handoff e informe onde ele ficou.
- Antes de encerrar a tarefa, rode `git worktree list --porcelain` e confirme que permaneceu apenas o checkout que ainda está em uso.
