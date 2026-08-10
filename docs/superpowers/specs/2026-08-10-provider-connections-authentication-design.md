# Provider Connections and Authentication

Status: aprovado em conversa em 10 de agosto de 2026, incluindo as correções de rotas CLI, OAuth/device e API por fornecedor.

## Contexto

O Okami Sentinel hoje executa Codex Security, Google Mantis e Capital One VulnHunter, mas o catálogo de scanners assume OpenAI, modelos fixos e apenas dois modos de autenticação: sessão ChatGPT ou API key disponível no ambiente do processo.

Esse desenho exclui usuários que possuem outras assinaturas, token plans ou endpoints compatíveis. Também mistura quatro conceitos que precisam permanecer independentes:

1. **provider:** quem fornece a inferência ou o agente;
2. **autenticação:** sessão existente, browser OAuth, device code, API key ou headers customizados;
3. **transporte:** CLI local, Codex app-server, HTTP de inferência ou API remota de agente;
4. **runner:** quem conduz ferramentas, artifacts, telemetria e cancelamento.

A decisão aprovada é criar uma camada persistente de Connections, local-first e preparada para escopo servidor, sem fingir que todos os fornecedores expõem o mesmo protocolo.

## Objetivos

- Permitir cadastrar múltiplas conexões para o mesmo provider.
- Reutilizar assinaturas oficialmente suportadas sem pedir login a cada scan.
- Oferecer rotas distintas de CLI, OAuth/device e API onde elas realmente existem.
- Suportar APIs OpenAI Responses, OpenAI Chat Completions e Anthropic Messages com URL customizada.
- Suportar URLs específicas de MiniMax Token Plan e Xiaomi MiMo Token Plan.
- Descobrir modelos dinamicamente pelo provider ou runtime; nenhuma lista de modelos fica hardcoded.
- Calcular compatibilidade como interseção entre scanner, runner, protocolo, modelo e capacidades verificadas.
- Manter chaves, tokens, URLs customizadas e headers secretos fora do SQLite, logs, SSE, manifests e argumentos visíveis.
- Preservar comparabilidade, telemetria e proveniência dos runs independentemente do provider.

## Não objetivos

- Não extrair tokens de sessão pertencentes a Codex, Claude Code, Cursor ou Grok Build.
- Não reutilizar token de assinatura como se fosse API key do provider.
- Não implementar OAuth não documentado por engenharia reversa.
- Não afirmar que uma API de agente remoto é equivalente a uma API de inferência.
- Não prometer custo ou tokens quando o runtime não os reporta.
- Não suportar FreeBuf como provider enquanto não houver uma API pública compatível documentada.
- Não usar OpenCode como cofre de credenciais. Ele poderá ser um runtime opcional posterior.
- Não ampliar GitHub Actions ou operação multiusuário nesta primeira entrega local.

## Modelo conceitual

```mermaid
flowchart LR
  UI["Settings / Connections"] --> REG["Connection registry"]
  REG --> VAULT["Credential vault"]
  REG --> DISC["Model discovery"]
  REG --> CAP["Capability probe"]

  SCAN["Novo scan"] --> COMP["Compatibility resolver"]
  COMP --> CLI["Local CLI runner"]
  COMP --> APP["Codex app-server runner"]
  COMP --> API["Sentinel API agent runner"]
  COMP --> REMOTE["Remote agent job runner"]

  CLI --> EVENTS["Eventos normalizados"]
  APP --> EVENTS
  API --> EVENTS
  REMOTE --> EVENTS
  EVENTS --> LEDGER["Run ledger / findings / cost"]
```

Uma Connection representa exatamente uma rota operacional. O usuário pode ter, por exemplo, três conexões OpenAI simultâneas:

- `Codex local — sessão existente`;
- `ChatGPT — conectado pelo Sentinel via browser/device`;
- `OpenAI API — projeto DevSecOps`.

Isso evita campos condicionais ambíguos e permite defaults diferentes por scanner.

## Rotas aprovadas por provider

### OpenAI

Três rotas independentes:

1. **Codex CLI local:** detecta e reutiliza a sessão já autenticada no Codex CLI.
2. **ChatGPT OAuth/device:** o Sentinel inicia browser login ou device code pelo contrato oficial do Codex app-server e acompanha o estado na interface. A credencial continua no armazenamento oficial do Codex.
3. **OpenAI API:** API key protegida pelo vault, descoberta por `GET /v1/models` e execução direta por Responses.

