# GitHub e Guardrails

**Status:** aprovado para implementação

**Data:** 2026-09-30

**Produto:** Okami Sentinel

**Depende de:** `2026-09-29-multi-user-access-design.md` (papéis por repositório,
política de rotas), `2026-09-30-email-notifications-design.md` (alertas
operacionais), `2026-08-12-github-remote-guardrails-design.md` (identidade da
GitHub App, dois executores), `2026-08-07-security-change-gate-design.md`
(conceito de gate)

**Substitui:** `github-monitoring.md` (decisões de 2026-09-08 — polling sem
webhook, uma regra por repositório)

## Problema

O gate existe e funciona, mas quase nada dele chega a quem abre um PR.

- O único gatilho é um *poll* de 60 s sobre a API do GitHub. Um PR que abre e
  fecha entre dois ciclos não é visto; um force-push no meio do intervalo só
  produz o SHA mais novo. A App criada pelo produto assina **zero** eventos e
  não existe endpoint de webhook em nenhum lugar da API.
- Cada repositório aceita **uma** regra de automação. "Vigiar `main` barato e
  `release/*` profundo" não é expressável.
- A aba GitHub mostra três cartões de "fontes acompanhadas" com um ✓ fixo em
  HTML, um painel de checkout local permanentemente desabilitado em servidor, e
  um seletor de executor que renderiza uma única opção — um administrador nunca
  consegue criar uma regra GitHub Actions, e os ~1.700 LOC do executor Actions
  são inalcançáveis pela interface.
- A política de um repositório GitHub é somente leitura no Sentinel. O editor é
  um gerador de proposta: copia JSON que ninguém comita. Sem
  `.csb/guardrails.json` na branch protegida, todo gate roda o default em
  silêncio.
- O primeiro PR de qualquer repositório recém-cadastrado devolve um artefato de
  erro operacional `baseline_absent:initialize_protected_branch`, porque a
  baseline só nasce de um gate manual de branch protegida que nada na interface
  pede. Qualquer troca de modelo invalida todas as baselines pelo mesmo caminho.
- O botão manual "Publicar check" usa o `gh` CLI, que nunca é autenticado em
  produção: falha com 502 enquanto o caminho automático, pela App, funciona.
- Um gate bloqueado não escreve nada no PR. Não há comentário.

## Objetivo

- Trocar o polling por **webhooks da GitHub App**, assinados e idempotentes, com
  uma reconciliação de leitura a cada 15 min para o que se perdeu em indisponi-
  bilidade.
- Substituir "uma regra por repositório" por **ações** — quantas o operador
  quiser, cada uma com evento, executor, perfil de scan e teto de custo.
- Escrever de volta no PR: **um comentário sticky detalhado** editado a cada
  commit, ao lado do Check Run, ambos publicados pela App.
- Deixar o produto avaliar um PR **sem baseline** em vez de devolver erro, e
  criar a baseline sozinho no primeiro merge.
- Tornar a política **editável no Sentinel**, com `.csb/guardrails.json`
  prevalecendo quando existir e a tela dizendo isso.
- Duas abas com papéis claros: GitHub = integração e automação; Guardrails =
  repositórios, política, baseline, gates.
- Apagar o que é decorativo ou morto.

## Fora de escopo

- Bloquear merge. O Check Run é informativo; a proteção de branch continua sendo
  responsabilidade de quem administra o repositório no GitHub.
- PAT e OAuth de usuário. O acesso continua sendo só GitHub App.
- Scans agendados, por cron ou por tempo. Nenhum scan sem uma mudança.
- Comitar `.csb/guardrails.json` a partir do Sentinel.
- Escrever regras de proteção de branch pela API.
- Outros provedores de hospedagem (GitLab, Bitbucket).
- Revisão inline (comentários por linha no diff). O comentário é único e sticky.
- Repositórios locais na automação: continuam fora, agora com mensagem
  explicando por quê.

## Decisões

| Tema | Decisão |
|---|---|
| Escopo | Gate de PR **e** monitoramento contínuo, juntos, em 5 fases |
| Monitoramento | Orientado a evento. Scan só com PR aberto/atualizado ou push/merge em branch configurada |
| Gatilho | Webhook da GitHub App (padrão) + executor GitHub Actions, selecionável por ação |
| Recuperação | Reconciliação somente leitura a cada 15 min; sem scan sem commit novo |
| Polling | Removido |
| Unidade de configuração | **Ação** (`github_actions`), N por repositório, substitui `github_monitor_rules` |
| Bloqueio de merge | Não. Check informativo, nota discreta na interface sobre como exigi-lo |
| Baseline | Automática no primeiro merge/push na branch protegida após o cadastro, mais botão "Criar baseline agora" |
| PR sem baseline | Avaliado (findings do change, sem comparação), decisão `bootstrap`, aviso "sem baseline" |
| Política | Editável na interface por repositório, com presets e simulação; `.csb/guardrails.json` prevalece |
| Comentário no PR | Um comentário sticky por PR, editado no lugar, **sempre detalhado**, público ou privado |
| Redação | Redação pública do gate-core (`redactPublicText`) aplicada a todo texto do scan |
| Publicar check manual | Pela GitHub App. `gh` CLI sai do caminho de publicação |
| Custo | Criar ou habilitar ação que gasta exige administrador; mantenedor pode desabilitar |
| Segredo do webhook | No vault, junto da chave privada da App. Nenhuma variável de ambiente nova |
| Idioma do comentário | Inglês, sempre |
| Interface | Duas abas: GitHub (integração + ações + atividade), Guardrails (repositórios + política + baseline + gates) |

Alternativas descartadas: manter o polling como gatilho principal (perde PRs
curtos e força latência de até 60 s por um custo de *rate limit* permanente);
webhook com segredo em variável de ambiente (custódia diferente da chave
privada, e o operador teria de reimplantar para trocá-lo); bloquear merge por
Check obrigatório configurado pelo Sentinel (exige `administration: write`, uma
permissão que o produto não deve pedir); comentário resumido em repositório
público (a operadora escolheu detalhe consciente, e a redação pública já é a
mesma que o artefato publicado usa).

## Ambiguidades resolvidas

Cada linha é uma decisão que a lista de decisões não fixava. Todas valem como
parte da especificação.

