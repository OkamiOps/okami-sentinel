# Executar o Sentinel com Docker

Este modo reúne interface, API e workers no mesmo container Linux amd64. Ele é uma instalação única, com SQLite e estado privado em um volume Docker. A API opera em modo `server`, exige origem explícita e autenticação administrativa; o override local publica somente em `127.0.0.1`.

O container não recebe Docker socket, `privileged`, rede do host, o diretório pessoal do operador ou o checkout do Sentinel como volume. O único bind opcional é o repositório autorizado em `/repos/projeto`, montado como somente leitura.

## Pré-requisitos

- Docker Engine com Docker Compose v2 no host que executará os scans;
- Linux amd64 para a primeira versão suportada;
- checkout deste repositório em um commit Git válido;
- espaço para o volume persistente e para snapshots temporários dos scans.

Node e pnpm no host são opcionais. O setup Docker-only abaixo usa uma imagem temporária `node:24.17.0-bookworm`; ela monta somente o checkout, o diretório privado de segredos e, quando diferente, o repositório autorizado. Ela não monta o socket Docker.

O Docker Desktop usa arquivos do computador onde o daemon está rodando. Se o daemon estiver em outro servidor, `CSB_REPOSITORY_PATH` precisa apontar para um checkout existente **nesse servidor**. Abrir a interface no navegador não transfere arquivos do computador do visitante.

## Matriz de suporte Docker

| Engine | Primeira versão Docker |
| --- | --- |
| Codex Security | Perfil Portable por rotas HTTP autenticadas. |
| Mantis | Executor HTTP por rotas HTTP autenticadas. |
| VulnHunter | Perfil HTTP estático e somente leitura por rotas HTTP autenticadas. |

As rotas Native/CLI e provedores com sessão local do host não fazem parte desta primeira versão: o container não compartilha login, keychain ou processos desktop do operador. Configure somente as credenciais compatíveis no vault do servidor. Linux amd64 foi validado; macOS/Apple Silicon, Windows e Linux arm64 ainda não têm validação de suporte.

## Instalação local

No checkout do Sentinel, execute uma vez. Para uma máquina que tem somente Docker:

```bash
sh scripts/docker/setup.sh
```

Em uma máquina que já tem Node 24, o mesmo setup pode rodar diretamente:

```bash
node scripts/docker/setup.mjs
```

O comando cria `.env.local` ignorado pelo Git, resolve o SHA imutável do checkout e cria `admin_password` e `vault_key` em `~/.local/share/okami-sentinel` por padrão. Os valores não são impressos. O diretório é `0700`; os arquivos são `0444` para que o processo do container, que roda como UID 1000, consiga lê-los. Em instalações Docker Desktop e Linux isso preserva o isolamento no host pelo diretório pai privado.

Para analisar outro checkout ou usar um diretório privado escolhido pelo operador:

```bash
sh scripts/docker/setup.sh \
  --repository /caminho/do/repositorio-autorizado \
  --config-dir /caminho/privado/okami-sentinel
```

O valor padrão de origem é `http://127.0.0.1:8787`. Uma origem hospedada deve usar HTTPS:

```bash
sh scripts/docker/setup.sh --origin https://sentinel.exemplo.com
```

Para uma porta loopback diferente, passe a mesma porta na origem. O setup grava `CSB_LOCAL_PORT` e mantém o host preso a `127.0.0.1`:

```bash
sh scripts/docker/setup.sh --origin http://127.0.0.1:18888
```

Confira a configuração interpolada antes de criar containers:

```bash
docker compose --env-file .env.local -f compose.yaml -f compose.local.yaml config
```

Suba a instalação local:

```bash
docker compose --env-file .env.local -f compose.yaml -f compose.local.yaml up --build -d
```

Valide a prontidão sem chamar uma engine ou um provedor:

```bash
curl --fail http://127.0.0.1:8787/readyz
```

Abra <http://127.0.0.1:8787>. Para obter a senha quando o operador for entrar, leia o arquivo indicado em `.env.local` diretamente em um terminal controlado. O instalador e o Compose nunca a exibem nos logs.

```bash
cat ~/.local/share/okami-sentinel/admin_password
```

Pare a aplicação sem apagar dados:

```bash
docker compose --env-file .env.local -f compose.yaml -f compose.local.yaml down
```

Não use `down -v` em uma instalação que contém histórico ou credenciais: ele remove o volume nomeado com SQLite, artefatos e o estado privado das engines.