Codex CLI e OAuth/device podem usar a mesma tecnologia de runtime, mas são jornadas diferentes: uma reaproveita estado existente e a outra permite conectar a conta sem preparo manual no terminal.

### Grok / xAI

Três rotas independentes:

1. **Grok Build local:** detecta e reutiliza uma sessão existente do CLI.
2. **Grok browser/device:** o Sentinel inicia `grok login` ou `grok login --device-auth`, apresenta URL/código e acompanha a conclusão. O Grok Build obtém, renova e armazena a sessão; o Sentinel nunca recebe o refresh token.
3. **xAI API:** `XAI_API_KEY` no vault, catálogo pela API xAI e execução HTTP direta.

A xAI não documenta OAuth delegado para aplicativos terceiros nem entrega ao Sentinel um token que possa ser usado na API pública. Portanto a rota 2 é uma autenticação conduzida pela UI e mediada pelo runtime oficial, não uma implementação OAuth paralela. A tela deve explicar essa fronteira sem exigir que o usuário opere o terminal.

### Claude / Anthropic

Duas rotas independentes:

1. **Claude Code local:** reutiliza ou inicia o login oficial Claude.ai Pro/Max e executa pelo Claude Code CLI.
2. **Anthropic API:** API key da Anthropic Console e execução direta pelo protocolo Messages.

Uma assinatura Claude Max não autoriza chamadas à Messages API. Os dois cartões permanecem separados, inclusive em custo e limites.

### Cursor

Duas famílias operacionais:

1. **Cursor Agent local:** browser login ou `CURSOR_API_KEY`, ambos executados pelo Cursor Agent CLI dentro da boundary local aprovada.
2. **Cursor Background Agents API:** API pública beta de jobs remotos em repositórios GitHub. É um `RemoteAgentJobRunner`, não uma API de inferência Responses/Chat/Messages.

Cursor não documenta uma API pública de inferência bruta. A integração remota só poderá aparecer para repositórios e fluxos compatíveis com GitHub, com confirmação explícita de envio e branch. Ela não substitui a execução local de um snapshot.

### APIs conhecidas e token plans

Presets suportados pela mesma camada de protocolo:

- OpenRouter;
- Gemini;
- DeepSeek;
- xAI API;
- Anthropic API;
- OpenAI API;
- MiniMax Token Plan;
- Xiaomi MiMo Token Plan;
- custom OpenAI-compatible;
- custom Anthropic-compatible.

O preset define protocolo, formato de autenticação e estratégia de discovery. URLs regionais ou de token plan permanecem editáveis e são salvas no vault. Presets não contêm modelos.

## Contratos compartilhados

```ts
type ConnectionTransport =
  | "local-cli"
  | "codex-app-server"
  | "http-inference"
  | "remote-agent-api";

type ConnectionAuthKind =
  | "existing-session"
  | "browser-oauth"
  | "device-code"
  | "api-key"
  | "custom-headers";

type ProviderProtocol =
  | "codex-cli"
  | "codex-app-server"
  | "claude-code-cli"
  | "cursor-agent-cli"
  | "grok-build-cli"
  | "openai-responses"
  | "openai-chat"
  | "anthropic-messages"
  | "cursor-background-agents";

type ModelSelectionMode = "catalog" | "runtime-default";

type ConnectionStatus =
  | "draft"
  | "authentication-required"
  | "testing"
  | "ready"
  | "degraded"
  | "expired"
  | "unavailable";

interface ProviderConnection {
  id: string;
  scopeId: "local";
  name: string;
  providerKind: string;
  routeKind: string;
  transport: ConnectionTransport;
  authKind: ConnectionAuthKind;
  protocol: ProviderProtocol;
  status: ConnectionStatus;
  modelSelectionMode: ModelSelectionMode;
  defaultModelId: string | null;
  lastTestedAt: string | null;
  lastModelSyncAt: string | null;
  display: ConnectionDisplay;
}

interface StoredProviderConnection extends ProviderConnection {
  credentialRef: string | null;
}

interface ConnectionDisplay {
  providerLabel: string;
  routeLabel: string;
  secretConfigured: boolean;
  endpointConfigured: boolean;
  endpointKind: "preset" | "custom" | null;
}

interface ScanConnectionSelection {
  connectionId: string;
  modelSelectionMode: ModelSelectionMode;
  modelId: string | null;
}

interface ProviderModel {
  connectionId: string;
  id: string;
  displayName: string;
  contextWindow: number | null;
  capabilities: ModelCapabilities;
  pricing: ModelPricing | null;
  discoveredAt: string;
  source: "provider-api" | "runtime";
}
```