| Ambiguidade | Resolução |
|---|---|
| Qual segredo verifica a assinatura quando há várias conexões de App | Cada conexão tem seu segredo. O handler tenta todas as conexões com segredo configurado, em ordem estável, comparação de tempo constante, no máximo 20. O primeiro par válido identifica a conexão. O vazamento de tempo é a quantidade de conexões, que um administrador já conhece |
| Quando a entrega é registrada | **Só depois** da assinatura válida. Registrar antes deixaria um chamador anônimo encher a tabela |
| Baseline incompatível (lineage, cobertura, política) | Deixa de ser erro operacional e cai no caminho "sem baseline", com o motivo no aviso. Uma atualização de engine não pode tornar todo PR vermelho |
| Baseline indisponível (artefato ilegível) | Continua erro operacional: é falha do Sentinel, não estado do repositório |
| Cobertura incompleta no scan atual | Continua erro operacional. Não se relata finding do que não foi lido |
| `bootstrap` bloqueia? | Nunca. Sem baseline não há prova do que é novo; a decisão é `bootstrap` → `neutral` |
| Elegibilidade de publicação do Check | Passa a valer para **qualquer** PR de repositório `source: github` com `checks: write`, não só PR cuja base é branch protegida. A comparabilidade da baseline continua exigindo branch protegida |
| `.csb/guardrails.json` inválido | Não cai no default em silêncio: o gate registra `policy_invalid`, usa a política salva no Sentinel e avisa na tela e no comentário |
| `policySource` | Ganha três valores explícitos: `repository_file`, `sentinel`, `default` |
| Idioma do comentário | Inglês. Quem lê um PR não é usuário do Sentinel e não tem `locale` |
| Eventos de PR e `followBranches` | Uma ação `pull_request` casa pelo **`base.ref`** do PR. O campo passa a se chamar "padrões de branch" e vale para os dois tipos de evento, encerrando a divergência atual |
| `check_run.rerequested` | Exceção explícita ao "mesmo commit nunca duas vezes": foi uma pessoa que pediu. O evento nasce com `origin='manual'` |
| Executor GitHub Actions e a regra de custo | Gasta dinheiro do cliente (minutos e `OPENAI_API_KEY` do repositório). Também exige administrador para criar ou habilitar |
| O que um mantenedor pode fazer numa ação | Desabilitar, renomear e ajustar padrões de branch de uma ação **desabilitada**. Habilitar, trocar executor, conexão, modelo ou teto exige administrador |
| Repositório removido do registro | `DELETE` existe e é administrador. Gates, grants, baselines e assinaturas caem por `ON DELETE CASCADE`; o artefato em disco é apagado junto |
| Ação de repositório removido da instalação | O evento `installation_repositories.removed` desabilita as ações do repositório e registra o motivo. Nada é apagado |
| `gh` CLI | Sai do caminho de publicação (`publishGateCheck` é removido). Continua servindo o estado Git de repositórios locais em `github-status.ts` |
| `GET /github-checkouts*` | Removidas junto do painel de checkout, na Fase 5 |
| Tabelas `github_monitor_*` | Renomeadas com sufixo `_migrated` na Fase 1 (rollback possível) e removidas na Fase 5 |
| Onde a baseline "pronta" é lida | Uma projeção (`guardrail_repository_baselines`) mantida pelo próprio gate. A autoridade continua sendo o artefato do gate de branch protegida mais recente e comparável; a projeção existe para a tela ler uma palavra sem N chamadas |
| Comentário quando não há PR | Não há comentário. Gate de branch protegida ou de comparação de refs publica só o Check |
| Falha ao publicar o comentário | Reutiliza o alerta `ops.github_publish_failed`, com o gate como alvo. Nenhum evento de e-mail novo |
| Latência do webhook | O handler responde em uma transação curta (entrega + eventos) e despacha fora do ciclo da requisição. GitHub nunca espera um scan |
| `head.repo` ausente ou `null` | Conta como fork: `ignored` / `pull_request_repository_unknown`. O GitHub manda `head.repo: null` quando o repositório do head sumiu ou está inacessível — o caso clássico é apagar o fork depois de abrir o PR — e um controle cujo motivo é "código não confiável com o nosso token" não pode ler dado ausente como confiança. Com `include_forks`, a ação escaneia por `pull/<n>/head`, que existe no repositório base mesmo sem o fork |
| PR de *fork* | **Não é escaneado por padrão**: `ignored` / `fork_pull_request`. O head de um fork é código que ninguém da organização escreveu, rodando com o token da instalação e o orçamento do cliente, e o `.csb/guardrails.json` do próprio autor seria a política que o julga. Opt-in por ação (`github_actions.include_forks`, default `0`, só administrador habilita). Habilitado, o evento nasce com `head_ref = pull/<n>/head` — o ref que existe no repositório base — e política e baseline continuam vindo **da branch base**, nunca do head do fork |
| PR em *draft* | Não escaneado enquanto é rascunho: `ignored` / `draft_pull_request`. `ready_for_review` é exatamente o momento em que o autor pede o veredicto, e já está na lista de ações tratadas |
| Ordem das entregas | O GitHub não garante ordem entre entregas, e o botão *Redeliver* reenvia uma antiga. A supersedência é **ordenada**: só cancela evento cuja mudança é estritamente mais antiga, pelo relógio do próprio payload (`pull_request.updated_at`, `repository.pushed_at`) guardado em `github_action_events.observed_at`, e só depois de o evento do head novo estar gravado. Os relógios do GitHub têm resolução de um segundo, então o empate é desfeito pela ordem de inserção (`rowid`), numa direção só: dois heads no mesmo segundo deixam **um** evento na fila, nunca dois gates. Entrega mais antiga que o que já está na tabela → `ignored` / `stale_delivery`, sem criar e sem cancelar nada. Mudança com mais de 24 h → mesmo `stale_delivery` |
| Entrega recusada | O GitHub **não reentrega** um webhook automaticamente: 4xx/5xx marca a entrega como falha e espera um humano clicar *Redeliver*. Toda recusa registra em log o `delivery_id`, o evento e o código do motivo (nunca o payload nem o segredo). `pull_request` e `push` perdidos voltam pela reconciliação; `installation`, `installation_repositories` e `check_run` não, e por isso a reconciliação também **re-lista as instalações** (ver *Reconciliação*). Um `rerequested` perdido é reexecutável pela pessoa que clicou |
| Check run de outra App | `check_run.rerequested` só vale se `check_run.app.id` é o App da conexão que assinou; qualquer outra coisa é `ignored` / `check_run_not_ours`. A busca do gate é escopada por conexão **e** repositório resolvido, nunca pelo `external_id` sozinho |

## Modelo de dados

Tudo em SQLite, transações `IMMEDIATE` via `openSqliteFile`, migrações
idempotentes sobre o banco de produção.

### Registro de repositórios

`guardrail_repositories` permanece a chave do modelo. Mudanças:

| Coluna | Mudança |
|---|---|
| `enabled` | Passa a ser escrita: `PATCH /guardrails/repositories/:key` desabilita sem apagar |
| `default_executor` | Deixa de ser *write-once*: o mesmo `PATCH` o altera |
| `pr_comment_enabled` | Nova, `INTEGER NOT NULL DEFAULT 1` |
| `pr_comment_detail` | Nova, `TEXT NOT NULL DEFAULT 'detailed'`, `CHECK (pr_comment_detail IN ('detailed','summary'))`. O padrão e a única opção usada hoje é `detailed`; a coluna existe para que a escolha consciente da operadora fique registrada e reversível sem migração |
| `removed` | Não existe. Remover é `DELETE`, com cascata |

`POST /guardrails/repositories` passa a aceitar `{ connectionId, installationId,
repositoryIds: string[] }` (1..50) e devolve `{ enrolled: [...], skipped: [{
repositoryId, reason }] }`. Cadastro parcial é resultado normal: um repositório
já cadastrado é `skipped` com `already_enrolled`, não 409.

### Ações (`github_actions`) — substitui `github_monitor_rules`

```sql
CREATE TABLE IF NOT EXISTS github_actions (
  id TEXT PRIMARY KEY,
  repository_key TEXT NOT NULL REFERENCES guardrail_repositories(repository_key) ON DELETE CASCADE,
  name TEXT NOT NULL,
  trigger_kind TEXT NOT NULL,
  branch_patterns_json TEXT NOT NULL,
  executor TEXT NOT NULL DEFAULT 'sentinel-managed',
  connection_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  scanner_json TEXT,
  cost_ceiling_usd REAL NOT NULL,
  daily_cost_ceiling_usd REAL,
  enabled INTEGER NOT NULL DEFAULT 0,
  include_forks INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  baseline_initialized_at TEXT,
  created_by TEXT,
  last_event_at TEXT,
  last_reconciled_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (repository_key, trigger_kind, name),
  CHECK (trigger_kind IN ('pull_request', 'push')),
  CHECK (executor IN ('sentinel-managed', 'github-actions')),
  CHECK (enabled IN (0, 1)),
  CHECK (include_forks IN (0, 1)),
  CHECK (revision >= 1),
  CHECK (cost_ceiling_usd > 0),
  CHECK (daily_cost_ceiling_usd IS NULL OR daily_cost_ceiling_usd > 0),
  CHECK (length(name) BETWEEN 1 AND 80)
);
```

- `cost_ceiling_usd` é `NOT NULL`: uma ação sem teto não pode existir, nem
  desabilitada. O teto era obrigatório apenas para ativar; agora é do registro.
- `daily_cost_ceiling_usd` limita o **repositório**, não a ação: a reserva do dia
  soma o `cost_ceiling_usd` de todos os eventos despachados por **qualquer** ação
  daquele repositório na janela UTC, e a ação só despacha se
  `reservado_hoje + teto_do_scan <= daily_cost_ceiling_usd dela`. Uma regra que
  limitava o repositório a $6/dia virou duas ações na migração; sem esta
  definição o mesmo repositório passaria a poder reservar $12 no dia do corte. O
  custo da escolha é explícito: uma ação com teto diário baixo pode ficar sem
  janela porque uma irmã gastou o dia do repositório. O alerta `ops.daily_cost`
  é, pelo mesmo motivo, chaveado por `(repositório, teto, dia, limiar)` — não por
  ação, ou o par migrado avisaria duas vezes o mesmo fato.
