# Implantar o Sentinel no Dokploy

Use o tipo **Docker Compose**, não Docker Stack: o arquivo usa `build`, job de inicialização e condições de dependência. O Dokploy envia o tráfego HTTPS pelo proxy dele para o serviço `sentinel` na porta interna `8787`; o Compose base não publica portas no host.

Esta implantação é uma instância única para uma equipe confiável. Ela não é multi-tenant e não separa projetos ou clientes por usuário.

## Preparar arquivos persistentes no servidor Dokploy

Prepare os dois arquivos de segredo fora do checkout que o Dokploy recria em deploy. No host, use a área persistente `../files` da aplicação ou crie File Mounts em **Advanced → Mounts**. O exemplo abaixo assume uma pasta persistente visível ao Compose como `../files/sentinel-secrets`:

```bash
mkdir -p ../files/sentinel-secrets
chmod 700 ../files/sentinel-secrets
openssl rand -base64 32 > ../files/sentinel-secrets/admin_password
openssl rand -hex 32 > ../files/sentinel-secrets/vault_key
chmod 444 ../files/sentinel-secrets/admin_password ../files/sentinel-secrets/vault_key
```

Não exiba esses valores em tickets, screenshots, shell history compartilhado ou variáveis do Dokploy. O diretório pai privado mantém os arquivos protegidos no host; a permissão de leitura do arquivo permite que o processo UID 1000 do container acesse o bind de secret. Guarde a chave do vault em canal separado do backup do volume.