O `routeKind` é um identificador de adapter, não um enum fechado compartilhado. Novos adapters podem ser registrados sem alterar o contrato central.

`ConnectionDisplay` é um contrato fechado produzido pelo backend. Ele nunca contém URL, hostname, path, nome de header ou qualquer valor derivado do secret bundle. `credentialRef` existe apenas no registro interno da API e nunca atravessa o contrato HTTP.

## Persistência e cofre

### SQLite

Novas tabelas:

- `provider_connections`: apenas metadados não secretos e `credential_ref`;
- `provider_models`: catálogo normalizado por conexão;
- `connection_capability_checks`: resultado, evidência, erro seguro e timestamp;
- `scan_connection_snapshots`: snapshot imutável do provider, rota, modelo e capacidades usadas no run.

O banco nunca recebe API key, token OAuth, refresh token, URL customizada completa ou valor de header secreto.

### CredentialVault

Interface única:

```ts
interface CredentialVault {
  available(): Promise<VaultAvailability>;
  put(ref: string, value: ConnectionSecretBundle): Promise<void>;
  get(ref: string): Promise<ConnectionSecretBundle>;
  delete(ref: string): Promise<void>;
}
```

- macOS: Keychain;
- Linux desktop: Secret Service;
- ausência de cofre seguro: bloquear persistência de conexão secreta com instrução clara; nunca cair para plaintext.

O bundle criptografado inclui base URL, discovery URL, API key e nomes/valores de headers customizados. A UI recebe apenas representação mascarada. Atualizar um segredo exige informar um novo valor.

Credenciais de CLIs permanecem sob custódia do próprio runtime. O Sentinel guarda apenas a referência lógica e o último status observado.

## Redaction e isolamento

Aceitar segredos pela UI exige corrigir a boundary de logs antes de habilitar Connections:

- todo stdout/stderr passa por redaction antes de arquivo, buffer, SSE e console;
- headers `Authorization`, `X-Api-Key`, cookies, tokens, chaves e valores conhecidos do vault são removidos;
- requests e erros persistem URL sanitizada, sem query secreta;
- nenhum segredo entra em argumento de processo ou display command;
- API key é injetada apenas no ambiente do processo filho ou no request HTTP em memória;
- arquivos temporários de configuração, quando inevitáveis, usam modo `0600`, conteúdo mínimo e cleanup ao encerrar;
- a API local aceita apenas origem permitida e token anti-CSRF para operações de segredo;
- responses de endpoints de Connections usam `Cache-Control: no-store`.

O redactor deve preservar diagnóstico útil. Ele substitui valores por marcador estável e nunca registra hash reversível do segredo.

## Tela de Connections

Rota canônica: `/settings/connections`.

`/settings` passa a ter duas seções:

1. **System:** runtime, capacidade e ingest existentes;
2. **Connections:** autenticação, providers e modelos.

### Lista

Cada conexão mostra:

- nome e rota, não apenas o logo do provider;
- status de autenticação;
- protocolo e transporte;
- modelo padrão;
- última sincronização e último teste;
- disponibilidade para cada scanner;
- ações `Testar`, `Sincronizar modelos`, `Reconectar`, `Editar` e `Remover`.

### Fluxo de cadastro

Um Sheet/Dialog Shadcn em três etapas:

1. **Escolher rota:** assinatura local, conectar conta, API conhecida ou API customizada.
2. **Autenticar:** status de CLI, browser OAuth, device code ou formulário write-only de segredo.
3. **Descobrir e validar:** carregar catálogo real, escolher modelo padrão e executar probe explícito.

Browser OAuth mostra progresso e callback local. Device code mostra URL, código copiável, expiração e polling cancelável. Fechar o diálogo não apaga uma sessão já concluída.

Para Grok, a interface diz claramente: `Sessão gerenciada pelo Grok Build neste computador; o Sentinel não recebe seu token OAuth.`

Para OpenAI, a interface diferencia `Reutilizar Codex local` de `Conectar ChatGPT pelo Sentinel`, embora ambos possam chegar ao mesmo runtime oficial.

