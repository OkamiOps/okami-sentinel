# AGENTS.md

Estas regras são específicas deste repositório e complementam as instruções globais do usuário.

## Higiene obrigatória do workspace

- Antes de criar ou apagar artefatos, faça um inventário por caminho, tipo, tamanho, idade e vínculo com a tarefa atual. Preserve tudo que estiver ativo, ambíguo, rastreado ou necessário para reproduzir a entrega.
- Capturas intermediárias, traces, vídeos, PDFs de teste, snapshots, dumps e logs de navegador devem nascer em um diretório temporário limitado, preferencialmente `/private/tmp/okami-sentinel-qa-*`, e não na raiz do repositório.
- `.playwright-cli/`, `output/`, `test-results/`, traces, logs e equivalentes são artefatos regeneráveis de QA. Ao encerrar a tarefa, mantenha apenas as evidências finais aprovadas e mova-as para um destino rastreado apropriado, como `docs/assets/` ou `public/media/`; limpe o restante dentro do workspace.
- Nunca trate `output/worktree-archives/` como lixo comum. Esse caminho contém backups e handoffs; sua remoção exige inventário e autorização explícita do usuário.
- Metadados locais de ferramentas, como `apps/web/.impeccable/`, podem permanecer ignorados quando forem necessários à ferramenta, mas não devem ser commitados nem contabilizados como código-fonte.
- Diretórios regeneráveis devem permanecer no `.gitignore`. Nenhum artefato local de QA pode aparecer no diff final, inflar a contagem de LoC ou ser enviado ao GitHub por acidente.

## Ciclo de vida de worktrees

- Crie uma worktree apenas quando o isolamento realmente for necessário para trabalho paralelo. Não crie worktrees por hábito para uma alteração simples na `main`.
- Depois que o trabalho tiver sido integrado, validado e publicado, confirme que `HEAD`, `main`, `origin/main` e o remoto apontam para o commit esperado; então remova a worktree secundária e seus `node_modules`.
- Nunca remova uma worktree dirty ou com commits não integrados sem antes preservar o trabalho em commit, stash ou arquivo de handoff e informar claramente onde ele ficou.
- O fechamento da tarefa deve deixar somente o checkout em uso. Worktrees paradas, já integradas ou sem processo ativo não devem permanecer acumuladas.

## Exclusão e limpeza de scans

- Excluir um scan deve remover o resultado do ledger **e** os dados gerenciados pertencentes a ele: diretório de artefatos, log local, sessões cujo `cwd` seja o diretório do scan ou um descendente seguro e os registros correspondentes no Workbench. Apenas ocultar a linha é falha de produto.
- A exclusão deve ser atômica do ponto de vista do usuário: valide todos os caminhos e vínculos antes de remover qualquer arquivo. Se algum alvo não puder ser comprovado como pertencente ao scan, interrompa sem esconder o run.
- Nunca apague sessões compartilhadas ou com `cwd` externo. O vínculo deve ser canônico, inequívoco e restrito ao diretório gerenciado do scan.
- Uma limpeza de órfãos deve excluir scans ativos e recentes, usar referências do ledger e do Workbench, aplicar período de carência e oferecer inventário/dry-run antes da remoção. Não faça varredura cega de `data/` ou do estado global do Codex.
- Depois de excluir, confirme que o run não reaparece após ingestão/restart e reporte os contadores de diretórios, logs, sessões e registros removidos.

## Gate de fechamento e limpeza

Antes de declarar uma tarefa concluída:

1. Rode `git status --short --branch` e confirme que não há artefatos regeneráveis no status.
2. Rode `git worktree list --porcelain` e remova worktrees secundárias já integradas e sem trabalho pendente.
3. Confirme que `.playwright-cli/`, outputs temporários, traces, screenshots intermediários e logs da tarefa foram limpos.
4. Preserve e liste explicitamente qualquer evidência final ou backup que permaneça.
5. Para entregas publicadas, confirme o SHA local, `origin/main` e o SHA remoto antes de afirmar que está na `main`.

## Segurança da limpeza

- É proibido usar `rm -rf` ou comandos destrutivos amplos.
- Toda remoção deve usar alvos exatos previamente resolvidos e validados; nunca use `$HOME`, `~`, `/`, raiz do workspace, glob amplo ou variável não validada como alvo recursivo.
- Limpezas fora deste workspace, ou de qualquer dado ativo/ambíguo, exigem inventário com caminhos e tamanhos e autorização explícita do usuário.
- Após a limpeza, valide as pós-condições: arquivos temporários ausentes, código e evidências preservados, Git intacto e ganho de disco reportado.