O Dokploy recomenda File Mounts para arquivos que não podem depender do checkout clonado e volumes nomeados para dados que precisam de backup. Consulte a [documentação de Docker Compose do Dokploy](https://docs.dokploy.com/docs/core/docker-compose#volumes).

## Criar a aplicação Compose

1. Crie uma aplicação **Docker Compose** e selecione este repositório e `compose.yaml`.
2. Em **Environment**, cadastre as variáveis abaixo. O arquivo Compose referencia cada variável necessária; por isso elas são interpoladas e entram somente nos campos previstos, sem `env_file` genérico.

| Variável | Valor |
| --- | --- |
| `CSB_COMPOSE_PROJECT_NAME` | identificador único da instalação, por exemplo `sentinel-equipe-a` |
| `CSB_GITHUB_ACTIONS_WORKFLOW_SHA` | SHA de 40 caracteres do commit Sentinel que está sendo construído |
| `CSB_PUBLIC_ORIGIN` | domínio HTTPS final, por exemplo `https://sentinel.exemplo.com` |
| `CSB_TRUST_PROXY` | `1` nesta implantação: o Traefik do Dokploy é o único proxy à frente do serviço |
| `CSB_ADMIN_USER` | usuário administrativo, por exemplo `admin` |
| `CSB_ADMIN_PASSWORD_PATH` | `../files/sentinel-secrets/admin_password` |
| `CSB_VAULT_KEY_PATH` | `../files/sentinel-secrets/vault_key` |

3. Em **Advanced → Mounts**, adicione cada checkout que pode ser analisado no servidor Docker. Monte-o em um subdiretório de `/repos`, por exemplo `/repos/projeto`, como somente leitura. O checkout deve existir no host do daemon; um computador que abre o navegador não é uma fonte de arquivos para o container.
4. Em **Domains**, adicione o domínio para o serviço `sentinel`, porta `8787`, e habilite HTTPS. O gerenciamento de domínio do Dokploy acrescenta as labels Traefik necessárias; confirme o resultado em **Preview Compose** antes do primeiro deploy. A [documentação de Domains](https://docs.dokploy.com/docs/core/docker-compose/domains) descreve esse fluxo.
5. Revise o Preview Compose. Confirme: `sentinel_data` é volume nomeado, os arquivos de secret estão fora do checkout, `sentinel` não possui `ports`, e o serviço selecionado pelo domínio é `sentinel:8787`.
6. Faça o deploy e acompanhe `volume-init` até ele concluir. Em seguida, espere `sentinel` ficar saudável e consulte `https://seu-dominio/readyz`.

`CSB_TRUST_PROXY=1` autoriza o Sentinel a ler o endereço do visitante do último item de `X-Forwarded-For`, que é justamente o item acrescentado pelo Traefik. Esse endereço identifica o balde do limite de tentativas de login por IP. Só defina `1` quando o serviço estiver exclusivamente atrás do proxy do Dokploy, como neste guia; com a porta publicada direto no host, mantenha `0` — caso contrário qualquer visitante escolhe o próprio balde enviando o cabeçalho. Com `0` atrás do proxy não há brecha: todos os logins compartilham um balde único de 30 tentativas por minuto.

As variáveis criadas na interface do Dokploy são gravadas em `.env` para interpolação, mas não são automaticamente injetadas em todos os containers. O Compose deste projeto usa referências explícitas para evitar esse erro de configuração. Veja [Environment no Dokploy](https://docs.dokploy.com/docs/core/docker-compose#environment).

## Depois do primeiro deploy

Entre no domínio HTTPS com o usuário administrativo. Leia a senha apenas do arquivo de operador em uma sessão controlada. A primeira inicialização cria essa conta a partir de `CSB_ADMIN_USER` e `CSB_ADMIN_PASSWORD_PATH`; nas inicializações seguintes, esses valores só voltam a ser usados para restaurar um administrador quando nenhum estiver ativo — eles não funcionam como credencial de autenticação a cada requisição. Convide as demais pessoas em **Configurações → Usuários**, já autenticado como administrador. Configure depois as conexões e credenciais no vault do servidor; não copie o keychain ou a pasta pessoal de uma estação de trabalho para o volume.

Se o administrador configurado ficar bloqueado por tentativas erradas de senha e não houver outra pessoa administradora disponível para desbloqueá-lo na interface, use **Redeploy** ou reinicie o serviço `sentinel`. A inicialização limpa o bloqueio e o contador de falhas apenas da conta indicada em `CSB_ADMIN_USER` e registra isso nos logs; a senha em uso continua a mesma, e o limite de tentativas por IP continua valendo.

Verifique no painel e pela rota mínima:

```bash
curl --fail https://sentinel.exemplo.com/readyz
```

O healthcheck do container consulta somente `/readyz`. Ele não executa uma engine, não testa provedor e não inicia scan.

## E-mail e notificações

O e-mail vem **desligado**. Nada é enfileirado enquanto ele estiver desligado, então ligá-lo meses depois não libera fila acumulada — e também não há como alguém receber nada antes desta configuração. Convites e redefinições de senha continuam funcionando sem e-mail: o link copiável está sempre na resposta da tela de usuários.

Ligar exige duas coisas, nesta ordem:

1. **Verificar o domínio do remetente no provedor.** O endereço em "remetente" precisa pertencer a um domínio que o provedor já autorizou a enviar em seu nome — SPF, DKIM e, de preferência, DMARC publicados no DNS desse domínio. No Resend isso é *Domains → Add domain*, que devolve os registros a publicar e só marca o domínio como verificado depois de enxergá-los. Na Hostinger o domínio já hospedado lá costuma vir com SPF e DKIM prontos; confirme na área de e-mail antes de usá-lo. Verificação de DNS não é instantânea: espere a propagação antes de testar.
2. **Preencher Configurações → E-mail**, já autenticado como administrador: provedor (`smtp` ou API do Resend), preset, remetente, e o interruptor global. A senha SMTP ou a chave de API vai para o vault do servidor e a API nunca a devolve — apenas "configurado".

Depois use **"Enviar e-mail de teste"**: ele envia na hora, para o seu próprio endereço, e mostra o erro real do provedor em vez de esconder a falha.

O erro que esse botão mais produz em um deploy novo é `sender_not_verified`: o provedor aceitou a credencial e recusou o remetente. É sempre o passo 1 faltando ou incompleto — domínio não verificado, verificado mas com DNS ainda propagando, ou um endereço de remetente em outro domínio. Nenhuma outra pista aparece: sem o teste, o sintoma seria apenas mensagens paradas em `failed` no histórico de entregas. **Configurações → E-mail** mostra as últimas 200 entregas com destinatário, tipo, status, tentativas e último erro; é onde diagnosticar qualquer envio depois disso.

Os links dos e-mails usam `CSB_PUBLIC_ORIGIN`. Sem ele a mensagem sai sem link algum em vez de sair com um link quebrado, então confirme que a variável aponta para o domínio HTTPS final antes de ligar o e-mail.

A chave do vault é pré-requisito: `CSB_VAULT_KEY_PATH` (na tabela acima) é o arquivo externo que o Compose monta como segredo e a API lê em `CSB_VAULT_KEY_FILE`, já obrigatório na inicialização em modo servidor. Ele agora protege também a senha SMTP e a chave do Resend — trate a rotação desse arquivo como rotação dessas credenciais.

O host SMTP aceita IP literal, inclusive privado, porque `segurança: none` existe para relays internos. Quem configura o e-mail pode, portanto, abrir uma conexão de dentro da rede do container e ver parte do banner da resposta no histórico. É uma capacidade de administrador, menor que as conexões de modelo e as credenciais do GitHub App que o mesmo papel já configura, mas é motivo para não dar o papel de administrador a quem não precisa dele.

## GitHub App e webhook

O Sentinel não consulta o GitHub em laço: quem dispara os gates são **webhooks
assinados da GitHub App**. A App precisa, portanto, das permissões certas, dos
eventos certos e de um segredo de webhook. A tela **GitHub → Integração** lista
exatamente o que falta; esta seção é o que fazer no GitHub.

**App nova (fluxo do manifest).** Nada a fazer. O manifest já pede as seis
permissões, assina os seis eventos, declara a URL do webhook em
`hook_attributes`, e o segredo que o GitHub gera na conversão é gravado no vault
junto da chave privada da App. Confira depois em Integração que o segredo aparece
como `configurado`.

**App existente.** Três ajustes em `https://github.com/settings/apps/<slug>`:

1. **Permissions** — `checks: write`, `contents: write`, `pull_requests: write`,
   `actions: write`, `workflows: write`, `metadata: read`. Salvar no GitHub só
   muda o que a App **pede**: ampliar permissões enfileira uma revisão **em cada
   instalação**, e até a aprovação a instalação continua com os níveis antigos. A
   tela de Integração compara as duas coisas — ela aponta a permissão que falta e
   **em qual instalação a revisão está pendente**. Aprove em
   `https://github.com/settings/installations/<id>` (ou na página equivalente da
   organização) antes de habilitar uma ação; sem isso o gate roda e a publicação
   do Check falha com `github_permission_missing`.
2. **Subscribe to events** — `pull_request`, `push`, `installation`,
   `installation_repositories`, `check_run`, `workflow_run`.
3. **Webhook** — URL `https://sentinel.okamilab.com/api/github/webhook`, marcado
   como *Active*, *Content type* `application/json`, e um **Secret**. Gere o
   segredo no GitHub, copie e cole no Sentinel em **Integração → Webhook**. O
   Sentinel guarda o segredo no vault e **nunca o mostra de novo** — a tela só
   informa `configurado` ou `ausente`, e a API nunca devolve o valor.

**Nenhuma variável de ambiente nova guarda segredo.**
`CSB_GITHUB_WEBHOOK_SECRET` é deliberadamente não introduzida: o segredo do
webhook segue a mesma custódia da chave privada da App, cifrado pela chave de
`CSB_VAULT_KEY_FILE`. Trocar esse arquivo **não** rotaciona nada no GitHub — ele
torna o pacote gravado indecifrável, e perde de uma vez a chave privada da App e
o segredo do webhook. Depois de trocá-lo, refaça o fluxo do manifest (ou
recarregue a chave privada) e cole um segredo novo; até então a própria tela de
Integração responde erro em vez de dizer `ausente`. A única variável opcional
desta área é `CSB_GITHUB_RECONCILE_INTERVAL_MS`, que ajusta o intervalo da
reconciliação (padrão de 15 minutos) — a rede de segurança para a entrega que não
chegou.

**Trocar o segredo do webhook.** Nesta ordem: gere e salve o segredo no GitHub,
cole imediatamente em **Integração → Webhook**, e reenvie uma entrega pela página
*Advanced* da App para confirmar `processado`. O GitHub passa a assinar com o
segredo novo no instante do Save, então toda entrega entre o Save e a colagem
falha a assinatura — a reconciliação de 15 minutos recupera os commits desse
intervalo, de modo que a janela custa latência, não cobertura.

**Proxy reverso.** A assinatura é um HMAC sobre os **bytes crus** do corpo, então
o proxy não pode alterar nada no caminho:

- não remover nem reescrever `X-Hub-Signature-256`, `X-GitHub-Event` e
  `X-GitHub-Delivery`;
- permitir corpo de até 1 MiB;
- não *bufferizar* de forma que altere bytes (recompressão, reencode, injeção de
  quebra de linha).

Dokploy e Traefik atendem a isso por padrão. Uma entrega cujo corpo chegue
alterado responde `401 signature_invalid` e, **por desenho, não é registrada** —
a lista de entregas do Sentinel fica vazia, o que é indistinguível de "nada
aconteceu". O sinal está do outro lado: *Settings → Apps → <slug> → Advanced →
Recent Deliveries*, no GitHub, mostra os 401 com corpo e cabeçalhos. Lista vazia
no Sentinel e 401 nessa página significa assinatura — ou seja, o segredo, o
proxy, ou uma App apontando para outro destino.

**Escopo da instalação.** Se a App foi instalada em *only selected
repositories*, o multi-select de cadastro só mostra os repositórios escolhidos.
Amplie a seleção em `https://github.com/settings/installations/<id>` (instalação
pessoal) ou em
`https://github.com/organizations/<org>/settings/installations/<id>`
(organização). A tela de Integração traz esse link pronto em **Ampliar seleção de
repositórios**, junto de quantos repositórios a instalação alcança e quantos
estão cadastrados.

**Conferir que está chegando.** Em Integração, a lista de entregas mostra as mais
recentes com resultado (`processado`, `ignorado`, `falhou`) e motivo, e a
contagem das últimas 24 horas. Uma reentrega do mesmo `X-GitHub-Delivery`
responde `duplicate` e não repete trabalho, então reenviar pelo painel do GitHub
é seguro.

## Backups, restauração e atualização

O volume nomeado `sentinel_data` contém SQLite, relatórios, estado de engines e o home privado. Programe backup em **Volume Backups** e escolha uma janela sem scans: um backup que para o container interrompe o processo em andamento. Bind mounts de repositórios não entram nesse backup; mantenha-os em sua origem Git ou em backup próprio.

Para testar uma restauração:

1. Restaure para um volume novo, sem sobrescrever a instalação em produção.
2. Aponte uma cópia da aplicação para esse volume e mantenha o mesmo `vault_key` externo.
3. Abra a interface, confira relatórios existentes e teste uma conexão que dependa do vault.
4. Só então promova o volume restaurado ou descarte o teste.

Uma imagem nova ou uma reversão só deve ocorrer sem scans ativos. Antes de rollback, confirme compatibilidade com o banco ou restaure o volume consistente correspondente. A atualização/rollback de runtime administrado pelo Sentinel permanece uma operação diferente da troca de imagem.

Dokploy dá suporte a backup automatizado apenas para volumes nomeados, não binds; isso é o motivo de SQLite e estado privado ficarem em `sentinel_data`. Consulte [Volume Backups](https://docs.dokploy.com/docs/core/volume-backups).

## Incidentes operacionais

- `volume-init` falha: confirme que `sentinel_data` é gravável pelo Docker e que não contém um arquivo ou symlink no lugar dos diretórios de estado.
- O container reinicia: verifique `sentinel` e `volume-init` nos logs; não altere para root como correção provisória.
- O domínio abre mas scans não veem arquivos: confirme o mount de `/repos/projeto` no host Docker e `CSB_REPOSITORY_ROOTS=/repos`; não monte `/` ou a home do servidor.
- A senha ou o vault falha após restore: verifique se os arquivos externos corretos foram preservados. Restaurar somente o volume sem a chave do vault não restaura acesso às credenciais.

## Reverter a migração das regras de monitor para ações

A fase 1 de GitHub + Guardrails renomeia `github_monitor_rules`,
`github_monitor_events`, `github_monitor_actions_runs` e
`github_monitor_poll_leases` com o sufixo `_migrated`, e cria `github_actions`,
`github_action_events` e `github_webhook_deliveries`. Reverter a imagem para uma
versão anterior **não** desfaz isso: a versão antiga recria as quatro tabelas
**vazias** na primeira chamada, o poller não encontra nenhuma regra e a
automação da operadora para em silêncio, enquanto as linhas reais seguem nas
tabelas `_migrated`.

Antes de reverter a imagem, execute o passo inverso com o container ainda na
versão nova e sem scans ativos:

```sh
docker exec -i <container> node --import tsx -e "
  import { getDb } from '/app/apps/api/src/db.js';
  import { rollbackGitHubActionsMigration } from '/app/apps/api/src/github-actions/migrate-monitor-rules.js';
  console.log(rollbackGitHubActionsMigration(getDb()));
"
```

Ele devolve `{ restored, discardedActions, discardedEvents, discardedDeliveries }`.
As ações criadas depois da migração, seus eventos e o log de entregas são
descartados — é o significado de voltar a um esquema que não tinha ações. As
regras de monitor voltam intactas.

**Este procedimento expira na fase 5**, que remove as tabelas `_migrated`. Sem
nenhuma delas não há para onde voltar, e o passo inverso falha de propósito com
`github_actions_rollback_unavailable` em vez de apagar a automação. Confirme
primeiro que ainda existe o que restaurar:

```sql
SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'github_monitor_%_migrated';
```

Se essa consulta não devolver linha nenhuma, **não continue**: reverter a
migração já não é possível e o caminho é restaurar o backup do volume.

Se o container já não subir, e só depois de a consulta acima devolver linhas, o
mesmo efeito em SQL, dentro de uma transação:

```sql
BEGIN IMMEDIATE;
DROP TABLE IF EXISTS github_monitor_rules;
DROP TABLE IF EXISTS github_monitor_events;
DROP TABLE IF EXISTS github_monitor_actions_runs;
DROP TABLE IF EXISTS github_monitor_poll_leases;
ALTER TABLE github_monitor_rules_migrated        RENAME TO github_monitor_rules;
ALTER TABLE github_monitor_events_migrated       RENAME TO github_monitor_events;
ALTER TABLE github_monitor_actions_runs_migrated RENAME TO github_monitor_actions_runs;
ALTER TABLE github_monitor_poll_leases_migrated  RENAME TO github_monitor_poll_leases;
DROP TABLE IF EXISTS github_action_events;
DROP TABLE IF EXISTS github_actions;
DROP TABLE IF EXISTS github_webhook_deliveries;
DROP TABLE IF EXISTS github_actions_schema_migrations;
COMMIT;
```

Faça backup do volume `sentinel_data` antes, em qualquer um dos dois caminhos.