## API local de Connections

Endpoints propostos:

```text
GET    /connections
POST   /connections
GET    /connections/:id
PATCH  /connections/:id
DELETE /connections/:id

POST   /connections/:id/auth/start
GET    /connections/:id/auth/:flowId
POST   /connections/:id/auth/:flowId/cancel
POST   /connections/:id/disconnect

POST   /connections/:id/test
POST   /connections/:id/models/refresh
GET    /connections/:id/models
```

`POST /connections` aceita o segredo uma única vez e devolve somente metadados. O fluxo OAuth/device devolve status, verification URI e user code quando aplicável, nunca access ou refresh tokens.

Os erros são normalizados em:

- `credential_rejected`;
- `credential_expired`;
- `provider_unreachable`;
- `model_discovery_unsupported`;
- `model_access_denied`;
- `endpoint_access_denied`;
- `rate_limited`;
- `secure_storage_unavailable`;
- `runtime_missing`;
- `runtime_version_unsupported`.

## Descoberta de modelos

Nenhuma opção de modelo é mantida no catálogo estático do frontend.

Fontes:

- Codex app-server: `model/list`;
- Grok Build: `grok models`;
- Cursor Agent: comando de catálogo suportado pelo runtime;
- OpenAI-compatible: `GET {baseUrl}/models` ou discovery URL configurada;
- Anthropic-compatible: `GET /v1/models` ou discovery URL configurada;
- xAI API: models endpoint oficial;
- OpenRouter: catálogo completo da API;
- Cursor Background Agents: modelos/capacidades retornados pela API quando disponíveis.

Se o provider não expuser catálogo, a conexão não fabrica modelos. Claude Code é a exceção operacional conhecida: enquanto o CLI não expuser catálogo programático oficial, a única seleção permitida é `Runtime default`, identificada como delegada e não como model ID descoberto.

Catálogos ficam em cache para experiência offline e histórico, mas aparecem como `stale` até nova sincronização. Ao iniciar um scan com catálogo stale, o backend revalida acesso ao modelo escolhido sem substituir silenciosamente a seleção.

## Capability probe

Discovery prova existência, não compatibilidade. O usuário executa um probe barato apenas no modelo escolhido.

O relatório normaliza:

- protocolo aceito;
- streaming;
- tool calls;
- structured output estrito ou apenas validado localmente;
- usage input/output/cache/reasoning;
- pricing retornado pelo provider;
- contexto conhecido;
- cancelamento remoto ou somente local;
- erros de ACL por endpoint ou modelo.

Capacidade não comprovada fica `unknown`; nunca é convertida automaticamente em `supported`.

## Runner de API controlado pelo Sentinel

Mantis e VulnHunter não podem enviar um prompt grande para qualquer `/chat/completions` e esperar artifacts mágicos. APIs genéricas usam um loop agentic pequeno e controlado:

```ts
interface AgentSessionRunner {
  probe(input: ProbeInput): Promise<CapabilityReport>;
  createSession(input: SessionSpec): AgentSession;
}
```

Ferramentas v1:

- `workspace.list`;
- `workspace.read`;
- `workspace.search`;
- `results.write`.

Não há shell, edição do snapshot, rede adicional ou execução de código. Paths são canonicalizados; `..`, absolutos e symlinks que escapam da raiz são bloqueados. Escrita ocorre apenas no artifact store do run.

Adapters de wire:

- OpenAI Responses;
- OpenAI Chat Completions;
- Anthropic Messages.

Todos emitem o mesmo stream de eventos de run, tool, artifact, usage, completion, cancellation e failure.

## Compatibilidade com scanners

### Codex Security

Estável apenas nas rotas oficialmente suportadas pelo pacote atual:

- OpenAI/ChatGPT;
- OpenAI API;
- OpenRouter;
- Fireworks;
- Amazon Bedrock.

O Codex CLI suporta providers customizados via TOML/Responses, mas o wrapper Codex Security 0.1.8 não oferece contrato estável para credencial e recipe de provider arbitrário. Por isso, conexões customizadas ficam indisponíveis para Codex Security com razão objetiva. Elas são executadas exclusivamente pelo Sentinel API Agent Runner em Mantis e VulnHunter. Suporte futuro exige contrato oficial novo ou adapter explicitamente versionado; um probe isolado não altera essa decisão.

### Mantis e VulnHunter

Podem usar:

