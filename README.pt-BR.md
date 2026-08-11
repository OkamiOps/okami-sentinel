<div align="center">
  <img src="apps/web/public/brand/okami-sentinel-mark.png" width="112" alt="Símbolo do lobo OKAMI Sentinel" />
  <h1>OKAMI Sentinel</h1>
  <p><strong>Uma bancada local de evidências. Várias metodologias de scan de segurança.</strong></p>
  <p>Execute, inspecione, compare e governe scans de segurança assistidos por IA sem perder a evidência, o custo ou o contexto operacional de cada resultado.</p>

  <p>
    <a href="README.md">English</a> ·
    <a href="README.pt-BR.md"><strong>Português (Brasil)</strong></a> ·
    <a href="README.de.md">Deutsch</a> ·
    <a href="README.fr.md">Français</a>
  </p>

  <p>
    <a href="https://github.com/OkamiOps/okami-sentinel/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/OkamiOps/okami-sentinel/actions/workflows/ci.yml/badge.svg" /></a>
    <img alt="Node.js 24" src="https://img.shields.io/badge/Node.js-24.x-5FA04E?logo=nodedotjs&logoColor=white" />
    <img alt="pnpm 11.5.2" src="https://img.shields.io/badge/pnpm-11.5.2-F69220?logo=pnpm&logoColor=white" />
    <img alt="React 19" src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=0B0B12" />
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" />
    <img alt="Local first" src="https://img.shields.io/badge/arquitetura-local--first-11CDBB" />
  </p>
</div>

![Sequenciador de lançamento do OKAMI Sentinel com Codex Security, Google Mantis, Capital One VulnHunter, modelo ao vivo do provider e autorização por preflight](docs/assets/okami-sentinel-overview.png)

> [!IMPORTANT]
> O OKAMI Sentinel compara **evidências reportadas**, não precisão contra ground truth. Mais findings não significam automaticamente um scan melhor, e um finding ausente não comprova correção. Confirme os findings e faça a triagem de falsos positivos antes de usar precisão, recall ou F1.

## Por que este projeto existe

Scans de segurança normalmente são revisados isoladamente: um terminal, um relatório, uma conta. O OKAMI Sentinel transforma essas execuções em um sistema operacional comparável. Cada run vira um canal de evidência com modelo, effort, duração, volume de tokens, custo estimado, severidade, findings e estado de execução preservados em um workspace local.

Foi criado para desenvolvedores, profissionais de DevSecOps, revisores de segurança e AI Engineers que precisam avaliar a metodologia do scanner e o modelo separadamente em repositórios reais.

## O que você recebe

| Superfície | Pergunta respondida |
|---|---|
| **Campo de evidências** | O que cada run reportou e como a severidade está distribuída? |
| **Ledger de runs** | Quais scans concluíram, falharam ou preservaram resultados parciais? |
| **Launch sequencer** | Qual scanner, autenticação, modelo, effort, modo e escopo executar? |
| **Inspector de evidências** | Onde está o finding, qual é o attack path e qual evidência o sustenta? |
| **Cockpit comparativo** | Qual run reportou mais cobertura, High+, velocidade ou eficiência de custo? |
| **Relatórios** | Como entregar um scan ou uma comparação de seis scans em PDF? |
| **Guardrails** | Este changeset deve passar, alertar, exigir revisão ou bloquear? |
| **GitHub Checks** | Como aplicar a mesma política versionada em um pull request? |

<table>
  <tr>
    <td width="50%"><img src="docs/assets/okami-sentinel-compare.png" alt="Cockpit comparativo de seis scans com objetivos explícitos e avisos de resultado parcial" /></td>
    <td width="50%"><img src="docs/assets/okami-sentinel-scan-detail.png" alt="Detalhe do scan com custo, severidade, lifecycle, evidências e ação de relatório" /></td>
  </tr>
  <tr>
    <td align="center"><strong>Compare até seis scans</strong></td>
    <td align="center"><strong>Inspecione evidência e lifecycle</strong></td>
  </tr>
</table>

## Principais recursos

