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
| `CSB_ADMIN_USER` | usuário administrativo, por exemplo `admin` |
| `CSB_ADMIN_PASSWORD_PATH` | `../files/sentinel-secrets/admin_password` |
| `CSB_VAULT_KEY_PATH` | `../files/sentinel-secrets/vault_key` |

3. Em **Advanced → Mounts**, adicione cada checkout que pode ser analisado no servidor Docker. Monte-o em um subdiretório de `/repos`, por exemplo `/repos/projeto`, como somente leitura. O checkout deve existir no host do daemon; um computador que abre o navegador não é uma fonte de arquivos para o container.
4. Em **Domains**, adicione o domínio para o serviço `sentinel`, porta `8787`, e habilite HTTPS. O gerenciamento de domínio do Dokploy acrescenta as labels Traefik necessárias; confirme o resultado em **Preview Compose** antes do primeiro deploy. A [documentação de Domains](https://docs.dokploy.com/docs/core/docker-compose/domains) descreve esse fluxo.
5. Revise o Preview Compose. Confirme: `sentinel_data` é volume nomeado, os arquivos de secret estão fora do checkout, `sentinel` não possui `ports`, e o serviço selecionado pelo domínio é `sentinel:8787`.
6. Faça o deploy e acompanhe `volume-init` até ele concluir. Em seguida, espere `sentinel` ficar saudável e consulte `https://seu-dominio/readyz`.

As variáveis criadas na interface do Dokploy são gravadas em `.env` para interpolação, mas não são automaticamente injetadas em todos os containers. O Compose deste projeto usa referências explícitas para evitar esse erro de configuração. Veja [Environment no Dokploy](https://docs.dokploy.com/docs/core/docker-compose#environment).

## Depois do primeiro deploy

Entre no domínio HTTPS com o usuário administrativo. Leia a senha apenas do arquivo de operador em uma sessão controlada. Configure depois as conexões e credenciais no vault do servidor; não copie o keychain ou a pasta pessoal de uma estação de trabalho para o volume.

Verifique no painel e pela rota mínima:

```bash
curl --fail https://sentinel.exemplo.com/readyz
```

O healthcheck do container consulta somente `/readyz`. Ele não executa uma engine, não testa provedor e não inicia scan.

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