- Codex CLI/app-server;
- Sentinel API Agent Runner;
- Claude Code CLI após validar sandbox e artifacts;
- Grok Build CLI após validar sandbox do sistema operacional;
- Cursor Agent CLI em preview até provar isolamento de rede e filesystem;
- Cursor Background Agents apenas como job remoto explícito, nunca como substituto transparente de um scan local.

No macOS, qualquer CLI cujo sandbox não bloqueie egress de processos filhos permanece preview até existir isolamento externo verificável.

### Resolver

O frontend não mantém essa matriz. A API calcula:

```text
scanner requirements
  ∩ runner capabilities
  ∩ connection protocol
  ∩ model probe
  ∩ operating-system guarantees
= compatibility decision + reasons
```

Conexões incompatíveis aparecem desabilitadas no novo scan, acompanhadas da razão objetiva.

## Novo fluxo de scan

Ordem aprovada:

1. selecionar repositório e escopo;
2. selecionar scanner;
3. selecionar Connection compatível;
4. selecionar modelo descoberto;
5. configurar opções do scanner;
6. revisar custo/telemetria disponíveis;
7. iniciar.

`StartScanRequest` passa a receber `connectionId`, `modelSelectionMode` e `modelId: string | null`. O backend resolve o segredo e o runner. No modo `catalog`, `modelId` é obrigatório e precisa pertencer ao catálogo da conexão. No modo `runtime-default`, `modelId` deve ser `null` e a conexão precisa declarar exatamente esse modo. `provider`, `authMode` e `model` permanecem no run apenas como snapshot legível e histórico.

Um run nunca muda de conexão ou modelo silenciosamente. Fallback exige política explícita futura.

## Telemetria, custo e histórico

- APIs com usage reportado alimentam input, cache write/read, output e reasoning.
- xAI pode fornecer custo por request; ele prevalece sobre estimativa externa.
- Quando há tokens e preço conhecido, o Sentinel calcula estimativa com fonte e timestamp.
- Quando CLI não reporta usage, tokens e custo ficam `null`, não zero.
- Runs preservam connection snapshot mesmo após editar ou remover a conexão.
- Histórico nunca depende de conseguir reabrir o segredo.
- Status OAuth/device e testes de conexão usam eventos separados da telemetria de scan.

## Estados de erro

- Vault indisponível: permitir apenas conexões sem segredo e bloquear save de API key.
- CLI ausente: mostrar comando de instalação/documentação; não tentar instalar silenciosamente.
- Sessão expirada: preservar cadastro e marcar `expired`.
- Device code expirado: permitir gerar um novo fluxo sem duplicar a conexão.
- Discovery falhou: manter último catálogo como stale, sem afirmar acesso atual.
- Modelo removido: bloquear novo scan e manter runs históricos intactos.
- Provider custom sem `/models`: permitir discovery URL explícita; sem ela, cadastro não fica ready.
- API key sem ACL de models: identificar `endpoint_access_denied`, não `credential_rejected`.
- Cancelamento local sem confirmação remota: mostrar `local cancellation requested`, não `provider cancelled`.

## Acessibilidade e responsividade

- Etapas, cards, menus e status têm nomes acessíveis e foco visível.
- Status não depende apenas de cor.
- Device code e URLs possuem ação de copiar com confirmação anunciada.
- Erros ficam vinculados ao campo correspondente e resumidos no topo do diálogo.
- Segredos suportam password manager e toggle de visibilidade temporário.
- Desktop usa lista + detalhe; tablet e mobile empilham a lista e abrem o detalhe em Sheet.
- Validar 1600×1000, 1024×768, 820×1180, 390×844 e 344×882.
- Movimento curto e removido em `prefers-reduced-motion`.

## Design visual

O recurso segue o Test Bench Okami existente:

- painéis conectados, sem grade de cards genéricos;
- cobre para comando e seleção;
- seafoam para conexão comprovadamente pronta;
- straw para stale/preview;
- coral para erro ou auth expirada, sempre acompanhado de texto;
- JetBrains Mono para protocolos, model IDs, timestamps e status técnicos;
- Manrope/Geist para títulos e explicações;
- Shadcn/Radix para Dialog, Sheet, Tabs, Select, Password input, Tooltip e foco;
- logos identificam provider, mas nome da rota e método de autenticação têm hierarquia maior.

## Testes

### Determinísticos

