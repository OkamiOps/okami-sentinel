# Codex Security Benchmark

Aplicação local para disparar scans do [`@openai/codex-security`](https://github.com/openai/codex-security), visualizar findings, acompanhar custo estimado e comparar modelo × effort.

## Stack

- **Web:** Vite + React + TypeScript + Tailwind CSS + daisyUI + Hugeicons + Framer Motion (`apps/web`)
- **API:** Node + Hono (`apps/api`)
- **Shared types:** `packages/shared`
- **Dados:** lê `~/.codex/state/plugins/codex-security` e espelha métricas em `data/benchmark.db`

## Pré-requisitos

- Node.js 22+ (ou 24+)
- pnpm
- Python 3.10+ (exigido pelo Codex Security)
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

1. **Dashboard** — gasto total, ranking modelo×effort, runs recentes  
2. **Novo scan** — escolha pasta/repositório, modelo, effort, max cost e inicie pela UI  
3. **Detalhe** — findings, evidência, progresso SSE enquanto o scan roda  
4. **Comparar** — 2+ runs para ranking high/$ e diff de findings  

## Guardrails locais

`Guardrails` executa um gate de segurança contra o diff de um repositório Git local. O gate mostra o changeset, o escopo efetivo enviado ao scanner, o resultado da política e a cadeia causal do Decision Graph.

1. Abra **Guardrails** e escolha **Cadastrar**.
2. Informe a raiz absoluta de um repositório Git local. A API valida o diretório antes do enrollment.
3. Escolha **Executar preflight**, selecione o repositório e informe as referências base e head (por exemplo, `main` e `HEAD`).
4. Acompanhe a lane no Portfolio Pipeline. Um diff vazio termina como `no_changes`, sem iniciar scan e sem consumir custo.
5. Selecione os nós do Decision Graph para inspecionar a evidência usada na decisão.

A política de cada repositório fica em `.csb/guardrails.json`. O editor visual preserva a ordem das regras, simula a configuração em memória contra um GateArtifact existente e mostra o JSON antes/depois. A gravação só ocorre após confirmação explícita; o app não cria commit nem faz push.

Outcomes locais:

- `no_changes`: não há arquivos alterados entre as referências;
- `bootstrap`: não existe baseline; o resultado é neutro e nunca aparece como aprovação;
- `pass`: nenhuma regra bloqueante ou de revisão foi acionada;
- `warning`: a política exige revisão;
- `blocked`: uma regra bloqueante foi acionada;
- `error`: falha operacional; nunca é convertida em aprovação.

A publicação do mesmo resultado como GitHub Check e a instalação do workflow pertencem ao próximo plano. Esta entrega não publica, não instala workflow e não altera o GitHub.

## Variáveis opcionais

| Variável | Default | Efeito |
|---|---|---|
| `CODEX_SECURITY_STATE_DIR` | `~/.codex/state/plugins/codex-security` | State do plugin |
| `CODEX_SECURITY_BIN` | `npx` | Binário do CLI |
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
```
