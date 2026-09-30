# E-mail e notificações

**Status:** aprovado para implementação

**Data:** 2026-09-30

**Produto:** Okami Sentinel

**Depende de:** `2026-09-29-multi-user-access-design.md` (usuários, papéis por repositório, convites)

## Problema

O Sentinel não envia e-mail. Convites e resets dependem de o administrador
copiar o link e repassá-lo, e ninguém fica sabendo de um gate bloqueado, de um
scan que falhou, de uma conexão quebrada ou de um login suspeito sem abrir a
interface.

## Objetivo

- Conectar um provedor de e-mail pela interface: SMTP genérico (Resend,
  Hostinger, Zoho, Gmail/Workspace, Microsoft 365 ou personalizado) ou a API
  HTTP do Resend.
- Enviar automaticamente convites e resets, mantendo o link copiável.
- Notificar resultados de scan e gate, alertas operacionais e alertas de
  segurança da conta.
- Cada usuário escolhe o que recebe, por repositório que acessa.
- Nenhuma notificação é perdida quando o provedor está fora ou o processo
  reinicia.

## Fora de escopo

- Webhooks de entrega/bounce do Resend.
- Mais de um provedor ativo ao mesmo tempo.
- Destinos externos definidos pelo administrador (listas de time).
- Descadastro com um clique por token (o rodapé leva a Minha conta).
- Canais além de e-mail (Slack, webhooks genéricos).

## Decisões

| Tema | Decisão |
|---|---|
| Provedores | SMTP genérico com presets e API nativa do Resend |
| Entrega | Caixa de saída no SQLite com worker no processo e retentativas |
| Destinatários | Assinatura por usuário; conta sempre ligada; operacionais só para admins |
| Conteúdo | Sem detalhes de vulnerabilidade; contagens, resultado e link autenticado |
| Idioma | Idioma preferido do destinatário |
| Dependência | `nodemailer` para SMTP; Resend via `fetch` |

Alternativas descartadas: envio síncrono no evento (perde notificações com o
provedor fora e atrasa requisições) e fila externa (infraestrutura sem volume
que a justifique).

## Provedores e configuração

Nova seção **Configurações → E-mail** (`08.06`, somente administradores):

- Tipo do provedor: `smtp` ou `resend`. Um ativo por vez.
- SMTP: host, porta, segurança (`tls` na 465, `starttls` na 587, `none` apenas
  para relays internos), usuário e senha. Presets preenchem host, porta e
  segurança:
  - Resend: `smtp.resend.com`, 465 `tls`, usuário `resend`, senha = chave de API.
  - Hostinger: `smtp.hostinger.com`, 465 `tls`.
  - Zoho: `smtp.zoho.com` e `smtp.zoho.eu`, 465 `tls`.
  - Gmail/Workspace: `smtp.gmail.com`, 465 `tls`.
  - Microsoft 365: `smtp.office365.com`, 587 `starttls`.
  - Personalizado.
- Resend API: chave de API. Envio por `POST https://api.resend.com/emails` com
  cabeçalho `Idempotency-Key` igual ao id da mensagem na caixa de saída.
- Comum: nome e endereço do remetente, reply-to opcional, interruptor global.
- Senha SMTP e chave do Resend ficam no vault cifrado existente. A API nunca
  devolve o segredo, apenas `configured: true`; substituí-lo exige enviar um
  novo valor.
- Links nos e-mails usam `CSB_PUBLIC_ORIGIN`. Sem origem pública (modo local),
  o e-mail é enviado com links relativos desabilitados e um aviso na tela.
- "Enviar e-mail de teste" envia imediatamente ao administrador e mostra o erro
  real do provedor.
- Histórico das últimas 200 entregas: destinatário, tipo, status, tentativas,
  último erro, horário.

O host SMTP é aceito como nome ou como IP literal, inclusive privado e
link-local, e nenhum intervalo é bloqueado. Isso é deliberado: `security: none`
"apenas para relays internos" exige justamente esse caminho, e um relay interno
costuma ser alcançável só por endereço. A consequência é que quem configura o
e-mail pode abrir uma conexão TCP de dentro da rede do container e ler até 200
caracteres redigidos do banner em `last_error` ou na resposta do teste — uma
capacidade de administrador, estritamente menor que as conexões de modelo, as
credenciais do GitHub App e as rotas de scanner que o mesmo papel já configura.
Tratar o campo como capacidade administrativa é a mitigação; bloquear faixas
privadas quebraria o caso de uso documentado.

## Eventos