1. migrations nunca persistem secret bundle;
2. vault round-trip e indisponibilidade sem fallback plaintext;
3. API nunca devolve segredo em GET, PATCH error ou JSON de validação;
4. redaction antes de arquivo, SSE e console;
5. múltiplas conexões do mesmo provider permanecem independentes;
6. discovery normaliza APIs e CLIs sem lista hardcoded;
7. catálogo stale não troca modelo silenciosamente;
8. probe diferencia unsupported, denied, invalid credential e rate limit;
9. resolver produz razões estáveis por scanner e sistema operacional;
10. run snapshot sobrevive à remoção da conexão;
11. usage ausente continua `null`;
12. OAuth/device nunca aparece nos logs como token;
13. cancelamento impede novas tool calls;
14. tool host bloqueia traversal, symlink escape e escrita fora de artifacts.

### Integração

- fake OpenAI Responses com tools e usage;
- fake Chat Completions com tool calls;
- fake Anthropic Messages com `tool_use`/`tool_result`;
- mock `/models` com paginação, ACL e modelo removido;
- fake device flow completo, expirado e cancelado;
- fake CLI status/models/scan sem depender de conta real;
- teste opcional, explicitamente autorizado, com provider real sem registrar payload secreto.

### Frontend

- fluxo de cadastro por teclado;
- OAuth browser e device code;
- API key write-only;
- conexão pronta, stale, expirada e indisponível;
- filtro de catálogos extensos como OpenRouter;
- compatibilidade e razões no novo scan;
- ausência de overlap, clipping e scroll horizontal nos breakpoints definidos;
- contraste, reduced motion e erros de console.

## Sequência de entrega

1. Redaction global e abstração `CredentialVault`.
2. Schema SQLite e contratos de Connections.
3. API CRUD, auth flow e discovery registry.
4. Tela `/settings/connections` com OpenAI, Grok, Claude, Cursor e APIs customizadas.
5. Integração do novo seletor no fluxo de scan.
6. Sentinel API Agent Runner com Responses.
7. Adapters Chat Completions e Anthropic Messages.
8. Rotas Codex CLI/app-server e Claude Code.
9. Rotas Grok Build e Cursor Agent sob os gates de sandbox.
10. Cursor Background Agents em preview remoto.
11. Probes reais autorizados e matriz final de compatibilidade.

## Critérios de aceitação

- O usuário cadastra e mantém várias conexões sem reautenticar a cada scan.
- OpenAI mostra separadamente CLI existente, OAuth/device conduzido pelo Sentinel e API.
- Grok mostra separadamente CLI existente, OAuth/device conduzido pelo Sentinel e xAI API, sem o Sentinel capturar token OAuth.
- Claude mostra Claude Code Max e Anthropic API como limites e cobranças distintas.
- Cursor mostra CLI e Background Agents API sem fingir que existe inferência HTTP genérica.
- MiniMax e MiMo aceitam a URL correta do token plan.
- Modelos exibidos vêm exclusivamente de discovery real ou de `Runtime default` explicitamente delegado.
- Scanner, conexão e modelo incompatíveis não iniciam um run.
- Nenhum segredo aparece em banco, logs, SSE, manifests, erros ou comandos apresentados.
- Mantis e VulnHunter produzem artifacts equivalentes usando os protocolos HTTP suportados.
- Codex Security só anuncia estabilidade para providers realmente suportados pela versão instalada.
- Usage e custo ausentes aparecem como indisponíveis, nunca como zero.
- A tela funciona sem clipping ou sobreposição em desktop, tablet, mobile e telas estreitas.

## Fontes de contrato

- [Codex app-server](https://developers.openai.com/codex/app-server)
- [Codex configuration reference](https://developers.openai.com/codex/config-reference)
- [Codex Security CLI reference](https://learn.chatgpt.com/docs/security/cli/reference)
- [Claude Code authentication](https://docs.anthropic.com/en/docs/claude-code/getting-started)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code/cli-usage)
- [Cursor CLI authentication](https://docs.cursor.com/en/cli/reference/authentication)
- [Cursor Background Agents API](https://docs.cursor.com/background-agent/api/overview)
- [Grok Build CLI](https://docs.x.ai/build/cli/reference)
- [Grok Build enterprise authentication](https://docs.x.ai/build/enterprise)
- [xAI inference API](https://docs.x.ai/developers/rest-api-reference/inference)