### Windows

O wrapper `setup.sh` é para macOS e Linux. No Windows com Docker Desktop, copie `.env.example` para `.env.local`, crie `admin_password` e `vault_key` fora do checkout, restrinja as ACLs desses arquivos e informe seus caminhos absolutos em `CSB_ADMIN_PASSWORD_PATH` e `CSB_VAULT_KEY_PATH`. A senha administrativa precisa ter ao menos 24 caracteres; `vault_key` deve conter 64 caracteres hexadecimais (32 bytes). Defina também um SHA Git de 40 caracteres, a origem `http://127.0.0.1:8787` ou HTTPS, `CSB_LOCAL_PORT` para o override local e `CSB_REPOSITORY_PATH` para um checkout compartilhado com o Docker Desktop. Não coloque valores de segredo em `.env.local`.

## O que cada arquivo faz

| Arquivo | Uso |
| --- | --- |
| `compose.yaml` | Base sem porta publicada, adequada para proxy reverso e Dokploy. |
| `compose.local.yaml` | Override que limita a porta a `127.0.0.1:8787` e monta um repositório como leitura. |
| `.env.local` | Caminhos e configuração do operador, ignorada pelo Git. Não contém o valor dos segredos. |
| `sentinel_data` | Volume nomeado com SQLite, home privado, runtimes atualizados e arquivos temporários. |
| `volume-init` | Job efêmero root que prepara apenas os cinco diretórios fixos do volume; não percorre nem altera proprietários de dados preexistentes. |

O serviço `sentinel` inicia como UID/GID `1000:1000`, com filesystem raiz somente leitura. `data`, `home`, `tmp`, `codex-home` e `codex-security-state` vivem no volume. `TMPDIR` não é `tmpfs`, porque snapshots podem ser grandes.

As credenciais são entregues como arquivos em `/run/secrets`. A convenção `_FILE` é interpretada pelo Sentinel; o Docker apenas monta os arquivos. Consulte a [documentação de secrets do Docker Compose](https://docs.docker.com/compose/how-tos/use-secrets/) para o modelo de acesso por serviço.

## Runtimes e atualização

A imagem contém dois fallbacks Linux fixados:

| Runtime | Versão incluída | Caminho |
| --- | --- | --- |
| Codex CLI | `0.153.4` | `/opt/sentinel-engines/codex-cli` |
| Codex Security | `0.1.25` | `/opt/sentinel-engines/codex-security` |

O servidor resolve um runtime instalado e validado no volume antes do fallback incluído na imagem. Não defina `CODEX_BIN` nem `CODEX_SECURITY_BIN` no template: isso troca a origem controlada do runtime por um caminho externo.

Atualizar a imagem não é o mesmo que atualizar uma engine pelo Sentinel. Faça atualização ou rollback de imagem apenas sem scans ativos. Um rollback de imagem requer compatibilidade com o esquema SQLite ou a restauração do backup correspondente; o rollback de CLI pelo updater é uma operação separada e preserva seu próprio histórico no volume.

## Operação e diagnóstico

```bash
# Estado de serviços e healthcheck
docker compose --env-file .env.local -f compose.yaml -f compose.local.yaml ps

# Logs da aplicação sem expor os arquivos de segredo
docker compose --env-file .env.local -f compose.yaml -f compose.local.yaml logs --tail=200 sentinel

# Rota mínima de admissão; não usa CLI nem provedor
curl --fail http://127.0.0.1:8787/readyz
```

`/healthz` e `/readyz` são probes públicos mínimos e não executam engines. `/readyz` só confirma que a inicialização e a admissão de trabalho terminaram. O diagnóstico de engines continua na API autenticada em `/api/health`; não use probes públicos como diagnóstico operacional.

O template começa com `CSB_MAX_CONCURRENT_SCANS=1`. Aumente somente depois de medir CPU, RSS, disco temporário e tempo de scans representativos na máquina que hospedará o serviço.

## Limites desta entrega

- Uma única réplica usa um único volume SQLite. Não compartilhe o volume entre containers, hosts ou NFS.
- O primeiro suporte é Linux amd64. Apple Silicon usando emulação não equivale a validação arm64.
- Repositórios montados localmente são somente leitura. Guardrails que escrevem exigem uma autoridade e checkout explicitamente autorizados.
- As sessões desktop do host não entram no container. Configure as conexões no vault do servidor depois de entrar na interface.