- `checkout_mode` não existe. O caminho de sincronização de checkout sai inteiro.
- `branch_patterns_json`: 1..20 padrões (`main`, `release/**`), validados pelo
  mesmo validador de branch já usado hoje. Para `pull_request` casam contra
  `base.ref`; para `push`, contra o nome curto de `ref`.
- `revision` é incrementada, e `baseline_initialized_at` zerada, em qualquer
  alteração de campo que afete o que a ação observa — a garantia atual de que
  editar uma ação não dispara scans retroativos sobre a fila de PRs abertos.

**Migração** (`ensureGitHubActionsSchema`, versão 1 de
`github_actions_schema_migrations`, transação `IMMEDIATE`):

1. Cria `github_actions`, `github_action_events`, `github_webhook_deliveries`.
2. Para cada linha de `github_monitor_rules`, insere **duas** ações preservando
   `enabled`, executor, autoridade remota, `scanner_json` e tetos: uma
   `trigger_kind='pull_request'` chamada `PR`, outra `trigger_kind='push'`
   chamada `Push`, ambas com `branch_patterns_json = follow_branches_json` e
   `revision = 1`, `baseline_initialized_at` copiada. Regra sem
   `cost_ceiling_usd` (possível só se nunca foi ativada) entra desabilitada com
   `cost_ceiling_usd = 1.0` e `last_error = 'migrated_without_ceiling'`.
3. Migra `github_monitor_events` para `github_action_events`, ligando cada linha
   à ação do mesmo `kind`, com `origin='reconciliation'` e `delivery_id NULL`,
   preservando `status`, `gate_id`, `reason`, `error` e datas. O histórico de
   atividade sobrevive.
4. `ALTER TABLE github_monitor_rules RENAME TO github_monitor_rules_migrated` e
   o mesmo para `github_monitor_events`, `github_monitor_actions_runs`,
   `github_monitor_poll_leases`. Nenhum código novo lê essas tabelas; a Fase 5
   as remove.

### Eventos (`github_action_events`)

```sql
CREATE TABLE IF NOT EXISTS github_action_events (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL REFERENCES github_actions(id) ON DELETE CASCADE,
  repository_key TEXT NOT NULL,
  action_revision INTEGER NOT NULL,
  origin TEXT NOT NULL,
  delivery_id TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  base_ref TEXT,
  head_ref TEXT NOT NULL,
  pull_request_number INTEGER,
  target_identity TEXT NOT NULL,
  title TEXT,
  gate_id TEXT,
  cost_ceiling_usd REAL,
  reason TEXT,
  error TEXT,
  detected_at TEXT NOT NULL,
  observed_at TEXT,
  dispatched_at TEXT,
  completed_at TEXT,
  CHECK (origin IN ('webhook', 'reconciliation', 'manual')),
  CHECK (kind IN ('pull_request', 'push')),
  CHECK (status IN ('observed', 'queued', 'dispatching', 'launched', 'skipped', 'failed', 'superseded')),
  CHECK (length(head_sha) = 40),
  CHECK (pull_request_number IS NULL OR pull_request_number > 0),
  UNIQUE (action_id, action_revision, target_identity)
);
CREATE INDEX IF NOT EXISTS github_action_events_by_action_status
  ON github_action_events(action_id, status, detected_at ASC);
CREATE INDEX IF NOT EXISTS github_action_events_by_action_dispatch
  ON github_action_events(action_id, dispatched_at);
CREATE INDEX IF NOT EXISTS github_action_events_by_pr
  ON github_action_events(action_id, pull_request_number, status);
CREATE INDEX IF NOT EXISTS github_action_events_by_repository
  ON github_action_events(repository_key, detected_at DESC);
```

`target_identity`: `pr:<number>@<headSha>` para `pull_request`,
`push:<shortRef>@<headSha>` para `push`.

### Entregas de webhook (`github_webhook_deliveries`)

```sql
CREATE TABLE IF NOT EXISTS github_webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  event TEXT NOT NULL,
  action TEXT,
  repository_key TEXT,
  installation_id TEXT,
  head_sha TEXT,
  outcome TEXT NOT NULL,
  reason TEXT,
  matched_action_ids_json TEXT NOT NULL DEFAULT '[]',
  event_ids_json TEXT NOT NULL DEFAULT '[]',
  received_at TEXT NOT NULL,
  duration_ms INTEGER,
  CHECK (outcome IN ('processed', 'ignored', 'failed'))
);
CREATE INDEX IF NOT EXISTS github_webhook_deliveries_by_received
  ON github_webhook_deliveries(received_at DESC);
```

`delivery_id` é a própria chave de idempotência. Retenção: as 2.000 linhas mais
recentes, apagando o excedente na mesma transação de inserção (a cada 100
inserções, para não varrer a tabela em toda entrega).

### Estado da baseline (`guardrail_repository_baselines`)

```sql
CREATE TABLE IF NOT EXISTS guardrail_repository_baselines (
  repository_key TEXT PRIMARY KEY REFERENCES guardrail_repositories(repository_key) ON DELETE CASCADE,
  state TEXT NOT NULL,
  gate_id TEXT,
  commit_sha TEXT,
  protected_branch TEXT,
  scan_lineage_hash TEXT,
  built_at TEXT,
  stale_reason TEXT,
  requested_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK (state IN ('absent', 'building', 'ready', 'stale'))
);
```

Projeção, não segunda autoridade. Recalculada por
`refreshRepositoryBaselineState(repositoryKey)`, chamada quando um gate termina,
quando a política é salva e quando uma ação muda de modelo, esforço ou modo. A
função lê o candidato de baseline pela regra que já existe
(`managedBaselineCandidate`) e grava a palavra resultante.

### Política por repositório (`guardrail_repository_policies`)

```sql
CREATE TABLE IF NOT EXISTS guardrail_repository_policies (
  repository_key TEXT PRIMARY KEY REFERENCES guardrail_repositories(repository_key) ON DELETE CASCADE,
  policy_json TEXT NOT NULL,
  preset TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  CHECK (preset IN ('block-critical-high', 'block-critical', 'warn-only', 'custom'))
);
```

### Comentário no PR (`github_pr_comments`)

```sql
CREATE TABLE IF NOT EXISTS github_pr_comments (
  id TEXT PRIMARY KEY,
  repository_key TEXT NOT NULL REFERENCES guardrail_repositories(repository_key) ON DELETE CASCADE,
  pull_request_number INTEGER NOT NULL,
  comment_id TEXT,
  gate_id TEXT,
  head_sha TEXT,
  body_hash TEXT,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (repository_key, pull_request_number),
  CHECK (status IN ('published', 'failed'))
);
```

`body_hash` é o SHA-256 do corpo renderizado: um gate que produz exatamente o
mesmo texto não gasta uma chamada de `PATCH`.

## Ingestão de webhook

Rota: `POST /github/webhook` (em produção
`https://sentinel.okamilab.com/api/github/webhook`).

### Segurança

