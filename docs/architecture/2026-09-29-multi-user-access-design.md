# Multiusuário, papéis por repositório e login

**Status:** aprovado para planejamento

**Data:** 2026-09-29

**Produto:** Okami Sentinel

**Direção:** contas próprias por pessoa, papéis por repositório, login com senha,
GitHub e 2FA, e gestão de acesso dentro do produto

## Problema

No modo servidor o Sentinel aceita uma única credencial HTTP Basic definida no
Docker (`CSB_ADMIN_USER` e `CSB_ADMIN_PASSWORD_FILE`). Não há tela de login,
logout, sessão por pessoa, nem forma de liberar acesso a outra pessoa sem
compartilhar a senha do administrador. Toda requisição autenticada pode tudo:
ver qualquer repositório, gastar com qualquer conexão de provedor, apagar scans
e alterar políticas.

O token CSRF também é único por processo (`security-session.ts`), então não
distingue quem fez a ação.

## Objetivo

- Cada pessoa entra com a própria conta e só vê e faz o que o papel permite.
- O administrador convida, ajusta papéis e revoga acesso pela interface, sem
  mexer no Docker.
- A revogação vale na próxima requisição, inclusive em streams abertos.
- Nenhum administrador fica trancado para fora.

Critério de sucesso da primeira entrega: um colega entra com usuário próprio,
vê e tria apenas os repositórios concedidos, e perde o acesso imediatamente
quando desativado.

## Fora de escopo

- Tokens de API pessoais para automação (registrado como trabalho futuro).
- Administração delegada por repositório: só administradores do sistema
  concedem papéis.
- Envio de e-mail: convites e resets são links de uso único que o
  administrador repassa.
- Papéis customizáveis pelo administrador.
- Autenticação no modo local (loopback), que continua como hoje.

## Decisões

| Tema | Decisão |
|---|---|
| Granularidade | Papel por repositório, mais flag de administrador do sistema |
| Autenticação | Senha local e "Entrar com GitHub", com 2FA TOTP opcional |
| GitHub SSO | Somente contas vinculadas a usuários existentes (convidados) |
| Custo | Operador usa apenas conexões liberadas, com teto opcional por scan |
| Implementação | Módulo próprio na API, sem biblioteca de auth nova |
| Navegação | A aba "System" vira "Configurações" e absorve as telas novas |

Alternativas descartadas:

- **Biblioteca de auth (ex.: Better Auth):** resolveria login e sessão, mas não
  a autorização por repositório, que é a maior parte do trabalho, e traria
  esquema e dependência novos.
- **Identity provider externo na frente do Sentinel:** tira a gestão de
  usuários do produto, que é justamente o que se pede.

## Fases

Cada fase é deployável sozinha. A fase 1 não pode sair sem a autorização, ou o
primeiro usuário convidado veria tudo.

1. **Identidade e autorização central.** Contas, login por senha, sessões,
   CSRF por sessão, bootstrap do administrador, papéis por repositório
   aplicados em toda a API e nos streams, telas de login, convite, Usuários,
   Repositórios e acessos, e Minha conta (nome, senha, sessões). Na fase 1
   somente administradores usam conexões de provedor, então membros veem e
   fazem triagem, mas não iniciam scans pagos.
2. **Custo e rastreabilidade.** Conexões liberadas por usuário e teto de
   custo, autoria (`created_by`) em scans e gates, log de auditoria, tela
   Segurança com sessões ativas e auditoria.
3. **GitHub SSO e 2FA.** Login pelo GitHub App para contas vinculadas, TOTP
   com códigos de recuperação, exigência opcional de 2FA para administradores.

## Papéis e permissões

### Nível do sistema

- **Administrador:** vê e faz tudo. É o único que gerencia usuários e acessos,
  conexões de provedor, GitHub App, engine updates, registro de repositórios,
  reindexação (`/ingest`) e navegação de pastas do servidor (`/fs/list`).
- **Membro:** não vê nada global. Vê somente repositórios em que tem papel.

Pode haver vários administradores, mas nunca menos que um ativo: remover,
rebaixar ou desativar o último administrador é recusado.

### Nível do repositório

Papéis cumulativos, cada um inclui o anterior:

| Papel | Permissões |
|---|---|
| `viewer` (Leitura) | Ver scans, findings, relatórios, attack paths, telemetria, grafo de arquivos, gates, eventos, política, status GitHub, PRs e branches; comparar scans do repositório |
| `analyst` (Analista) | Triagem de findings; simular política |
| `operator` (Operador) | Iniciar e cancelar scans e gates; publicar check; marcar e sincronizar baseline; target preview; dispatch do Actions; fetch e pull do checkout; poll do monitor |
| `maintainer` (Mantenedor) | Editar política e caller workflow; criar e editar regras do monitor; apagar scans e gates |

### Regras de visibilidade

- Recurso sem repositório associado é visível só para administradores. Isso
  inclui scans de pastas locais não registradas.
- Membros só iniciam scans em repositórios registrados. Escolher caminho livre
  no servidor é exclusivo do administrador.
- Compare exige Leitura em todos os scans comparados.
- Leitura de recurso invisível responde `404`. Ação sem papel suficiente sobre
  recurso visível responde `403`. Ausência de sessão responde `401`.

## Modelo de dados

Tabelas novas em `benchmark.db`, criadas por migração versionada no padrão de
`guardrails-migrations.ts`.

### `users`

| Coluna | Observação |
|---|---|
| `id` | identificador opaco |
| `username` | único, normalizado em minúsculas |
| `display_name`, `email` | `email` opcional, informativo |
| `password_hash` | `scrypt` com salt e parâmetros no próprio valor; nulo para quem entra só pelo GitHub |
| `is_admin` | flag do sistema |
| `status` | `active` ou `disabled` |
| `must_change_password` | reservado para resets forçados |
| `failed_attempts`, `locked_until` | bloqueio por tentativas |
| `github_user_id`, `github_login` | fase 3; vínculo pelo id numérico, único |
| `totp_secret` | fase 3; cifrado pelo vault existente |
| `created_at`, `updated_at`, `last_login_at` | auditoria básica |

### `sessions`

| Coluna | Observação |
|---|---|
| `id` | SHA-256 do token; o token só existe no cookie |
| `user_id` | dono |
| `csrf_token` | token CSRF da sessão |
| `created_at`, `last_seen_at`, `expires_at` | 12h de inatividade, 7 dias no máximo |
| `ip`, `user_agent` | exibidos na lista de sessões |
| `revoked_at` | revogação explícita |

### `user_invites`

Link de uso único para convite e reset: `token_hash`, `user_id`, `purpose`
(`invite` ou `reset`), `created_by`, `expires_at` (72h), `used_at`.

### `repository_grants`

Chave `(user_id, repository_key)`, com `role`, `granted_by` e `granted_at`.
`repository_key` referencia `guardrail_repositories`. Remover o repositório
remove as concessões.

### `connection_grants` (fase 2)

Chave `(user_id, connection_id)`, com `max_cost_per_scan_usd` opcional.

### `audit_log` (fase 2)

Somente inserção: `actor_user_id` (ou ator `system`), `action`, `target`,
`detail` em JSON sem segredos, `ip`, `created_at`.

### Alterações em tabelas existentes

- `runs.repository_key`, resolvido na criação do scan:
  - `github:<id>@<sha>` resolve para o repositório com aquele
    `github_repository_id`;
  - caminho local resolve para o repositório cujo `repository_path` o contém;
  - sem correspondência, fica nulo e o scan é visível só para administradores.

  A migração preenche a coluna nos scans existentes.
- `runs.created_by` e `gate_runs.created_by` (fase 2). Registros anteriores
  recebem o administrador inicial.

### Bootstrap e recuperação

- Com `users` vazia, a subida cria o administrador a partir de
  `CSB_ADMIN_USER` e `CSB_ADMIN_PASSWORD_FILE`, com a mesma senha de hoje.
- Depois, essas variáveis servem para recuperação: se não houver administrador
  ativo na subida, esse usuário é reativado como administrador e a senha é
  redefinida a partir do arquivo. A recuperação é registrada no log do
  servidor.

## Autenticação

### Sessão

- `POST /api/auth/login` valida usuário e senha e grava o cookie
  `__Host-sentinel_session` (`HttpOnly; Secure; SameSite=Lax; Path=/`). Cada
  login gera um token novo. Quando `CSB_PUBLIC_ORIGIN` usa `http:` — permitido
  somente em loopback, o fluxo Docker local documentado — o cookie passa a se
  chamar `sentinel_session` e perde `Secure`: o prefixo `__Host-` só vale com
  `Secure`, e o navegador nunca devolve um cookie `Secure` por http, de modo que
  a sessão seria esquecida na requisição seguinte. Origens `https:` mantêm o
  prefixo e o `Secure`. As duas formas ficam definidas em
  `apps/api/src/session-cookie.ts`, e um cookie escrito na forma de loopback
  nunca autentica uma origem segura.