| Grupo | Evento | Destinatário | Padrão |
|---|---|---|---|
| Conta | `account.invite` | endereço do convidado | sempre |
| Conta | `account.reset` | o usuário | sempre |
| Conta | `account.new_login` | o usuário | sempre |
| Conta | `account.locked` | o usuário | sempre |
| Conta | `account.password_changed` | o usuário | sempre |
| Repositório | `gate.blocked` | assinantes | ligado |
| Repositório | `gate.error` | assinantes | ligado |
| Repositório | `scan.failed` | assinantes | ligado |
| Repositório | `gate.passed` (inclui aviso) | assinantes | desligado |
| Repositório | `scan.completed` | assinantes | desligado |
| Operacional | `ops.engine_unavailable` (mais de 5 min) | admins assinantes | ligado |
| Operacional | `ops.connection_attention` | admins assinantes | ligado |
| Operacional | `ops.daily_cost` (80% e 100% do teto) | admins assinantes | ligado |
| Operacional | `ops.github_publish_failed` | admins assinantes | ligado |

- `account.new_login`: login cujo par (IP, navegador) não aparece em nenhuma
  sessão dos últimos 90 dias do usuário. O primeiro login da conta não gera
  alerta.
- Eventos de repositório vão para quem tem papel `viewer` ou superior no
  repositório (administradores incluídos), filtrados pela assinatura. O acesso
  é verificado de novo no momento do envio.
- Scans sem repositório associado geram eventos apenas para administradores.

## Assinaturas

- Tabela `notification_subscriptions (user_id, scope, event, enabled)`, com
  `scope` igual à `repository_key`, `ops` ou `unassigned`. A ausência de linha
  significa o padrão da tabela de eventos.
- `unassigned` é o escopo reservado dos scans sem repositório. Eles vão só para
  administradores, mas continuam filtrados por assinatura: sem um escopo próprio
  seriam os únicos e-mails que ninguém poderia desligar. Nenhuma
  `repository_key` pode ser igual a um escopo reservado — toda chave gerada
  contém separador — e o registro de repositórios recusa uma que fosse.
- **Minha conta → Notificações**: matriz de repositórios acessíveis por eventos
  de repositório, linha de operacionais e linha de scans sem repositório para
  administradores, e eventos de conta exibidos como sempre ativos.
- Remover o acesso a um repositório impede envios daquele escopo; as linhas de
  assinatura permanecem para o caso de o acesso voltar.

## Endereço de destino

1. `users.email`, se preenchido.
2. Senão, o `username`, se for um endereço de e-mail válido.
3. Senão, o usuário não recebe e-mails; Minha conta mostra o aviso.

O convite usa o e-mail informado no diálogo; se vazio, o `username` quando for
um endereço. O diálogo mostra se o convite será enviado por e-mail.

## Controle de ruído

- `dedupe_key` única na caixa de saída: `gate.<gateId>.<evento>`,
  `scan.<scanId>.<evento>`, `account.<userId>.<evento>.<referência>`.
- Alertas operacionais: no máximo um por `(evento, alvo)` a cada 6 horas
  enquanto a condição persistir, e um e-mail de resolução quando ela terminar.
  A janela só avança quando alguma mensagem foi realmente enfileirada: com o
  e-mail desligado, sem endereço ou sem assinante, a condição continua sendo
  reavaliada em vez de ficar seis horas em silêncio. A resolução também só
  fecha o episódio se saiu de fato. Com o e-mail desligado e nenhum episódio
  aberto, o avaliador não observa nada; a carência começa quando o envio é
  ligado, para que ligar o e-mail não anuncie de uma vez uma falha antiga.
- Custo diário: um e-mail ao cruzar 80% e outro ao cruzar 100%, por dia e teto.
  Quando os dois limites são cruzados de uma vez, vale só o de 100%.
- `ops.github_publish_failed` tem o gate como alvo e repete a cada 6 horas
  enquanto o check não chegar ao GitHub. Decisão consciente: a condição é real e
  fica sem resolução até alguém republicar. Se incomodar, o ajuste certo é
  trocar o alvo (repositório ou conexão), não criar um teto de repetições. Um
  gate apagado é esquecido, não anunciado como publicado.
- `ops.connection_attention` e `ops.engine_unavailable` têm 5 minutos de
  carência, para que uma renovação de token e o primeiro ciclo depois de uma
  atualização não disparem uma rajada sobre conexões quebradas há semanas.
- Disponibilidade da engine: há engine quando um scanner local está disponível
  **ou** quando existe conexão de provedor `ready` — uma instalação que só
  escaneia por HTTP não tem CLI e não pode ser reportada como quebrada para
  sempre. `authentication-required` não conta como atenção: é etapa de
  configuração, não falha.
- Estado dos alertas em `ops_alert_state (event, target, active_since,
  last_sent_at, resolved_at)`, para que um reinício no meio de uma indisponi-
  bilidade não realerte nem reinicie a janela. Episódios já resolvidos são
  apagados junto da retenção da caixa de saída.