| Controle | Implementação |
|---|---|
| Autenticação | HMAC-SHA256 sobre os **bytes crus** do corpo, cabeçalho `X-Hub-Signature-256: sha256=<hex>` |
| Comparação | `crypto.timingSafeEqual` sobre buffers de mesmo tamanho; tamanho diferente é rejeição imediata sem comparar |
| Segredo | Por conexão de App, no vault (`SystemGitHubAppCredentialStore`, campo `webhookSecret`). O cabeçalho `X-GitHub-Hook-Installation-Target-ID` é o *App id* da entrega e escolhe a conexão **antes** de qualquer hash: o caso normal é **um** HMAC. Sem o cabeçalho cai no laço estável de no máximo 20; com um App id que **nenhuma** conexão reivindica também, e o caso fica registrado como `webhook_app_id_unmatched` — um aviso **informativo** (a entrega foi aceita), uma linha por conexão a cada 10 min, porque é configuração errada parada e não evento — um `appId` gravado errado (o id da instalação, o client id, o slug) não pode responder `401` a cada entrega em silêncio, com a mesma cara de segredo errado. O conjunto de segredos é lido por *snapshot* em cache curto (`createWebhookSecretCache`, 30 s, invalidado ao gravar um segredo), para que uma enxurrada não assinada não vire uma enxurrada de decifragens do vault |
| Limite de tamanho | 1 MiB. Acima disso: `413 payload_too_large`, **sem** registrar entrega |
| Replay | `X-GitHub-Delivery` é a PK de `github_webhook_deliveries`. Conflito → `200 {"status":"duplicate"}`, nenhum trabalho |
| Sessão | Nenhuma. `["POST", "/github/webhook", PUBLIC]` na `ROUTE_POLICY` |
| CSRF / Origin | Isento, como o callback do manifest: `serverSecurity` ganha a exceção explícita para este par método+caminho |
| Limite de taxa | A assinatura é verificada **primeiro**, e `FailureWindow` por IP conta só verificações falhas: 30 em 5 min. Passado o limite, o que aquele endereço ainda pode custar depende de ele saber nomear uma App nossa: entrega que traz um `X-GitHub-Hook-Installation-Target-ID` conhecido **é lida e verificada** (um hash), então uma entrega correta nunca é recusada por causa do segredo errado de outra conexão, em nenhum segundo; qualquer outra coisa daquele endereço é recusada com `429 rate_limited` + `Retry-After` **antes de ler o corpo**. Teto separado e generoso para as que verificaram: 600 por minuto |
| Tetos de trabalho | Três orçamentos, porque limitam coisas diferentes. **Leituras de corpo, globais** (64): manter uma leitura custa no máximo 1 MiB, então o teto fica bem acima de qualquer concorrência honesta e **não é fronteira de segurança** — o `X-GitHub-Hook-Installation-Target-ID` que uma admissão poderia exigir não é segredo (o GitHub o manda em toda entrega e ele é legível na própria App), então qualquer um apresenta uma entrega de aparência admissível. Excesso é recusado (`429`). **Leituras de corpo, por endereço** (4, fila de 4): esta é a fronteira. A enxurrada é cobrada de quem a causou, então nenhum endereço — nem um punhado deles — consome o teto global, seja o que for que nomeie. Aqui o excesso **espera** (limite curto) em vez de ser recusado, porque o endereço de uma enxurrada pode ser o próprio egresso do GitHub e uma entrega recusada é evento perdido; o slot liberado vai para quem já esperava, nunca para uma conexão nova, então a enxurrada custa **atraso**, não o evento. **Prazos da leitura**: 10 s para uma leitura que *progride* e 2 s de **silêncio** — sem o primeiro byte, ou sem byte novo desde o último — ambos viram `408 request_timeout` e devolvem os slots; sem o prazo de silêncio, sockets que nada enviam se reconectavam e sustentavam a negação. **Hashes simultâneos** (4, fila de 64): é CPU nossa sobre bytes já em memória, então o excesso **espera** em vez de jogar a leitura fora, e o slot é tomado só em volta do hash, nunca em volta de I/O; fila cheia responde `503 hash_queue_busy` + `Retry-After` (estado que passa, não veredito sobre a requisição). A propriedade que isto garante: um endereço, ou um punhado deles, não pode impedir que uma entrega assinada do GitHub seja atendida |
| Residual aceito | Um *slowloris distribuído* — centenas de endereços, cada um dentro do seu orçamento, cada um gotejando um byte só para vencer o prazo de silêncio — ainda pode encher o teto global de leituras. Nenhuma contabilidade por endereço distingue isso de tráfego honesto, e este endpoint não pode exigir prova do chamador antes do corpo chegar. É **mitigado, não impedido**: as entregas recusadas no intervalo são recuperadas pela **reconciliação**, que re-lista instalações e PRs abertas e cria os eventos que as entregas perdidas criariam. É ela, e não o teto de leituras, que torna um webhook perdido sobrevivível |
| Ordem das checagens | `resolve` → `Content-Length` → cabeçalhos presentes → **forma** de `X-Hub-Signature-256` (`sha256=` + 64 hex, por regex) → teto global de entregas aceitas → recusa por endereço sem App conhecida → orçamento de leitura **por endereço** (espera curta) → orçamento global de leitura (recusa) → leitura com teto e dois prazos → orçamento de hash (fila capada) → verificação. Nada caro acontece antes de tudo o que é barato |
| Resposta | Sempre JSON ≤ 200 bytes, nunca ecoa o payload nem o motivo interno de falha de assinatura (`401 signature_invalid` e nada mais) |
| Trabalho | A requisição grava entrega + eventos em uma transação `IMMEDIATE` e devolve. O despacho corre fora do ciclo da requisição |
| Cabeçalhos ausentes | `X-GitHub-Event`, `X-GitHub-Delivery` ou assinatura ausentes → `400 malformed_delivery`, sem registro |

### Eventos assinados pela App

`GITHUB_APP_MANIFEST_EVENTS` deixa de ser uma lista vazia:

```
pull_request, push, installation, installation_repositories, check_run, workflow_run
```

O manifest ganha `hook_attributes: { url: "<origin>/api/github/webhook", active:
true }`. `GITHUB_APP_MANIFEST_PERMISSIONS` troca `pull_requests: "read"` por
`pull_requests: "write"`.

### Mapa evento → ação → gate

| Evento | `action` | Efeito |
|---|---|---|
| `pull_request` | `opened`, `reopened`, `synchronize`, `ready_for_review` | Um evento `pull_request` por ação habilitada cujo padrão casa `base.ref`. Head de fork sem `include_forks` → `ignored` / `fork_pull_request`; rascunho (fora de `ready_for_review`) → `ignored` / `draft_pull_request`; mudança já superada → `ignored` / `stale_delivery` |
| `pull_request` | `closed` | Eventos `queued` do PR viram `superseded` com `reason='pull_request_closed'`. Nada é escaneado |
| `pull_request` | outros (`labeled`, `edited`, …) | `ignored` / `action_not_handled` |
| `push` | — | Um evento `push` por ação cujo padrão casa o nome curto de `ref`. `after` só de zeros (branch apagada) → `ignored` / `branch_deleted`. `ref` fora de `refs/heads/` → `ignored` / `ref_not_branch` |
| `installation_repositories` | `added` | Atualiza o cache `github_installation_repositories` |
| `installation_repositories` | `removed` | Mesmo cache, e desabilita ações dos repositórios removidos com `last_error='repository_unauthorized'` |
| `installation` | `deleted`, `suspend` | Desabilita as ações de todos os repositórios da instalação |
| `check_run` | `rerequested` | Novo gate para o `external_id` do check, `origin='manual'`, escopado por conexão e repositório e só quando `check_run.app.id` é o App da conexão (senão `ignored` / `check_run_not_ours`). Exceção explícita ao "mesmo commit nunca duas vezes" |
| `workflow_run` | `completed` | Fase 4: importa o artefato do caller pelo `workflow_run_id` registrado em `github_actions_dispatches` |
| `ping` | — | `processed`, nada mais |
| qualquer outro | — | `ignored` / `event_not_handled` |

Resolução do repositório: `payload.repository.id` →
`guardrail_repositories.github_repository_id`, exigindo que
`github_connection_id` seja a conexão que validou a assinatura. Sem linha →
`ignored` / `repository_not_enrolled`. Repositório com `enabled = 0` →
`ignored` / `repository_disabled`.

O despacho reusa o dispatcher atual (`automaticGitHubScanDispatcher`, renomeado
`dispatchGitHubActionEvent`) com as mesmas garantias: tripla de autoridade
revalidada, reserva de orçamento no dia UTC, aborto em `head_superseded`,
recheque de `revision`, refusa pré-despacho como `skipped` e ambiguidade
pós-despacho como `failed` sem repetição cega.

## Reconciliação

- Intervalo de 15 min, configurável por `CSB_GITHUB_RECONCILE_INTERVAL_MS`
  (limite 5–60 min). Substitui `startPolling(60_000)` em `index.ts`.
- Somente leitura, por repositório com ao menos uma ação habilitada: PRs abertos
  (`GET /repos/{o}/{r}/pulls?state=open&per_page=100`, no máximo 3 páginas) e
  cabeças das branches (`GET /repos/{o}/{r}/branches?per_page=100`, no máximo 2
  páginas).
- Cria evento apenas quando **ambas** as condições valem: o `target_identity`
  não existe naquela `action_revision`, e nenhum evento da ação já carrega aquele
  `head_sha`. Sem commit novo, zero eventos e zero custo — é a garantia de que a
  reconciliação nunca gasta por existir.
- Se a ação ainda tem `baseline_initialized_at IS NULL`, a primeira
  reconciliação grava tudo como `observed` com `reason='initial_baseline'` e
  preenche a coluna. Nenhum scan retroativo, na criação nem depois de uma edição.