- `GET /api/auth/session` devolve usuário, permissões efetivas e o token CSRF
  da sessão. Substitui `/security-session`, `/connections/security-session` e
  `/engine-updates/security-session` no modo servidor.
- `POST /api/auth/logout` revoga a sessão no servidor.
- As verificações atuais de `Origin` e `Sec-Fetch-Site` continuam. Mutações
  exigem `X-CSRF-Token` igual ao da sessão.
- HTTP Basic deixa de ser aceito no modo servidor.

### Proteções

- `scrypt` com N=2^15, r=8, p=1. Para usuário inexistente o servidor calcula um
  hash falso, mantendo o tempo de resposta.
- Mensagem única para falha: "usuário ou senha inválidos".
- Bloqueio da conta após 5 falhas seguidas: 15 minutos, dobrando a cada nova
  rodada, até 24h. O login bem-sucedido zera o contador.
- Limite por IP de 30 tentativas por minuto. O limitador global atual vira por
  IP.
- Senha com no mínimo 12 caracteres, sem regras de complexidade, diferente do
  usuário.
- Desativar o usuário revoga todas as sessões. Trocar a senha revoga as
  demais sessões. Papéis são lidos do banco a cada requisição.

### Convite e reset

- O administrador cria o usuário e recebe um link `/invite/<token>` de uso
  único, válido por 72h, exibido uma única vez.
- O convidado define a própria senha pelo link. O administrador nunca conhece
  a senha.
- "Resetar senha" gera um novo link do tipo `reset` e revoga as sessões do
  usuário.
- Só o hash do token é persistido.

### GitHub SSO (fase 3)

- Usa o fluxo OAuth de usuário do GitHub App já configurado. O `client_id` e o
  `client_secret` vêm da conexão do GitHub App; a URL de callback
  `/api/auth/github/callback` precisa estar registrada no app. O plano da fase
  3 começa verificando essas duas premissas.
- O parâmetro `state` é assinado e ligado ao navegador.
- Só entra quem tem `github_user_id` vinculado a um usuário ativo. Qualquer
  outra conta é recusada sem criar usuário.
- O vínculo é feito pelo próprio usuário, autenticado com senha, em Minha
  conta.

### 2FA TOTP (fase 3)

- Opcional por usuário: QR code, confirmação com um código e 10 códigos de
  recuperação de uso único, persistidos como hash.
- Com 2FA ativo, o login pede o código depois da senha, e o fluxo do GitHub
  também exige o código.
- Configuração global opcional: exigir 2FA de administradores.

### Compatibilidade

- Modo local continua sem login, com um principal administrador implícito.
- `scripts/docker/smoke.mjs` e `workflow-smoke.mjs` passam a autenticar via
  `POST /api/auth/login`.

## Aplicação na API

### Principal

`serverSecurity` vira o middleware de autenticação: resolve a sessão, rejeita
sessões expiradas ou revogadas e coloca no contexto do Hono um principal com
`userId`, `isAdmin` e as concessões carregadas do banco naquela requisição.

### Registro de rotas

`apps/api/src/route-policy.ts` mapeia `método + padrão de rota` para um
requisito:

- `public`: `/healthz`, `/readyz`, login, aceite de convite e callback do
  GitHub.
- `authenticated`: `/auth/session`, `/auth/logout`, Minha conta,
  `/scanners`.
- `admin`: usuários, concessões, CRUD de `/connections`, GitHub App, engine
  updates, `/ingest`, `/fs/list`, `POST /guardrails/repositories`.
- `repo(papel, resolver)`: o resolver obtém o `repository_key` pelo parâmetro
  `:repositoryKey`, por `runs.repository_key` (`/scans/:id…`), pelo gate
  (`/guardrails/gates/:gateId…`) ou pelo corpo (`POST /scans`,
  `POST /guardrails/gates`).
- `scoped`: listagens que filtram pelo principal.

Rota ausente do registro é negada. Um teste percorre todas as rotas montadas
no Hono e falha se alguma não tiver requisito declarado.

### Filtro de dados