- **Roteamento por capacidades** — escolha a metodologia; a interface exibe apenas combinações de autenticação, modelo, effort e modo que o adapter consegue executar.
- **Conexões de provider** — configure sessões locais, autenticação gerenciada por navegador/dispositivo, chaves de API, endpoints Token Plan ou APIs compatíveis sem colocar credenciais no manifesto do scan.
- **Catálogo de modelos ao vivo** — escolha somente modelos retornados pela conexão autenticada; o Sentinel não inventa um catálogo de fallback.
- **Controles de runtime dinâmicos** — modelo, níveis de effort suportados, modo do scan e limite de execução são resolvidos pelas capacidades da conexão e do motor selecionados; valores não suportados não são hard-coded no formulário.
- **Navegador de diretórios** — selecione pastas locais sem copiar caminhos absolutos manualmente.
- **Telemetria ao vivo** — acompanhe estado, fase, eventos SSE, duração, tokens, custo estimado e saída preservada.
- **Inspeção orientada por evidência** — filtre severidade e lifecycle, leia resumos e localizações, percorra attack paths e veja explicitamente quando um finding não trouxe evidência estruturada.
- **Ledger de runs legível** — cada run mostra badges de motor e modelo, além de `High+` e do total de vulnerabilidades; apenas runs terminalizados podem ser removidos do ledger.
- **Resultados parciais honestos** — scans falhos que preservaram findings continuam comparáveis com badges `FAILED` e `PARTIAL`.
- **Comparação de seis runs** — um baseline e até cinco candidatos, com diff de severidade, economia unitária, throughput e objetivos explícitos.
- **Relatórios para impressão** — relatórios individuais e comparativos com marca e exportação em PDF.
- **Guardrails versionados** — políticas locais, exceções explícitas, Decision Graph e publicação opcional no GitHub Checks.
- **Cinco locales na interface** — PT-BR, English, Español, Deutsch e Français.

## Motores de scan