- Reconcilia também os despachos órfãos (`reconcileOrphanedGitHubMonitorDispatches`,
  renomeado) e, na Fase 4, os `workflow_run` cujo webhook não chegou.
- **Re-lista as instalações** (`GET /app/installations` e seus repositórios) a cada
  ciclo, e desabilita as ações de repositório que a instalação não alcança mais.
  Uma entrega `installation` ou `installation_repositories` recusada não volta
  sozinha — o GitHub não reentrega — e sem isso as ações de um repositório fora da
  instalação ficariam habilitadas indefinidamente. Um `check_run.rerequested`
  perdido não é reconciliado: quem clicou clica de novo.
- Grava `last_reconciled_at` e `last_error` na ação. A tela de Integração mostra
  a última reconciliação e quantos eventos de `origin='reconciliation'` ela
  recuperou nas últimas 24 h — o número que diz se os webhooks estão chegando.
- Um evento só é retirado da fila por idade pelo **nosso** relógio
  (`detected_at`, 24 h), nunca pelo relógio do payload: depois de uma
  indisponibilidade de dois dias, o commit que a reconciliação acaba de descobrir
  tem `updated_at` de dois dias e é exatamente o que ela existe para recuperar.
  O que a idade retira é fila antiga *nossa* — a que o poller deixou no corte, com
  o `detected_at` dele.
- **Uma réplica.** A garantia de não-sobreposição do ciclo é um sinalizador em
  processo, e a varredura de despachos órfãos encerra **todo** `dispatching` que
  não seja deste processo. Duas réplicas sobre o mesmo volume marcariam o despacho
  pago da outra como incerto e dobrariam as leituras da App. A API roda como
  réplica única (`docs/dokploy.md`); se isso mudar, o instrumento é uma tabela de
  *lease* de despacho, não um sinalizador maior.

## Deduplicação e supersedência

| Situação | Resultado |
|---|---|
| GitHub reentrega a mesma entrega | `200 duplicate`; nada acontece |
| Dois eventos para o mesmo `target_identity` na mesma revisão | O segundo é descartado pela `UNIQUE` |
| Novo commit no PR com evento `queued` não despachado | O antigo vira `superseded` / `head_superseded`; só o novo é despachado. A ordem é pelo relógio do payload, e o cancelamento acontece **depois** de o evento novo estar gravado: uma entrega atrasada nunca cancela o head atual |
| Entrega fora de ordem, ou reenviada pelo *Redeliver* com mudança já superada | `ignored` / `stale_delivery`. Nada é criado e nada é cancelado |
| Novo commit no PR com gate já `launched` | O gate anterior segue até o fim (o custo já foi gasto); o novo entra na fila; o comentário sticky passa a refletir o commit novo |
| PR fechada com evento `queued` | `superseded` / `pull_request_closed` |
| `head_sha` mudou entre fila e despacho | `skipped` / `head_superseded` |
| Mesmo `head_sha` já analisado pela mesma ação (`launched` ou terminal) | `skipped` / `commit_already_analysed` |
| Webhook e reconciliação vendo o mesmo commit | O segundo cai na `UNIQUE`; nenhuma corrida, porque ambos escrevem na mesma transação `IMMEDIATE` |
| `check_run.rerequested` | Novo evento `origin='manual'`, `target_identity` sufixado `#rerun:<checkRunId>`, isento da regra do commit repetido |
| Teto diário estourado | Evento fica `queued` com `reason='daily_cost_ceiling'`, como hoje; a próxima janela UTC o despacha. O teto é do repositório: a soma das reservas de **todas** as ações dele no dia |
| Despacho recusado pelo servidor (`server_draining`) | Evento volta a `queued` com `reason='server_draining'` e sem reserva. Encerrá-lo perderia o commit para sempre: a entrega não recria o evento (`UNIQUE`) e a reconciliação não o recria (o SHA já está na ficha da ação) |

## Ciclo de vida da baseline

| Momento | Efeito |
|---|---|
| Repositório cadastrado | `state='absent'`. Nada é gasto |
| Primeiro merge/push na branch protegida após o cadastro | A ação `push` cujo padrão casa a branch protegida dispara um gate `protected_branch`. Ao concluir com `outcome != error`, `state='ready'` |
| Merges seguintes | Novo gate `protected_branch` substitui a baseline; a mais recente comparável vence |
| "Criar baseline agora" | `POST /guardrails/repositories/:key/baseline` (administrador). `state='building'`, `requested_at` gravado, gate `protected_branch` imediato |
| Troca de modelo, esforço ou modo (na política ou numa ação) | `state='stale'`, `stale_reason='scan_lineage'`. O próximo gate de branch protegida reconstrói |
| Troca da branch protegida na política | `state='stale'`, `stale_reason='protected_branch'` |
| Repositório sem ação `push` na branch protegida | A tela diz isso e oferece criar a ação ou usar o botão |

### Avaliação sem baseline

O retorno antecipado `baseline_absent:initialize_protected_branch` em
`sentinel-managed-executor.ts` é removido. Um PR sem baseline comparável produz
um artefato v2 normal:

- Todos os findings classificados `new` (`classifyGateFindings` com
  `baseline.kind === 'absent'`, comportamento que já existe).
- `decision.outcome = 'bootstrap'`, `githubConclusion = 'neutral'`. Nunca
  `blocked`: sem baseline não existe prova do que é novo.
- Campo novo no artefato: `baselineNotice: { kind: 'absent' | 'incompatible';
  reason: string | null }`, renderizado como "sem baseline" na tela, no Check e
  no comentário, e como `null` quando há baseline comparável.
- `baseline.kind === 'incompatible'` (qualquer motivo, inclusive `scan_lineage`
  e `coverage`) segue o mesmo caminho, com o motivo em `baselineNotice.reason`.
- `baseline.kind === 'unavailable'` e `coverage.status !== 'complete'` continuam
  artefatos de erro operacional.

## Precedência de política

| Ordem | Fonte | `policySource` | Quando vale |
|---|---|---|---|
| 1 | `.csb/guardrails.json` no SHA da branch protegida | `repository_file` | Existe e é válido. A tela fica somente leitura e diz "controlado pelo repositório" |
| 2 | `guardrail_repository_policies` | `sentinel` | Não há arquivo no repositório, ou o arquivo é inválido |
| 3 | `defaultGuardrailPolicy()` | `default` | Nenhuma das anteriores |

- Arquivo presente e inválido: o gate registra `policy_invalid` no artefato, usa
  o nível 2 e avisa na tela e no comentário. Nunca cai em silêncio.
- `PUT /guardrails/repositories/:key/policy` deixa de responder
  `409 remote_policy_read_only` para repositórios GitHub; passa a gravar em
  `guardrail_repository_policies`. Responde `409 policy_controlled_by_repository`
  quando o nível 1 está ativo, e o corpo do `GET` diz qual nível manda.
- Presets (`preset` na tabela): `block-critical-high` (padrão — `block` para
  `critical` e `high` em `new`/`reopened`, `review` para o resto),
  `block-critical`, `warn-only` (`review` em tudo) e `custom` quando as regras
  divergem de qualquer preset.
- `POST .../policy/simulate` permanece em memória e passa a simular a política a
  ser salva contra o último gate do repositório.
- Salvar a política chama `refreshRepositoryBaselineState`.

## Comentário no PR

### Estrutura

1. Marcador HTML invisível: `<!-- okami-sentinel:gate repository=<key> -->`.
2. Banner do console Okami Sentinel, imagem servida pela origem do Sentinel.
3. Cabeçalho com o veredicto: `BLOCKED` · `WARNING` · `APPROVED` · `REVIEW`
   (`bootstrap`) · `NO CHANGES` · `ERROR`.
4. Tabela de resumo: novos findings por severidade; corrigidos pelo PR; baseline
   presente ou não; custo e duração.
5. Tabela dos findings **novos**: severidade, título, `arquivo:linha`, link para
   o finding no Sentinel.
6. Rodapé: commit analisado, engine/modelo, link para o gate completo, aviso de
   ausência de baseline quando aplicável, e a nota de que o check é informativo.

### Esboço