As consultas de listagem recebem um `AccessScope`: administrador vê tudo;
membro vê o conjunto de `repository_key` concedidos. Aplica-se a lista de
scans, scans ativos, catálogo, métricas do Overview, Activity, lista de
gates, repositórios do Guardrails, overview, eventos, regras e runs do
monitor, checkouts e Compare.

### Streams

Os streams SSE de scan e gate autorizam na conexão e revalidam sessão e acesso
a cada 60 segundos, fechando o stream quando a sessão é revogada ou o papel
removido.

### Ações automáticas

Gates e scans disparados pelo monitor do GitHub rodam com o ator `system`,
registrado em `created_by` e na auditoria a partir da fase 2.

### Início de scan (fase 2)

Além do papel `operator`, a conexão escolhida precisa estar em
`connection_grants` do usuário. O teto efetivo é o menor valor entre o teto do
usuário e o da política. Administradores não têm essa restrição.

### Frontend

`/auth/session` entrega as permissões efetivas. A interface esconde o que o
usuário não pode fazer, mas a decisão é sempre do servidor. Um `401` leva a
`/login?next=<caminho>`, aceitando apenas caminhos relativos.

## Telas

### Navegação

A aba "System" (`/settings`) vira **Configurações**, com seções laterais:
Sistema (prontidão atual), Conexões, Usuários, Repositórios e acessos, e
Segurança. Membros veem apenas Minha conta. O canto superior direito ganha um
menu do usuário com iniciais, nome, papel do sistema, Minha conta e Sair.

### Login (`/login`)

Fora do shell da aplicação, no visual do Sentinel.

- Desktop: painel da marca à esquerda (lobo OKAMI,
  `SENTINEL / EVIDENCE-DRIVEN SECURITY`, grid e varredura animados, status do
  motor) e cartão de acesso à direita. Mobile: só o cartão.
- Cartão: usuário, senha com mostrar/ocultar e aviso de Caps Lock, botão
  Entrar com estado de carregamento, erro genérico, contagem regressiva do
  bloqueio, separador e "Entrar com GitHub" (fase 3), etapa de 2FA (fase 3).
- Rodapé com idioma e tema; aviso de sessão expirada quando vindo de `401`.
- Animações respeitam `prefers-reduced-motion`.
- Acessibilidade: labels reais, foco visível, `autocomplete` correto, erros
  anunciados por `aria-live`.
- Textos nos cinco idiomas existentes.

### Convite (`/invite/:token`)

Mesma moldura do login: quem convidou, nome, usuário fixo, nova senha com
medidor de força e confirmação. Link expirado ou já usado mostra orientação
para pedir outro ao administrador.

### Usuários (administrador)

- Tabela com nome, usuário, status, administrador, quantidade de
  repositórios, último login, 2FA e GitHub vinculado; busca e filtro por
  status.
- Convidar usuário: nome, usuário, administrador e papéis iniciais por
  repositório; exibe o link de convite uma única vez com botão de copiar.
- Painel do usuário com abas Acesso (papel por repositório), Conexões e teto
  (fase 2), Sessões e Atividade (fase 2).
- Ações: desativar e reativar, gerar link de reset, promover e rebaixar
  administrador, revogar sessões. Ações destrutivas pedem confirmação.

### Repositórios e acessos (administrador)

Para cada repositório, quem tem acesso e com qual papel, com concessão a
partir dessa visão.

### Segurança (administrador, fase 2)

Sessões ativas de todos os usuários e log de auditoria filtrável por ator,
ação e período.

### Minha conta (todos)

Nome de exibição, troca de senha com a senha atual, sessões ativas com "sair
das outras sessões", vínculo com GitHub e 2FA (fase 3).

## Testes

- Unidade: hash e verificação de senha, bloqueio, expiração de sessão, links
  de uso único, resolução de `repository_key`, avaliação de papéis.
- Matriz de autorização rota × papel, gerada a partir do registro de rotas.
- Teste de cobertura: toda rota montada tem requisito declarado.
- IDOR: acessar por id scans, findings, gates e eventos de repositório sem
  concessão responde `404`.
- Streams: SSE fecha após revogação da sessão ou remoção do papel.
- Último administrador: remover, rebaixar ou desativar é recusado.
- Bootstrap e recuperação do administrador.
- E2E do fluxo convite → definir senha → login → ver apenas o repositório
  concedido → logout.
