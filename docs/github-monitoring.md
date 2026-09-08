# GitHub no Sentinel

Abra **GitHub** no menu principal. Os repositórios já cadastrados continuam
disponíveis; **Cadastrar repositório** reutiliza o fluxo de conexão e instalação
da GitHub App. A identidade de GitHub é independente das conexões de modelos.

## Acompanhar atividade

Escolha um repositório autorizado pela App e acompanhe sua atividade. A
sincronização periódica funciona enquanto a API do Sentinel está rodando, tanto
em pnpm quanto em Docker, sem exigir webhook público. **Sincronizar agora**
consulta o GitHub; não precisa habilitar scans automáticos para observar dados.

O painel mostra as revisões de PRs e branches observadas e execuções recentes do
Actions. Uma execução externa do Actions não é automaticamente um relatório
Sentinel validado; o link abre a execução original no GitHub. Os gates que o
Sentinel despacha continuam usando a validação e importação de artefatos
existentes em Guardrails.

A sincronização consulta o estado remoto. Ela não substitui um histórico completo
de webhooks: eventos que ocorrerem e desaparecerem entre consultas podem não
ser observados. Falhas de sincronização devem ficar visíveis, sem apresentar
dados antigos como recém-atualizados.

## Scans automáticos com orçamento

1. Escolha as branches cujos pushes devem ser acompanhados. PRs novos e
   atualizados também podem entrar na fila.
2. Escolha o executor: **Sentinel** ou **GitHub Actions**.
3. Configure um teto em USD por scan e a reserva máxima diária em USD.
4. Configure a rota do scanner ou a policy remota, conforme o executor.
5. Ative a automação. O primeiro sincronismo estabelece o estado inicial sem
   disparar scans retroativos de todos os PRs abertos.

No executor Sentinel, a automação com teto exige Codex Security e uma conexão,
modelo e perfil compatíveis. Mantis e VulnHunter continuam disponíveis para uso
manual; ainda não oferecem o enforcement necessário para essa automação.

No Actions, o workflow existente usa a configuração da policy protegida e o
secret `OPENAI_API_KEY` do repositório. O teto dessa policy precisa caber no teto
da regra do Sentinel. Conexões locais e credenciais do vault não são copiadas
silenciosamente para o GitHub. Use a configuração de Actions de Guardrails para
instalar/verificar o caller antes de ativar esse executor.

O orçamento diário reserva o teto de cada tentativa iniciada, em dias UTC. Uma
falha de despacho ambígua conserva a reserva; o Sentinel não repete uma chamada
possivelmente paga sem reconciliação. O teto por scan é uma estimativa
operacional: uma requisição já em voo pode ultrapassá-lo. Para um limite rígido
de faturamento, use também os controles disponíveis no provedor.

Ao combinar automação no Sentinel e gatilhos automáticos do workflow, evite
cobrar duas análises do mesmo evento. Para despacho exclusivo pelo monitor,
desabilite os gatilhos push/PR/merge do caller e mantenha `workflow_dispatch`.
Os filtros opcionais de branches do caller valem para o push e, em PRs, para a
branch de destino. Filtros vazios mantêm o comportamento anterior de todas as
branches.

## Fetch e pull de checkouts locais

As operações Git são manuais e separadas das regras de scan. Selecione uma
pasta **já cadastrada como repositório local**:

- **Fetch** atualiza as referências do remoto configurado.
- **Pull** aceita somente fast-forward da branch atual com upstream válido.
- Alterações locais, arquivos não rastreados, HEAD destacado, divergência e
  scans ativos impedem a atualização quando necessário.
- O Sentinel não faz reset, rebase, stash, troca de branch ou push como parte
  dessa ação. Hooks e fsmonitor são desativados nas operações.

Um repositório remoto autorizado pela App não é automaticamente associado a
uma pasta de mesmo nome. No Docker, os mounts continuam somente leitura; faça
a atualização do checkout de origem no host. Snapshots remotos usados pelos
scans são materializados pelo SHA, sem depender de um pull dessa pasta.

## Limites operacionais

- GitHub.com e as permissões da instalação continuam sendo o contrato suportado;
  esta entrega não declara suporte a GitHub Enterprise Server.
- Enquanto o Sentinel estiver desligado, seus scans gerenciados e seu monitor
  param. Workflows com gatilhos próprios no GitHub podem continuar executando.
- PRs de forks podem não ter acesso aos secrets necessários no Actions. Não
  substitua o fluxo por execução privilegiada de código não confiável para
  contornar essa limitação.
- Atualizar a imagem Docker ou reiniciar a API preserva regras e eventos no
  SQLite. Não remova o volume persistente para atualizar a aplicação.