```markdown
<!-- okami-sentinel:gate repository=github:1185738028 -->
![Okami Sentinel](https://sentinel.okamilab.com/brand/pr-comment-banner.png)

## Okami Sentinel — BLOCKED

|  |  |
|---|---|
| **New findings** | 2 critical · 1 high · 0 medium · 0 low |
| **Fixed by this PR** | 3 |
| **Baseline** | `main` @ `a1b2c3d` · 2026-09-28 |
| **Cost / duration** | $0.42 · 3m 18s |

### New findings

| Severity | Finding | Location |  |
|---|---|---|---|
| critical | Command injection in the deploy hook | `scripts/deploy.ts:88` | [open](https://sentinel.okamilab.com/guardrails/aB3xY9?finding=f1) |
| critical | Unauthenticated admin route | `apps/api/src/app.ts:412` | [open](https://sentinel.okamilab.com/guardrails/aB3xY9?finding=f2) |
| high | Session token written to the log | `apps/api/src/auth/session-store.ts:140` | [open](https://sentinel.okamilab.com/guardrails/aB3xY9?finding=f3) |

_+12 mais no Sentinel_

---
Commit `a1b2c3d4` · `codex-security` / `gpt-5.6` · [full gate](https://sentinel.okamilab.com/guardrails/aB3xY9)
This check is informational — the merge is not blocked. Make it required in the repository's branch protection.
```

Variante sem baseline: a linha de baseline vira `| **Baseline** | none yet —
findings are reported without comparison |`, o veredicto é `REVIEW`, e a linha
de corrigidos desaparece.

### Atualização no lugar

- Identidade: a linha de `github_pr_comments` guarda `comment_id`; o caminho
  normal é um único `PATCH /repos/{o}/{r}/issues/comments/{id}`.
- Sem linha, ou `PATCH` respondendo 404: varre os comentários do PR
  (`GET /repos/{o}/{r}/issues/{n}/comments?per_page=100`, até 3 páginas)
  procurando o marcador em um comentário do bot da App; achou, `PATCH`; não
  achou, `POST`. A linha é regravada com o id resultante.
- Dois comentários com o marcador: usa o mais antigo e registra
  `reason='ambiguous_comment'`; não apaga nada.
- `body_hash` igual ao anterior: nenhuma chamada.
- Falha: `status='failed'`, `error` com o código, alerta
  `ops.github_publish_failed` com o gate como alvo. `POST /guardrails/gates/:gateId/comment`
  republica (operator).
- Só há comentário para alvo `pull_request`. Gate de branch protegida ou
  comparação de refs publica apenas o Check.
- Idioma: inglês, sempre.

### Redação e limites

- Todo texto vindo do scan (título, resumo, caminho) passa por
  `redactPublicText` do gate-core. Caminho que não satisfaz
  `isRepositoryRelativePath` é substituído por `path withheld`.
- Orçamento de 60.000 caracteres (limite do GitHub: 65.536). O corpo é montado
  e, enquanto exceder, remove a última linha da tabela de findings (ordem:
  severidade decrescente, depois título) e recalcula. O rodapé ganha
  `_+N mais no Sentinel_` com o N real.
- No máximo 50 linhas na tabela, mesmo quando cabe.
- Se cabeçalho + resumo + rodapé sozinhos excederem o orçamento — impossível na
  prática, garantido por teste — o corpo degrada para banner, veredicto e link.
- Banner: `apps/web/public/brand/pr-comment-banner.png`, servido sem sessão pela
  origem pública. Sem `CSB_PUBLIC_ORIGIN`, o banner e os links são omitidos e o
  comentário sai em texto puro.

## Check Run pela App

- O caminho automático já usa a App (`publishManagedGateCheck`) e permanece.
- `POST /guardrails/gates/:gateId/publish` passa a usar
  `publishManagedGateCheck` com a autoridade gravada no gate.
  `publishGateCheck` (via `gh` CLI) é removido. `github-cli.ts` continua
  servindo o estado Git de repositórios locais.
- `detailsUrl` deixa de ser `null`: `${CSB_PUBLIC_ORIGIN}/guardrails/${gateId}`.
- Elegibilidade: `publication.eligible` passa a ser verdadeira para qualquer
  alvo `pull_request` de repositório `source: github` com `checks: write`
  concedido, além do caso atual de branch protegida.
  `publication.protectedBranch` continua o que é, e só a comparabilidade da
  baseline depende dele.
- Até 20 anotações, como hoje. A nota "informativo, não bloqueia" entra no
  `output.summary`.
- Permissão ausente: o gate conclui, `publishStatus='failed'`,
  `publishError='github_permission_missing'`, e a tela de Integração aponta qual
  permissão falta e como revisá-la na instalação.

## Executor GitHub Actions

- Escolhido **por ação** (`github_actions.executor`), não mais por repositório.
  Os dois cartões de executor sempre renderizam; `sentinel-managed` e
  `github-actions` exigem administrador para criar ou habilitar.
- `default_executor` do repositório passa a ser editável por
  `PATCH /guardrails/repositories/:key` e serve apenas de padrão do formulário.
- A tela mostra, para uma ação Actions: o workflow caller para copiar
  (`GET .../caller-workflow`, já existe), o botão **Abrir PR com o workflow**
  (`POST /guardrails/repositories/:key/caller-workflow/pull-request` — cria a
  branch `okami-sentinel/caller-workflow`, comita
  `.github/workflows/csb-security-change-gate.yml` fixado em
  `CSB_GITHUB_ACTIONS_WORKFLOW_SHA` e abre o PR, com `contents: write` +
  `pull_requests: write`), e os pré-requisitos: segredo `OPENAI_API_KEY` no
  repositório e o caller sem gatilhos automáticos de `push`/`pull_request`/merge.
- Agendamento: `workflow_dispatch` pela App, como hoje. O Sentinel continua
  recusando com `monitor_actions_duplicate_triggers` quando o caller mantém os
  gatilhos nativos.
- Retorno: `workflow_run.completed` do caller vira o gatilho primário de
  importação do artefato (`actions-artifact-importer`), pelo `workflow_run_id`
  registrado em `github_actions_dispatches`. O reconciliador de 15 s permanece
  como rede de segurança.
- Artefato importado que veio de uma execução não despachada pelo Sentinel
  continua sendo atividade observada, nunca evidência aprovada.

## Permissões e regra de custo

| Operação | Papel mínimo |
|---|---|
| Criar ação (qualquer executor) | administrador |
| Habilitar ação | administrador |
| Trocar executor, conexão, modelo, esforço, modo ou teto | administrador |
| Habilitar `include_forks` numa ação | administrador |
| Renomear ação, ajustar padrões de branch ou trocar o tipo de gatilho de ação **desabilitada** | mantenedor |
| Desabilitar ação | mantenedor |
| Remover ação | mantenedor |
| Criar baseline agora | administrador |
| Cadastrar ou remover repositórios | administrador |
| Salvar política | mantenedor |
| Simular política | analista |
| Publicar check / republicar comentário | operador |
| Ver ações e eventos (atividade) de um repositório | viewer |
| Ver entregas do webhook (diagnóstico da integração) | administrador |

Os dois executores gastam: `sentinel-managed` consome uma conexão de provedor do
Sentinel, `github-actions` consome minutos e a chave do cliente. Por isso a
regra de custo se aplica igual aos dois. `RepositorySource` da política de rotas
ganha o valor `"action"` (resolve o repositório pela linha de `github_actions`),
substituindo `"monitorRule"`.

## API

