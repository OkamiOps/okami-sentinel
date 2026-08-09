# Codex Security Benchmark

Aplicação local para disparar scans do [`@openai/codex-security`](https://github.com/openai/codex-security), visualizar findings, acompanhar custo estimado e comparar modelo × effort. A interface está disponível em português do Brasil, inglês, espanhol, alemão e francês.

## Principais recursos

- Operação local por assinatura Codex/ChatGPT ou por API.
- Navegador de diretórios para escolher repositórios sem copiar caminhos absolutos.
- Telemetria de execução, findings, severidade, custo estimado e duração em uma única interface.
- Comparação de até seis scans, com baseline, candidatos, resultados parciais, diff e métricas de eficiência.
- Relatório individual e relatório comparativo preparados para impressão ou exportação em PDF.
- Guardrails locais e integração opcional com GitHub Checks.
- Interface em **PT-BR**, **English**, **Español**, **Deutsch** e **Français**, com preferência persistida no navegador.

## Stack

- **Web:** Vite + React + TypeScript + Tailwind CSS + daisyUI + Hugeicons + Framer Motion (`apps/web`)
- **API:** Node + Hono (`apps/api`)
- **Shared types:** `packages/shared`
- **Dados:** usa `~/.codex/state/plugins/codex-security` quando o diretório é gravável; em ambientes restritos, usa `data/codex-security-state`. As métricas ficam em `data/benchmark.db`.

## Pré-requisitos

- Node.js 24.17.x
- pnpm 11.5.2 (`corepack prepare pnpm@11.5.2 --activate`)
- Python 3.10+ (exigido pelo Codex Security)
- GitHub CLI (`gh`) autenticado para diagnóstico, baseline remoto e publicação local opcional
- GitHub Actions habilitado no repositório que usará o gate
- uma das formas de acesso ao scanner:
  - **Assinatura Codex:** sessão local ativa, confirmada por `codex login status` como `Logged in using ChatGPT`;
  - **API:** secret de Actions `OPENAI_API_KEY` no repositório para execução autônoma no GitHub Actions.
- Login no Codex Security:

```bash
npx @openai/codex-security login
# ou
npx @openai/codex-security login --device-auth
```

## Setup

```bash
pnpm install
# se o pnpm pedir aprovação de build scripts:
pnpm approve-builds --all
pnpm install
pnpm dev
```

- UI: http://127.0.0.1:5173  
- API: http://127.0.0.1:8787  

Na subida, a API indexa scans já existentes no state do Codex Security (ex.: Contion).

## Uso

1. **Visão** — gasto total, ranking modelo×effort, runs recentes e espectro de evidências.
2. **Operar** — navegue até a pasta do repositório, escolha modelo, effort, modo e envelope de custo.
3. **Atividade/Detalhe** — acompanhe telemetria SSE, findings, evidências e progresso do scan.
4. **Comparar** — selecione de dois a seis scans, defina o baseline e compare cobertura, High+, custo por finding, custo por High+ e velocidade.
5. **Relatórios** — emita um relatório individual no detalhe do scan ou um relatório comparativo após executar o diff.
6. **Guardrails** — aplique políticas versionadas ao changeset local e, opcionalmente, publique o resultado no GitHub Checks.

## Idiomas

O seletor de idioma fica no barramento superior. A aplicação detecta o idioma do navegador na primeira visita e salva a escolha em `localStorage` usando a chave `okami-sentinel.locale`.

| Código | Idioma |
|---|---|
| `pt-BR` | Português do Brasil (fallback) |
| `en` | English |
| `es` | Español |
| `de` | Deutsch |
| `fr` | Français |

Datas e números seguem o locale selecionado. Valores financeiros continuam explicitamente em USD. Títulos, resumos, caminhos, código e evidências vindos do scanner não são traduzidos automaticamente, preservando a fidelidade do resultado original. A arquitetura e o fluxo para adicionar textos estão em [`docs/localization.md`](docs/localization.md).

## Guardrails locais

`Guardrails` executa um gate de segurança contra o diff de um repositório Git local. O gate mostra o changeset, o escopo efetivo enviado ao scanner, o resultado da política e a cadeia causal do Decision Graph.

1. Abra **Guardrails** e escolha **Cadastrar**.
2. Informe a raiz absoluta de um repositório Git local. A API valida o diretório antes do enrollment.
3. Escolha **Executar preflight**, selecione o repositório e informe as referências base e head (por exemplo, `main` e `HEAD`).
4. Acompanhe a lane no Portfolio Pipeline. Um diff vazio termina como `no_changes`, sem iniciar scan e sem consumir custo.
5. Selecione os nós do Decision Graph para inspecionar a evidência usada na decisão.

A política versionada de cada repositório fica em `.csb/guardrails.json`. Exceções ficam em `.csb/guardrails-exceptions.json`, no formato `{ "schemaVersion": 1, "exceptions": [...] }`; cada exceção identifica o finding, motivo, responsável, criação, expiração e ao menos um branch ou índice de regra. O editor visual preserva a ordem das regras, simula a configuração em memória contra um GateArtifact existente e mostra o JSON antes/depois. A gravação só ocorre após confirmação explícita; o app não cria commit nem faz push.

Outcomes locais:

- `no_changes`: não há arquivos alterados entre as referências;
- `bootstrap`: não existe baseline; o resultado é neutro e nunca aparece como aprovação;
- `pass`: nenhuma regra bloqueante ou de revisão foi acionada;
- `warning`: a política exige revisão;
- `blocked`: uma regra bloqueante foi acionada;
- `error`: falha operacional; nunca é convertida em aprovação.

## GitHub Actions e Checks

Em **Guardrails → Setup GitHub**, escolha como o scanner será autenticado:

- **Assinatura Codex:** usa a sessão ChatGPT/Codex deste Mac. Não exige `OPENAI_API_KEY`, executa o preflight localmente e pode publicar o resultado como Check usando o `gh` autenticado. Não executa scans autônomos no GitHub Actions.
- **API:** usa `OPENAI_API_KEY` no repositório e o caller workflow para executar o gate automaticamente em PRs, sem depender deste Mac.

O app diagnostica cada capability separadamente, pode criar o caller workflow localmente, sincroniza o baseline remoto e publica um gate local como Check mediante confirmação. Instalar o workflow cria `.github/workflows/csb-security-change-gate.yml`; não faz commit nem push.

Caller mínimo:

```yaml
name: CSB Security Change Gate
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
  pull-requests: read
  actions: read
  checks: write
jobs:
  security-change-gate:
    uses: OkamiOps/Codex-Security-Benchmark/.github/workflows/security-change-gate.yml@v1
    with:
      policy_path: .csb/guardrails.json
      default_branch: main
    secrets:
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

O caller deve usar a referência versionada `@v1`; `@main` não é aceito como release do gate. Em branch protection, configure como required check o nome exato **`CSB Security Change Gate`**.

| Outcome do GateArtifact | GitHub conclusion | Exit do CLI |
|---|---|---:|
| `no_changes` | `success` | 0 |
| `bootstrap` | `neutral` | 0 |
| `pass` | `success` | 0 |
| `warning` | `neutral` | 0 |
| `blocked` | `failure` | 2 |
| `error` | `action_required` | 3 |

Pull requests de forks normalmente não recebem secrets do repositório base. Sem `OPENAI_API_KEY`, o workflow não publica um Check de sucesso: registra a indisponibilidade no summary e termina com exit 3. O mesmo vale para qualquer falha operacional — nunca é convertida em `success`.

Cada execução envia `csb-gate-artifact` em `pass`, `warning`, `blocked` e `error`. Como o workflow não fixa `retention-days`, vale a retenção configurada no GitHub. O app valida o schema antes de armazenar o baseline em `data/github-cache`; se existe histórico mas o artifact expirou, está ausente ou é inválido, a sincronização retorna erro operacional em vez de fazer bootstrap silencioso.

O modo local continua funcionando sem GitHub. Nesse caso não há instalação, baseline remoto nem publicação, e uma falha de publicação altera apenas `publishStatus`/`publishError`: o outcome de segurança local permanece intacto.

### Troubleshooting por capability

- **Git repository:** confirme que o caminho cadastrado é a raiz retornada por `git rev-parse --show-toplevel`.
- **GitHub remote:** configure `remote.origin.url` para um repositório `github.com/<owner>/<repo>`.
- **gh CLI:** valide a instalação com `gh --version`.
- **Authentication:** execute `gh auth status`; se necessário, `gh auth login`.
- **Permissions:** a conta precisa de acesso de escrita ou admin para publicar Checks e leitura de Actions para sincronizar baselines.
- **Assinatura Codex:** confirme `Logged in using ChatGPT` com `codex login status`; se necessário, execute `codex login`.
- **Scanner por API:** confirme `OPENAI_API_KEY` com `gh secret list --json name`; o app nunca lê nem armazena o valor.
- **Caller workflow:** confirme `.github/workflows/csb-security-change-gate.yml`, a referência `@v1` e as permissões mínimas do exemplo.
- **Remote baseline:** confirme que há uma run da default branch com o artifact `csb-gate-artifact` ainda retido. Artifact inválido ou expirado exige nova run válida.

## Variáveis opcionais

| Variável | Default | Efeito |
|---|---|---|
| `CODEX_SECURITY_STATE_DIR` | global quando gravável; senão `data/codex-security-state` | State do plugin e saída dos scans |
| `CODEX_SECURITY_BIN` | `npx` | Binário do CLI |
| `CSB_NPM_CACHE_DIR` | `data/npm-cache` | Cache isolado usado pelo `npx` do scanner |
| `CSB_HOST` / `CSB_PORT` | `127.0.0.1` / `8787` | Bind da API |
| `CSB_MAX_CONCURRENT_SCANS` | `8` | Máximo de scans CLI em paralelo |

## Aviso de custo

Scans podem ser caros. O Contion (gpt-5.6-sol / high) chegou a ~US$ 98 de estimativa. O Max cost na UI (mín. US$ 100) mapeia para `--max-cost` e **para** o scan se a estimativa passar; há opção “sem limite”. O escopo é o default do CLI (paths manuais opcionais). Os valores de custo são **estimativas** de tokens API e podem diferir do plano ChatGPT.

## Scripts

```bash
pnpm dev          # api + web
pnpm dev:api
pnpm dev:web
pnpm typecheck
pnpm test
pnpm build
```