## Conteúdo

- Nunca incluir título de finding, trecho de código, caminho de arquivo,
  evidência, prompt ou segredo.
- Repositório: nome do repositório, branch ou PR, resultado, contagens por
  severidade, custo, duração e link para a página no Sentinel. Um scan sem
  repositório se identifica pelo próprio id: o `displayName` dele é o nome do
  diretório escaneado, que é informação do host.
- Conta: horário, IP, navegador resumido e link para Minha conta.
- HTML simples com a marca Okami e versão em texto puro, nos cinco idiomas da
  interface. Rodapé: motivo do envio e link para Minha conta → Notificações.
- Idioma: `users.locale`, gravado quando o usuário troca o idioma na
  interface. Padrão `pt-BR`. Convites usam o idioma de quem convidou.

## Entrega

- `email_outbox`: `id`, `event`, `dedupe_key` (única), `user_id`, `to_address`,
  `locale`, `subject`, `html`, `text`, `status` (`queued`, `sending`, `sent`,
  `failed`, `cancelled`), `attempts`, `next_attempt_at`, `last_error`,
  `provider_message_id`, `created_at`, `sent_at`.
- A mensagem é renderizada e gravada na mesma transação do evento que a gera.
  Com o e-mail desligado globalmente, nada é enfileirado (exceto que convites e
  resets continuam com o link copiável).
- Worker no processo da API, a cada 5 segundos: reivindica até 10 mensagens
  vencidas marcando `sending`, envia, e marca `sent` ou agenda nova tentativa.
- Retentativas: 1 min, 5 min, 30 min e 2 h; após 5 tentativas, `failed`.
  Erros permanentes (endereço inválido, autenticação recusada) contam como
  tentativas; o último erro fica visível no histórico.
- Mensagens presas em `sending` por um processo anterior voltam a `queued` no
  primeiro *tick* do worker, não na inicialização — um banco travado no boot não
  pode impedir a API de subir — e cada retorno custa uma tentativa, para que uma
  mensagem venenosa não reinicie a API indefinidamente. Linhas criadas depois que
  o worker nasceu não são tocadas: o teste de envio é gravado já como `sending` e
  resolvido dentro da própria requisição.
- Antes de enviar um evento de repositório, o worker confirma que o
  destinatário ainda está ativo e ainda vê o repositório; se não, `cancelled`.
- Retenção: mensagens enviadas ou canceladas com mais de 90 dias são apagadas.

## API

| Método e rota | Acesso | Função |
|---|---|---|
| `GET /email/settings` | admin | configuração sem segredos |
| `PUT /email/settings` | admin | salvar configuração e segredos |
| `POST /email/test` | admin | enviar teste para o administrador |
| `GET /email/deliveries` | admin | histórico |
| `GET /account/notifications` | autenticado | assinaturas efetivas do usuário |
| `PUT /account/notifications` | autenticado | alterar assinaturas permitidas |
| `PATCH /account/profile` | autenticado | passa a aceitar `locale` |

`GET /account/notifications` devolve a matriz efetiva: uma linha por repositório
visível, a linha `ops` e a linha `unassigned` apenas para administradores, os
eventos de conta marcados como sempre ativos e o endereço resolvido (ou `null`).
`PUT` é um *patch* esparso, não uma substituição: manda só as células alteradas,
`{"subscriptions": []}` não muda nada e não existe verbo de "voltar ao padrão".
Uma célula recusada recusa o lote inteiro. Repositório inexistente e repositório
não compartilhado respondem com o mesmo código, para o erro não servir de
enumeração.

Todas as rotas entram no registro de permissões com teste de cobertura.

## Telas

- **Configurações → E-mail**: provedor com presets, remetente, interruptor,
  estado "configurado" dos segredos, botão de teste com resultado, histórico.
- **Minha conta → Notificações**: matriz de assinaturas e aviso quando não há
  endereço.
- **Convidar usuário**: indica se o convite será enviado por e-mail; o
  resultado mostra "e-mail enviado para X" junto ao link copiável.
- Mesmo padrão visual das demais seções: abas de Configurações, depois o
  cabeçalho, com os cinco idiomas.

## Testes

- Unidade: presets, resolução do endereço, deduplicação, janela de 6 horas,
  retentativas e backoff, cancelamento por perda de acesso, renderização sem
  dados sensíveis, idiomas.
- Transporte simulado para SMTP e Resend; teste de integração SMTP contra um
  servidor SMTP local em memória.
- Rotas: autorização, segredos nunca retornados, validação.
- e2e: configuração de e-mail, teste de envio, assinaturas em Minha conta,
  diálogo de convite indicando envio.