| Método e rota | Acesso | Função |
|---|---|---|
| `POST /github/webhook` | público (HMAC) | Ingestão de entregas |
| `GET /github/integration` | admin | Estado da App: permissões concedidas × exigidas, eventos assinados × exigidos, instalações e escopo, URL do webhook, segredo configurado, última entrega, checklist |
| `PUT /github/integration/webhook-secret` | admin | Grava ou substitui o segredo de uma conexão. Nunca devolve o valor |
| `GET /github/deliveries` | admin | Últimas 200 entregas com resultado e motivo |
| `POST /github/reconcile` | admin | Reconciliação imediata (leitura) |
| `GET /github/actions` | scoped | Ações visíveis ao chamador, com filtro opcional `repositoryKey` |
| `POST /github/actions` | admin | Criar ação |
| `PATCH /github/actions/:actionId` | maintainer (`action`) | Alterar; campos que gastam exigem admin |
| `DELETE /github/actions/:actionId` | maintainer (`action`) | Remover |
| `GET /github/actions/:actionId/events` | viewer (`action`) | Eventos da ação |
| `GET /github/events` | scoped | Atividade consolidada |
| `GET /github/branches` | scoped | Branches vivas do repositório (era `/github-monitor/branches`) |
| `GET /guardrails/repositories` | scoped | Lista com baseline, última análise, ações ativas, último veredicto |
| `POST /guardrails/repositories` | admin | Cadastro em lote (1..50) |
| `PATCH /guardrails/repositories/:repositoryKey` | admin | `enabled`, `defaultExecutor`, `prCommentEnabled` |
| `DELETE /guardrails/repositories/:repositoryKey` | admin | Remove com cascata |
| `GET /guardrails/repositories/:repositoryKey/policy` | viewer (`param`) | Política efetiva, nível vigente e se é somente leitura |
| `PUT /guardrails/repositories/:repositoryKey/policy` | maintainer (`param`) | Grava a política do Sentinel |
| `POST /guardrails/repositories/:repositoryKey/policy/simulate` | analyst (`param`) | Simulação em memória |
| `GET /guardrails/repositories/:repositoryKey/baseline` | viewer (`param`) | Estado, gate, commit, motivo de desatualização |
| `POST /guardrails/repositories/:repositoryKey/baseline` | admin | "Criar baseline agora" |
| `GET /guardrails/repositories/:repositoryKey/caller-workflow` | viewer (`param`) | Workflow caller e estado |
| `PUT /guardrails/repositories/:repositoryKey/caller-workflow` | maintainer (`param`) | Instalação direta (existente) |
| `POST /guardrails/repositories/:repositoryKey/caller-workflow/pull-request` | admin | Abre PR com o workflow |
| `POST /guardrails/gates/:gateId/publish` | operator (`gate`) | Republica o Check pela App |
| `POST /guardrails/gates/:gateId/comment` | operator (`gate`) | Republica o comentário do PR |

Removidas: `GET/POST/PATCH /github-monitor/*`, `POST /github-monitor/poll`,
`POST /guardrails/repositories/:key/baseline/sync`, `GET /github-checkouts`,
`GET /github-checkouts/:key`, `POST /github-checkouts/:key/fetch`,
`POST /github-checkouts/:key/pull`.

Todas as rotas entram na `ROUTE_POLICY` com teste de cobertura. A rota do webhook
é a única `PUBLIC` que muda estado, e o teste de cobertura verifica
explicitamente que ela é isenta de CSRF e que nenhuma outra rota nova é pública.

## Telas

### Aba GitHub (`/github`)

**01 Integração** (somente administrador; os demais papéis veem apenas Ações, em leitura, e Atividade dos repositórios que enxergam)

- Identidade da App: nome, slug, instalações, link para as configurações.
- Tabela de permissões: exigida × concedida, com o que falta em destaque e o
  link de revisão da instalação.
- Tabela de eventos assinados: exigido × assinado, com o que falta.
- Escopo da instalação: quantos repositórios a App alcança, quantos estão
  cadastrados, e **Ampliar seleção de repositórios** apontando para
  `https://github.com/settings/installations/<id>` (ou a URL da organização) —
  a causa literal de "a aba está presa em um repositório".
- Webhook: URL copiável, `Segredo: configurado`/`ausente` com campo para colar e
  botão de substituir, última entrega, contagem de `processado`/`ignorado`/
  `falhou` nas últimas 24 h, e as 50 entregas mais recentes com motivo.
- Checklist de prontidão: App instalada → permissões → eventos → segredo →
  **entrega verificada** → repositório cadastrado → ação habilitada → baseline.
  "Segredo configurado" não quer dizer "segredo certo": só uma entrega cuja
  assinatura validou prova isso, e uma linha de entrega só existe depois de a
  assinatura validar. Um segredo colado com espaço, um segredo trocado só no
  GitHub, ou um `appId` gravado errado deixam o passo vermelho em vez de a tela
  ficar verde sobre nada.
- **A entrega verificada expira em 7 dias.** A última entrega válida é uma marca
  d'água: sem janela, o passo fica verde para sempre e sobrevive justamente às
  falhas que ele existe para pegar — App suspensa, segredo trocado só no GitHub,
  hook desligado. Passados 7 dias sem uma entrega cuja assinatura validou, o passo
  volta a vermelho e a tela diz **"sem evento recente"**, que é diferente de "nunca
  verificado". Sete dias passa de qualquer fim de semana quieto num repositório que
  recebe PRs e fica bem longe de "ninguém notou por um mês".
- **Instalação suspensa não é instalação.** `suspended_at` numa instalação faz o
  GitHub recusar todo token dela, então ela não conta para "App instalada", não
  concede permissão nenhuma e não cadastra repositório — mas continua listada, com
  o link que a retoma. A tela mostra o estado da lista de instalações em uma
  palavra: `desconhecido` (a leitura de `GET /app/installations` falhou — nada se
  sabe, e todo passo que dependa dela fica vermelho), `nenhuma` (a App existe e
  não está instalada em lugar nenhum), `suspensa` (todas as instalações estão
  suspensas) ou `ativa`. Nos três primeiros nenhuma permissão é reportada como
  concedida: `concedida` só pode vir de uma instalação viva, nunca do que a App
  *pede*.

**02 Ações por repositório**

- Seletor real de repositório sobre **todos** os cadastrados, mais a opção
  "Todos os repositórios".
- Tabela de ações: repositório, nome, evento, padrões de branch, executor,
  perfil de scan (modelo/esforço/modo), teto por scan e por dia, estado. CRUD em
  painel lateral.
- Ação com executor GitHub Actions mostra o workflow para copiar, o botão de
  abrir PR e os pré-requisitos.
- Repositório local selecionado: mensagem dizendo que a automação exige
  autoridade remota da App, com o caminho para cadastrá-lo pela App.

**03 Atividade**

- Recebido em, entrega, repositório, evento, ação casada, gate criado (link),
  ignorado com motivo. Filtro por repositório e por resultado.

### Aba Guardrails

- `/guardrails` — repositórios: nome, baseline (`pronta`/`ausente`/
  `desatualizada`/`em construção`), última análise, ações habilitadas, último
  veredicto. **Adicionar repositórios**: multi-seleção sobre a instalação, um
  envio para N repositórios, com o resultado parcial visível. Desabilitar e
  remover por linha, com confirmação nomeando o que a remoção apaga. A lista de
  gates permanece abaixo.
- `/guardrails/repositories/:repositoryKey` — página nova do repositório:
  política editável com presets e a simulação existente; aviso e somente leitura
  quando `.csb/guardrails.json` manda; estado da baseline com "Criar baseline
  agora"; configuração do comentário no PR; histórico de gates; atalho para as
  ações do repositório na aba GitHub.
- `/guardrails/repositories/:repositoryKey/policy` redireciona para a página
  acima, para o link existente em `EvidenceTrace` continuar funcionando.
- `/guardrails/:gateId` — página do gate como hoje, mais link para o PR e para o
  comentário publicado, e o aviso "sem baseline" quando aplicável.
- Cinco idiomas. Catálogo novo `apps/web/src/i18n/github-actions.ts` para a aba
  GitHub; a aba Guardrails ganha chaves no catálogo existente. Mesmo padrão
  visual das telas de Configurações e Guardrails atuais.
- N+1 removido: `GET /guardrails/repositories` devolve tudo que a lista mostra,
  e nenhuma chamada remota por repositório acontece no carregamento.

## Itens removidos

| Item | Onde estava |
|---|---|
| Cartões "fontes acompanhadas" com ✓ fixo | `GitHubMonitorPage.tsx:344-349`, `:461-463` |
| Painel de checkout local (fetch/pull) e todo o caminho `checkout_mode` | `GitHubMonitorPage.tsx:408-418`, `:469-497`, `lib/github-monitor-state.ts:48`, `github-checkouts.ts` |
| "Sync baseline" como caminho paralelo e `GitHubBaselineProvider` | `app.ts:388-396`, `:601-613`, `guardrails/github-baseline.ts` |
| Cadastro duplicado de repositório na aba GitHub | `GitHubMonitorPage.tsx:322` |
| Limite de uma regra por repositório | `github-monitor/service.ts:187-189`, `store.ts:109` |
| `publishGateCheck` (via `gh` CLI) | `github-check.ts:80-111` |
| Polling de 60 s | `github-monitor/service.ts:226-234`, `index.ts:169` |
| Radiogroup de executor com uma opção | `GitHubMonitorPage.tsx:360-363`, `RepositoryEnrollmentForm.tsx:317-321` |
| `default_executor` *write-once* | `guardrails-enrollment.ts:29`, `:44`, `:53` |
| Tabelas `github_monitor_*` | Renomeadas na Fase 1, removidas na Fase 5 |