| Motor | Estado | Rotas de conexão executáveis | Modelos | Limite de execução |
|---|---|---|---|---|
| [`@openai/codex-security`](https://github.com/openai/codex-security) | Estável | Sessão local Codex/ChatGPT da OpenAI ou API OpenAI | Catálogo autenticado ao vivo | Scan standard ou deep; teto explícito em USD suportado |
| [Google Mantis](https://github.com/google/mantis) | Preview | Sessão Codex/ChatGPT, sessão local Claude Code, OAuth direto da xAI e providers HTTP aprovados por capability | Catálogo autenticado ao vivo; Claude pode usar seu default explícito de runtime | Nove etapas determinísticas scan-only em snapshot imutável |
| [Capital One VulnHunter](https://github.com/capitalone/vulnhunter) | Experimental | Sessão Codex/ChatGPT, OAuth direto da xAI e providers HTTP aprovados por capability | Catálogo autenticado ao vivo | Perfil de compatibilidade estático, somente leitura, com seis etapas derivado da metodologia VulnHunter revisada |

O Mantis é obtido em um commit revisado, validado e publicado atomicamente em um cache local privado. A primeira fase exclui deliberadamente `mantis-reproduce`, `mantis-chain` e `mantis-patch`: o adapter não escreve no repositório-alvo e não executa código de exploit gerado. Rotas HTTP passam pelo host de ferramentas limitado do Sentinel. Runs da assinatura Claude Code usam um diretório de sessão vazio e separado, sem ferramentas integradas, com um único servidor MCP privado e somente leitura que expõe operações limitadas de listar, ler e buscar sobre o snapshot imutável. O estado bruto do Mantis permanece ao lado das evidências normalizadas do Sentinel para auditoria.

O workflow upstream do VulnHunter é orientado a Claude e inclui etapas de verificação operacionais que podem acionar salvaguardas cibernéticas do provider. Por isso o Sentinel registra a revisão upstream como proveniência para seu perfil local versionado, mas **não** busca nem envia a skill upstream ou seus prompts de fase ao Codex em runtime. O perfil experimental de compatibilidade preserva o formato útil — reconhecimento, rastros estáticos para frente, falsificação adversarial, varredura de cobertura e remediação com evidência — em uma única sessão somente leitura sobre snapshot imutável. Findings retidos são normalizados para o mesmo contrato de evidência do Inspector usado pelos demais motores. Uma política do provider ainda pode recusar a revisão; nesse caso o Sentinel preserva o log completo, retém o uso de tokens já informado e reporta a exigência de Trusted Access sem fingir que o scan foi concluído. Sem usage reportado, o custo permanece indisponível, nunca um falso zero.

> [!NOTE]
> Assinatura, OAuth, Token Plan e cobrança por API são rotas separadas. O Sentinel vincula cada scan a uma conexão persistida e a um modelo descoberto ao vivo ou default de runtime declarado pelo adapter, revalida essa seleção antes de acessar credenciais e nunca faz fallback silencioso entre rotas.

## Perfis de execução do Codex Security

O Codex Security tem dois perfis explícitos. Eles não são apelidos: o detalhe e o relatório do run preservam perfil, rota, protocolo, modelo e identificador da verificação de capacidade selecionados.

| Perfil | Rotas exatas | O que é executado |
|---|---|---|
| **Native** | Codex local, ChatGPT por OAuth no navegador, ChatGPT por código de dispositivo ou API OpenAI | O contrato upstream do `@openai/codex-security`. |
| **Portable** | OAuth/API direta da xAI, API Anthropic, OpenRouter, Gemini, DeepSeek, MiniMax Token Plan, MiMo Token Plan ou API compatível OpenAI/Anthropic | A metodologia defensiva versionada do Sentinel, executada no host AgentSession com limites. |

Portable não afirma que um provider que não é OpenAI está executando o scanner upstream. Ele executa `sentinel/codex-security-methodology@v1`: seis estágios defensivos e somente estáticos sobre um snapshot imutável, com ferramentas limitadas de leitura/busca, artefatos estruturados, cancelamento e isolamento obrigatórios. Antes do lançamento, a tupla persistida exata de conexão/modelo/protocolo precisa ter uma capability probe nova e aprovada. Probe ausente, expirada, falha ou incompatível bloqueia o run; o Sentinel nunca faz fallback para Native, outra rota, CLI ou outro modelo.

O custo é tratado com a mesma honestidade. O Sentinel só registra uma estimativa quando o provider reporta usage e todos os dados de preço correspondentes estão disponíveis. Se usage ou pricing estiver incompleto, o custo fica `null`/indisponível — nunca `$0` inventado nem uma fatura de assinatura.

## Arquitetura

```mermaid
flowchart LR
    UI["Workbench React\nVite + Tailwind + daisyUI"]
    API["API local\nHono + Node.js"]
    DB[("SQLite\nmetadados do benchmark")]
    STATE[("State do Codex Security\nsaída + evidências")]
    ROUTER["Router de capacidades\nengine + auth + modelo"]
    SCANNER["Adapter Codex Security"]
    MANTIS["Adapter Mantis scan-only"]
    VULNHUNTER["Adapter VulnHunter estático"]
    GATE["Motor de guardrails\npolítica + Decision Graph"]
    GH["GitHub Actions\nChecks + artifacts"]

    UI -->|HTTP + SSE| API
    API --> DB
    API --> STATE
    API --> ROUTER
    ROUTER --> SCANNER
    ROUTER --> MANTIS
    ROUTER --> VULNHUNTER
    API --> GATE
    GATE -. opcional .-> GH
```

| Camada | Tecnologia | Local |
|---|---|---|
| Aplicação web | React 19, Vite, TypeScript, Tailwind CSS, daisyUI, shadcn, Recharts, Framer Motion | `apps/web` |
| API local | Node.js, Hono | `apps/api` |
| Gate CLI | Security change gate headless | `apps/gate-cli` |
| Motor do gate | Avaliação de política e integração de runtime | `packages/gate-core`, `packages/gate-runtime` |
| Contratos compartilhados | Tipos e schemas entre pacotes | `packages/shared` |
| Metadados | SQLite | `data/benchmark.db` |

## Pré-requisitos

- Node.js `24.x` (`>=24 <25`)
- pnpm `11.5.2`
- Python `3.10+` para o Codex Security
- GitHub CLI (`gh`) para diagnóstico, baseline remoto e publicação opcional de Checks
- GitHub Actions nos repositórios que usarão o gate remoto
- Um cofre de credenciais do sistema operacional compatível com o adapter de keychain local para conexões com secrets
- Ao menos uma rota configurada em **Configurações → Conexões**. Presets disponíveis incluem:
  - Codex local da OpenAI, autenticação ChatGPT por navegador/dispositivo e API OpenAI;
  - detecção local do Grok da xAI, OAuth de dispositivo orquestrado localmente pelo Sentinel e API xAI;
  - sessão local Claude Code e API Anthropic;
  - detecção local do Cursor e Cursor Background Agents API;
  - OpenRouter, Gemini, DeepSeek, MiniMax Token Plan, Xiaomi MiMo Token Plan e APIs compatíveis OpenAI ou Anthropic customizadas.

## Início rápido

```bash
git clone https://github.com/OkamiOps/okami-sentinel.git
cd okami-sentinel
corepack enable
corepack prepare pnpm@11.5.2 --activate
pnpm install
pnpm dev
```

Se o pnpm solicitar aprovação de build scripts:

```bash
pnpm approve-builds --all
pnpm install
```

Abra:

- Interface: <http://127.0.0.1:5173>
- API local: <http://127.0.0.1:8787>

Abra **Configurações → Conexões** para adicionar uma rota, autenticá-la e atualizar seu catálogo de modelos. Rotas de assinatura local continuam usando o login oficial:

```bash
npx @openai/codex-security login
# ou
npx @openai/codex-security login --device-auth

# Mantis e VulnHunter hospedados pelo Codex usam a sessão genérica do Codex
codex login

# Mantis local pelo Claude usa a sessão Claude Code existente
claude auth login
```

Na inicialização, a API indexa scans compatíveis já existentes no state configurado do Codex Security.

## Fluxo principal

1. **Visão** — inspecione canais indexados, severidade, custo e duração.
2. **Operar** — navegue até o repositório, escolha a metodologia e selecione uma rota disponível de autenticação, modelo, effort, modo e escopo.
3. **Atividade / Detalhe** — acompanhe telemetria e inspecione as evidências preservadas.
4. **Comparar** — selecione de duas a seis runs, defina o baseline e avalie cobertura, High+, `$ / finding`, `$ / High+` e velocidade.
5. **Relatório** — gere o relatório individual no detalhe ou o comparativo após executar o diff.
6. **Guardrails** — avalie um changeset local e publique opcionalmente a decisão como GitHub Check.

## Conexões de provider

| Família de provider | Rotas de conexão | Disponibilidade de scanner |
|---|---|---|
| **OpenAI** | Codex local, OAuth ChatGPT no navegador, código de dispositivo ChatGPT, chave de API | Codex Security, Mantis e VulnHunter de acordo com a rota resolvida |
| **xAI** | OAuth de dispositivo orquestrado localmente pelo Sentinel, chave de API, detecção local do Grok | OAuth/API pode executar Mantis e VulnHunter após prova de capability. Scan local do Grok permanece bloqueado até que a superfície de execução de plugin/hook possa ser isolada. |
| **Anthropic** | Sessão existente Claude Code, API Anthropic | Claude local executa Mantis pela fronteira MCP-only do snapshot. Modelos de API exigem capability probe aprovada. |
| **Cursor** | Detecção de CLI local, Background Agents API | Conexão e catálogo ao vivo disponíveis; execução de scanner não é anunciada até que o contrato de artefatos remoto/local esteja completo. |
| **Outros HTTP** | OpenRouter, Gemini, DeepSeek, MiniMax Token Plan, MiMo Token Plan, URLs compatíveis customizadas | Mantis/VulnHunter somente quando o modelo exato passa a probe limitada de ferramentas, artefatos, cancelamento e snapshot do Sentinel. |

Os modelos e os níveis de effort válidos vêm do catálogo autenticado e das capacidades ao vivo do provider. A única exceção de default de runtime é uma sessão local Claude Code configurada explicitamente. Secrets e tokens OAuth são write-only pela API, armazenados no cofre de credenciais do sistema operacional e representados no SQLite apenas por referências opacas. O Sentinel orquestra localmente o device flow público da xAI e não depende da CLI do Grok; o acesso ao modelo é aceito somente após catálogo ao vivo e verificações de capability aprovadas.

## Guardrails locais

Os guardrails avaliam um changeset Git e preservam a evidência usada na decisão.

1. Cadastre a raiz de um repositório Git local.
2. Execute o preflight com referências como `main` e `HEAD`.
3. Inspecione changeset, escopo do scanner, outcome e Decision Graph.
4. Edite `.csb/guardrails.json` visualmente e revise o JSON antes/depois.
5. Registre exceções com prazo em `.csb/guardrails-exceptions.json`.

| Outcome | Significado | Conclusão no GitHub | Exit do CLI |
|---|---|---|---:|
| `no_changes` | Nenhum arquivo alterado entre as refs | `success` | 0 |
| `bootstrap` | Não há baseline; nunca representa aprovação | `neutral` | 0 |
| `pass` | Nenhuma regra de bloqueio ou revisão foi acionada | `success` | 0 |
| `warning` | A política exige revisão | `neutral` | 0 |
| `blocked` | Uma regra bloqueante foi acionada | `failure` | 2 |
| `error` | Falha operacional; nunca vira aprovação | `action_required` | 3 |

<details>
<summary><strong>Usar o workflow reutilizável no GitHub Actions</strong></summary>

Crie `.github/workflows/csb-security-change-gate.yml` no repositório alvo:

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
    uses: OkamiOps/okami-sentinel/.github/workflows/security-change-gate.yml@v1
    with:
      policy_path: .csb/guardrails.json
      default_branch: main
    secrets:
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

Use a referência versionada `@v1`; `@main` não é aceito como release do gate. Configure o required check com o nome exato **`CSB Security Change Gate`**.

Pull requests de forks normalmente não acessam os secrets do repositório base. Sem autenticação do scanner, a execução termina com erro operacional `3`, nunca como falso sucesso.
</details>

<details>
<summary><strong>Troubleshooting das capabilities do GitHub</strong></summary>

- **Repositório Git:** `git rev-parse --show-toplevel`
- **Remote GitHub:** confirme `remote.origin.url` como `github.com/<owner>/<repo>`
- **GitHub CLI:** `gh --version`
- **Autenticação:** `gh auth status` e, quando necessário, `gh auth login`
- **Assinatura:** `codex login status` e, quando necessário, `codex login`
- **Secret de API:** `gh secret list --json name` deve incluir `OPENAI_API_KEY`
- **Caller workflow:** confirme o arquivo, a referência `@v1` e as permissões mínimas
- **Baseline remoto:** confirme um artifact `csb-gate-artifact` válido na default branch

Artifacts expirados, ausentes ou com schema inválido são erros operacionais. Eles nunca iniciam bootstrap silencioso.
</details>

## Relatórios

- **Individual:** resumo executivo, severidade, findings, localizações e evidências.
- **Comparativo:** um baseline e até cinco candidatos após a execução do diff.
- **Saída:** impressão do navegador ou Save as PDF.
- **Paginação:** seções A4 preservam métricas, headers e findings sem cortes internos.

## Localização

A interface detecta o idioma do navegador e salva a preferência em `okami-sentinel.locale`.

| Código | Idioma | Suporte na interface |
|---|---|---:|
| `pt-BR` | Português do Brasil (fallback) | Sim |
| `en` | English | Sim |
| `es` | Español | Sim |
| `de` | Deutsch | Sim |
| `fr` | Français | Sim |

Datas e números seguem o locale ativo. Valores financeiros continuam explicitamente em USD. Títulos, resumos, caminhos, código, evidências e logs produzidos pelo scanner permanecem no idioma original para preservar o significado técnico.

Veja a [arquitetura de localização](docs/localization.pt-BR.md).

## Configuração

| Variável | Default | Finalidade |
|---|---|---|
| `CODEX_SECURITY_STATE_DIR` | State global quando gravável; senão `data/codex-security-state` | State e saída do scanner |
| `CODEX_SECURITY_BIN` | `npx` | Executável do scanner |
| `CSB_NPM_CACHE_DIR` | `data/npm-cache` | Cache npm isolado usado pelo scanner |
| `CODEX_BIN` | CLI incluída no ChatGPT Desktop no macOS; senão `codex` | Host de inferência do Mantis e VulnHunter |
| `VULNHUNTER_REPOSITORY_URL` | `https://github.com/capitalone/vulnhunter.git` | Repositório upstream revisado |
| `VULNHUNTER_SOURCE_REF` | Commit revisado e fixado | Revisão exata usada em novos scans |
| `VULNHUNTER_CACHE_DIR` | `data/vulnhunter-cache` | Cache local da skill fixada |
| `VULNHUNTER_SKILL_DIR` | não definido | Skill já provisionada opcional, com `SKILL.md` e todas as fases |
| `CSB_HOST` | `127.0.0.1` | Bind da API |
| `CSB_PORT` | `8787` | Porta da API |
| `CSB_MAX_CONCURRENT_SCANS` | `8` | Máximo de processos simultâneos |

## Desenvolvimento

```bash
pnpm dev          # API + web
pnpm dev:api      # somente API
pnpm dev:web      # somente web
pnpm typecheck
pnpm test
pnpm build
```

```text
okami-sentinel/
├── apps/
│   ├── api/           # API HTTP/SSE local
│   ├── gate-cli/      # comando headless do gate
│   └── web/           # workbench React e relatórios
├── packages/
│   ├── gate-core/     # políticas e modelo de decisão
│   ├── gate-runtime/  # integração com scanner/runtime
│   └── shared/        # contratos compartilhados
├── docs/              # arquitetura e documentação do produto
└── data/              # metadados e state local
```

## Notas de custo e segurança

> [!WARNING]
> Scans podem ser caros. O envelope do Codex Security mapeia para a proteção `--max-cost`. Quando um provider informa uso de tokens e há preço exato disponível, o Sentinel pode mostrar uma estimativa explicitamente referenciada; ela não é uma fatura. Rotas de assinatura e sessão local permanecem **indisponíveis**, nunca `$0`, quando o provider não reporta uso faturável. Para uma correspondência exata de modelo, OpenRouter estima separadamente input sem cache, leituras de cache, escritas de cache e output. Franquia do plano, créditos e cobrança final do provider continuam sendo medidas diferentes.

- Dados e evidências normalizadas permanecem locais. Credenciais de provider são armazenadas localmente e usadas apenas para autenticar requests da conexão selecionada. Essa rota de inferência recebe os prompts e evidências de repositório necessários ao scan; publicar um GitHub Check é uma ação explícita separada.
- Falhas operacionais nunca se transformam em decisão de segurança aprovada.
- A exclusão de um scan é explícita e fica disponível apenas após estado terminal. Ela pode remover o registro e o diretório do scan associado **somente se esse diretório for gerenciado pelo Sentinel**; nunca apaga o repositório-alvo.
- Trate findings gerados como evidência de segurança não confiável até a revisão.

## Documentação do projeto

- [Como contribuir](CONTRIBUTING.pt-BR.md)
- [Política de segurança](SECURITY.pt-BR.md)
- [Arquitetura de localização](docs/localization.pt-BR.md)
- [Princípios do produto](apps/web/PRODUCT.pt-BR.md)
- [Design system](apps/web/DESIGN.pt-BR.md)

## Estado do projeto

Este repositório está em desenvolvimento ativo. Interfaces, schemas locais e o gate reutilizável podem mudar antes de uma versão estável. Fixe o gate em uma referência versionada e revise as mudanças antes de atualizar.

---

<div align="center">
  <sub>Workbench local independente para scanners de segurança assistidos por IA. O OKAMI Sentinel não é um produto oficial da OpenAI, Google ou Capital One.</sub>
</div>