## Setup do operador

Documentado em `docs/dokploy.md`.

**App nova (fluxo manifest).** Nada a fazer: o manifest já pede as permissões e
os eventos certos, declara `hook_attributes` com a URL do webhook, e o segredo
gerado pelo GitHub (`webhook_secret` da resposta de conversão, hoje descartado)
é gravado no vault junto da chave privada.

**App existente.** Três ajustes no GitHub, listados pela própria tela de
Integração com o que falta:

1. **Permissions**: `checks: write`, `contents: write`, `pull_requests: write`,
   `actions: write`, `workflows: write`, `metadata: read`. Aprovar a revisão em
   cada instalação.
2. **Subscribe to events**: `pull_request`, `push`, `installation`,
   `installation_repositories`, `check_run`, `workflow_run`.
3. **Webhook**: URL `https://sentinel.okamilab.com/api/github/webhook`, ativo,
   *content type* `application/json`, e um **Secret**. Gerar o segredo no GitHub,
   colar no Sentinel (Integração → Webhook). O Sentinel nunca o mostra de novo.

**Sem variável de ambiente nova.** `CSB_GITHUB_WEBHOOK_SECRET` é deliberadamente
não introduzida: o segredo segue a mesma custódia da chave privada, cifrado por
`CSB_VAULT_KEY_FILE`. Opcional: `CSB_GITHUB_RECONCILE_INTERVAL_MS`.

**Proxy reverso.** Não remover nem reescrever `X-Hub-Signature-256`,
`X-GitHub-Event` e `X-GitHub-Delivery`; permitir corpo de 1 MiB; não *bufferizar*
de forma a alterar bytes. Dokploy/Traefik atendem por padrão.

**Escopo da instalação.** Se a App foi instalada em "only selected
repositories", ampliar a seleção em
`https://github.com/settings/installations/<id>`. Sem isso, o multi-select de
cadastro continua curto.

## Testes

**Unidade**

- HMAC: assinatura válida, inválida, ausente, tamanho diferente, prefixo
  `sha256=` ausente, corpo alterado em um byte.
- Escolha de conexão entre várias com segredos diferentes; nenhuma com segredo;
  escolha por `X-GitHub-Hook-Installation-Target-ID` (um hash), App id
  desconhecido (nenhum hash), cabeçalho ausente (laço capado).
- Admissão: endereço acima do limite recusado **sem ler o corpo** quando não nomeia
  uma App conhecida, e atendido quando nomeia; dezesseis corpos que nunca terminam
  de um endereço não impedem a entrega assinada de **outro** (com o teto global
  abaixo da enxurrada, para que a prova seja o orçamento por endereço); quatro
  corpos parados do **mesmo** endereço do GitHub apenas atrasam a entrega dele, que
  recebe o slot liberado; corpo que não envia byte algum termina em `408` muito
  antes do prazo total; teto global de leituras recusando, fila de hashes
  enfileirando e respondendo `503` quando cheia; cabeçalho de assinatura malformado
  recusado antes do corpo.
- Idempotência por `delivery_id`, inclusive duas entregas concorrentes.
- Limite de 1 MiB e ausência de registro quando a assinatura não valida.
- Casamento de padrões de branch (`main`, `release/**`, `feature/*`) para PR
  (`base.ref`) e push (`refs/heads/...`), com branch apagada e `ref` não-branch.
- Supersedência: novo commit em PR com evento `queued`; PR fechada; commit
  repetido; `check_run.rerequested`; entrega fora de ordem e *Redeliver* de uma
  antiga, que não podem cancelar o head atual.
- Fork: PR de fork ignorada por padrão; com `include_forks`, evento com
  `head_ref = pull/<n>/head`. Draft ignorado até `ready_for_review`.
- Reconciliação: sem commit novo não cria evento; primeira rodada marca
  `observed`; ação editada não dispara a fila de PRs abertos.
- Baseline: transições `absent → building → ready → stale` e a reconstrução no
  merge seguinte; `refreshRepositoryBaselineState` idempotente.
- Avaliação sem baseline: `bootstrap`, todos os findings `new`, nunca `blocked`,
  `baselineNotice` preenchido; `incompatible` cai no mesmo caminho;
  `unavailable` e cobertura incompleta continuam erro operacional.
- Precedência de política nos três níveis, e arquivo inválido caindo no nível 2
  com `policy_invalid`.
- Comentário: corpo em cada veredicto; variante sem baseline; redação de segredo
  e de caminho de host; caminho não relativo virando `path withheld`;
  truncamento a 60.000 caracteres com `+N mais no Sentinel` e N correto;
  degradação extrema; `body_hash` igual evitando a chamada; dois comentários com
  o marcador; 404 no `PATCH` levando à varredura.
- Migração: regra virando duas ações; regra sem teto entrando desabilitada;
  eventos preservados com o gate; migração rodada duas vezes sem efeito.

**Rotas**

- Cobertura da `ROUTE_POLICY`: toda rota nova declarada; o webhook é a única
  pública que muda estado; nenhuma outra rota nova é pública.
- Regra de custo: mantenedor criando ação → 403; mantenedor desabilitando → 200;
  mantenedor habilitando → 403; mantenedor renomeando ação habilitada → 403.
- Segredo do webhook nunca devolvido por `GET /github/integration`.
- Repositório inexistente e repositório não compartilhado respondem o mesmo
  código, para o erro não servir de enumeração.
- Cadastro em lote com resultado parcial; `DELETE` levando gates e grants.

**Integração**

- Servidor Hono recebendo uma entrega assinada de ponta a ponta: entrega
  registrada, evento criado, despacho chamado com a autoridade certa.
- `serverSecurity` deixando o webhook passar sem sessão, sem `Origin` e sem CSRF,
  e negando um `POST /github/webhook` com `Origin` de outro site.
- Publicação do Check e do comentário contra um cliente de App simulado, criando
  e depois editando.

**e2e (Playwright)**

- Integração: permissões e eventos faltando, colar segredo, ver entregas.
- Criar duas ações no mesmo repositório com eventos diferentes; desabilitar uma.
- Cadastrar três repositórios de uma vez; remover um.
- Editar a política com preset, simular, salvar; ver o aviso de
  `.csb/guardrails.json`.
- "Criar baseline agora" e a mudança do estado na lista.
- Gate sem baseline mostrando o aviso, e a página do gate com os links de PR e
  comentário.

**Verificação**

`cd apps/api && npm test`; `cd apps/web && pnpm test && pnpm build`;
`cd apps/web && pnpm test:e2e`; `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm
typecheck`; `pnpm check:repository`.

## Fases

Cada fase é um PR integrado à `main`, com a suíte verde e implantável ao fim.

| Fase | Entrega | Estado ao fim |
|---|---|---|
| 1 | Ingestão de webhook assinada e idempotente; reconciliação de 15 min; tela de Integração; ações por repositório com executor Sentinel; migração das regras | Polling removido; PR e push disparam gate por webhook; o operador vê entregas e o que falta na App |
| 2 | Cadastro em lote; política editável na interface com presets e precedência; baseline automática no merge, botão "Criar baseline agora", avaliação sem baseline | Primeiro PR de um repositório novo devolve veredicto útil em vez de erro |
| 3 | Comentário sticky no PR; "Publicar check" pela App; `detailsUrl`; elegibilidade de publicação ampliada | O autor do PR lê o resultado dentro do PR |
| 4 | Executor GitHub Actions por ação; botão de abrir PR com o workflow; `workflow_run` → importação do artefato | O executor Actions passa a ser alcançável e retorna por evento |
| 5 | Remoção dos itens mortos: cartões decorativos, painel de checkout e suas rotas, `baseline/sync`, `publishGateCheck`, tabelas `github_monitor_*_migrated` | Nenhum controle decorativo e nenhum caminho paralelo no produto |
