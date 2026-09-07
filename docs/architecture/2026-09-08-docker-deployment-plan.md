# Plano de implementação: Docker e Dokploy

**Status:** planejamento; nenhuma imagem ou instalação Docker foi validada nesta etapa.
**Base auditada:** `631e0d19a7381c7d7f75e9a371d6b3417f9938db`, em 08/09/2026.
**Objetivo:** distribuir o Sentinel para instalação própria com Docker Compose, incluindo implantação pelo Dokploy.
**Arquitetura:** uma instância por cliente/equipe, com interface, API e processos dos scanners em um container; SQLite e estado privado em volume persistente. O proxy do Dokploy fornece HTTPS.
**Stack:** Node 24, pnpm 11.5.2, React/Vite, Hono, SQLite e runtimes Linux das engines.
**Especificação:** pedido do usuário nesta data e decisões deste documento. Executar por entregas pequenas, com revisão e evidência antes de declarar suporte.

## Decisão recomendada

Começar com **Docker Compose e Linux amd64**, um scan simultâneo e suporte às três engines pelas rotas HTTP existentes: Codex Security Portable, Mantis HTTP e VulnHunter HTTP. Após implementar o vault da etapa 3, isso entrega o fluxo principal sem depender do chaveiro ou de uma sessão desktop do host. Hoje essas rotas ainda dependem do vault nativo.

O produto continua self-hosted e single-instance. Uma instalação pode atender uma equipe de confiança com credencial administrativa compartilhada; ela não separa usuários, projetos ou clientes entre si. Não adicionar PostgreSQL, Redis, Kubernetes, cobrança ou multi-tenant neste trabalho.

Docker padroniza instalação e isolamento. **Os processos dos scanners continuam consumindo CPU, RAM e disco da máquina onde o container roda**, mesmo quando a inferência usa um provedor remoto. Não estimar capacidade pelo preço da VPS ou pelo número de tokens.

**Esforço estimado:** 48–80 horas de engenharia para a primeira versão suportada, aproximadamente 6–10 dias de trabalho concentrado. Um protótipo que apenas abre a interface pode sair em 1–2 dias, mas não comprova scans, persistência, credenciais e segurança. Native Codex/Claude, arm64 e migração assistida da instalação desktop são extensões separadas, estimadas em mais 24–48 horas. São estimativas, não medições ou prazo contratado.

## Restrições globais

- Preservar o modo local atual e os dados existentes; a migração para Docker deve ser opt-in.
- Não executar scans pagos durante build, healthcheck ou testes de CI.
- Servidor exige autenticação global, origem explícita e vault adequado a ambiente sem desktop.
- Uma réplica por volume SQLite; sem compartilhamento concorrente entre containers ou armazenamento NFS.
- Não montar Docker socket, home completo do host ou credenciais do macOS.
- Imagem sem `.git`, dados, relatórios temporários, Playwright/Chromium ou dependências copiadas do Mac.
- Manter a interface nos cinco idiomas atuais: pt-BR, en, es, de e fr.
- Novas variáveis, arquivos e endpoints abaixo são **propostos**; não estão disponíveis no código auditado.

## O que impede o uso hoje

| Fato confirmado no código | Consequência | Mudança necessária |
| --- | --- | --- |
| [`api-host.ts:3`](../../apps/api/src/api-host.ts) permite apenas loopback; [`app.ts:131`](../../apps/api/src/app.ts) não tem autenticação global | Só liberar `0.0.0.0` exporia o controle dos scanners | Modo servidor autenticado e same-origin |
| [`system-credential-vault.ts:199`](../../apps/api/src/credentials/system-credential-vault.ts) usa keytar; GitHub App e xAI também têm stores nativos | Container headless não dispõe automaticamente de um keyring desbloqueado | Backend criptografado com chave externa ao volume |
| [`apps/api/package.json`](../../apps/api/package.json) executa TypeScript via `tsx`; build é `tsc --noEmit` | `pnpm build` não produz um `dist/index.js` executável | Empacotar runtime TS explicitamente e buildar o frontend |
| [`fs.ts:6`](../../apps/api/src/fs.ts) e [`runner.ts:590`](../../apps/api/src/runner.ts) aceitam caminhos disponíveis no host | Exposição indevida de arquivos montados | Raízes de repositórios validadas no servidor |
| [`runner.ts:832`](../../apps/api/src/runner.ts) destaca processos; [`index.ts`](../../apps/api/src/index.ts) não coordena SIGTERM | Troca de container pode interromper scans sem conclusão limpa | Drain, cancelamento e recuperação de estado |
| [`engine-updates-api.ts:21`](../../apps/api/src/engine-updates-api.ts) exige host local | Updater atual rejeitaria o domínio do Dokploy | Reutilizar política autenticada de origem |
| [`manifest-flow.ts:214`](../../apps/api/src/github-app/manifest-flow.ts) exige origem local | GitHub App não funciona diretamente no domínio remoto | Callback HTTPS e state persistente de uso único |

## Arquitetura e acesso aos repositórios

```text
Navegador ── HTTPS ── Traefik do Dokploy
                         │ rede interna, porta 8787
                 Sentinel, uma réplica
                 ├─ autenticação administrativa
                 ├─ interface compilada + /api + SSE
                 ├─ orquestrador → processos das engines → provedor HTTP
                 ├─ /repos/projeto                    somente leitura
                 └─ /var/lib/sentinel                 volume persistente
                    ├─ data/                         SQLite, runs, gates, updater
                    ├─ home/                         HOME privado
                    ├─ codex-security-state/
                    └─ codex-home/                   quando Native for habilitado

/run/secrets/admin_password e /run/secrets/vault_key   arquivos externos ao volume
```

No Docker Desktop, o usuário monta um repositório do próprio computador. No Dokploy, o repositório precisa existir **na máquina do Docker** ou ser materializado pelas integrações GitHub já existentes. O navegador de pastas não acessará o Mac de quem abriu a página. Essa é uma restrição dos [bind mounts do Docker](https://docs.docker.com/engine/storage/bind-mounts/).

Adotar `/repos` para mounts externos autorizados e um diretório privado para materializações gerenciadas. A mesma validação deve proteger navegação de arquivos, criação de scans e Guardrails, incluindo `realpath`, symlinks e verificação de pertencimento por segmentos de caminho. Materializações internas só podem ser acessadas pelos fluxos que as criam; não liberar todo o diretório de dados como repositório.

Scans usam mounts somente leitura e snapshots graváveis privados. Guardrails que alteram workflows ou políticas locais exigem um checkout explicitamente gravável e ação autorizada. Um worktree com `.git` apontando para um caminho do host pode não funcionar com um único mount: documentar clone independente como caminho padrão e testar worktrees antes de anunciá-los como compatíveis. Evitar `safe.directory=*`; quando necessário, autorizar apenas o caminho exato do checkout.

## Matriz de suporte planejada

| Recurso | Primeira versão | Condição de aceite |
| --- | --- | --- |
| Codex Security Portable, Mantis HTTP, VulnHunter HTTP | Incluído | Contratos de tools/artefatos, cancelamento e persistência testados; combinação engine/provedor continua sujeita ao probe existente |
| Providers com API key | Incluído | Credenciais no vault do servidor; nenhuma chave em imagem ou logs |
| Relatórios, comparação, telemetria e updater | Incluído | Fluxo visual completo atrás de HTTPS e autenticação, inclusive SSE; instalação/rollback gerenciado cobre Codex Security e Codex CLI. Mantis/VulnHunter mantêm consulta de versão/proveniência e atualização da metodologia pelo projeto |
| Guardrails e GitHub App | Incluído com adaptação | Origem pública, callback, state, materialização e escrita explicitamente autorizada |
| Codex Security Native e VulnHunter Native | Segunda etapa | CLI Linux e autenticação próprios do container; isolamento comprovado sem `privileged` |
| Mantis via Claude Code local | Segunda etapa | Sessão headless própria, licença/autenticação do CLI e permissões verificadas |
| Detecção de sessões desktop do host | Não aplicável | Mostrar motivo claro; não oferecer conexão impossível de usar no servidor |
| Cursor background | Fora do escopo | O código atual já não conecta essa rota ao scanner; Docker não adiciona essa integração |
| Linux arm64 / Apple Silicon nativo | Segunda etapa | Build e execução em Linux arm64 real; emulação amd64 não equivale a suporte validado |
| Migração automática do histórico e credenciais do Mac | Segunda etapa | Caminhos absolutos e formatos de runtime exigem tratamento; manter instalação original intacta |

Suporte de protocolo HTTP no código não significa que todo modelo funciona em toda engine. Preservar os bloqueios de capacidade e testar a combinação escolhida. Não relaxar validação de artefatos para fazer um scan parecer concluído.

## Etapas de implementação

### 1. Empacotamento e servidor de produção — 8–12 h

**Arquivos:** criar `Dockerfile`, `.dockerignore`, `apps/api/src/server-app.ts` e `apps/api/src/server-app.test.ts`; ajustar `apps/api/package.json`, `pnpm-lock.yaml`, `apps/api/src/index.ts` e `apps/api/src/config.ts`.

- [ ] Construir frontend e dependências em estágio Linux Node 24 Debian slim; fixar patch/digest da base e versões de ferramentas na implementação. Debian/glibc reduz diferenças com addons nativos; [Node Docker](https://github.com/nodejs/docker-node/blob/main/README.md) documenta a diferença de libc do Alpine.
- [ ] Manter `tsx` como dependência de runtime nesta primeira entrega e preservar entrypoints dos workers/MCP e pacotes workspace que exportam `src`. Usar cópia explícita, sem testes e ferramentas de desenvolvimento na imagem final. Não fazer uma refatoração geral para bundling.
- [ ] Compilar `better-sqlite3` para Linux; manter ferramentas de compilação no builder. Incluir bibliotecas de runtime necessárias a imports existentes, mesmo quando keytar não for o backend ativo. Git, Python, certificados, busca de texto e utilitários efetivamente usados pelos processos devem constar do inventário da imagem; `gh` entra para os fluxos GitHub que o requerem.
- [ ] Servir frontend compilado em `/` e API sob `/api` no mesmo processo. Preservar Vite local. Fallback SPA não pode interceptar erros de `/api`, downloads ou SSE.
- [ ] Adicionar `/healthz` mínimo e `/readyz` para migrações concluídas/admissão de trabalho. Não reaproveitar `/health` como probe: ele consulta engines e expõe diagnóstico. Healthchecks não executam CLI nem chamam modelo.
- [ ] Fornecer SHA imutável do Sentinel em `CSB_GITHUB_ACTIONS_WORKFLOW_SHA` no build/configuração para workflows GitHub que hoje dependem do checkout `.git`.

**Aceite:** imagem inicia como UID/GID não-root documentado; abre rota profunda da interface, responde API, transmite SSE sem buffering e não contém dados locais. CLI e arquivos de workers são resolvidos a partir da imagem. Primeira inicialização tolera backfill de histórico sem ciclo de restart artificial.

### 2. Acesso remoto e proteção de caminhos — 10–16 h

**Arquivos:** criar `apps/api/src/server-security.ts`, `apps/api/src/server-security.test.ts`, `apps/api/src/repository-access.ts` e `apps/api/src/repository-access.test.ts`; ajustar `server-app.ts`, `api-host.ts`, `config.ts`, `app.ts`, `connections-api.ts`, `engine-updates-api.ts`, `fs.ts`, `runner.ts`, `gate-orchestrator.ts` e `apps/web/src/api.ts`.

- [ ] Introduzir `CSB_RUNTIME_MODE=local|server`, `CSB_PUBLIC_ORIGIN`, `CSB_ADMIN_PASSWORD_FILE` e `CSB_REPOSITORY_ROOTS`. O modo local conserva suas restrições; servidor sem segredo/origem válida recusa inicialização.
- [ ] Adotar inicialmente HTTP Basic Auth administrativo **dentro da aplicação**, com usuário configurável, senha longa lida de arquivo, comparação segura e limitação de tentativas. Aplicar no `server-app.ts` antes de rotear estáticos ou API; proteger interface, API, SSE e artefatos, exceto probes mínimos. HTTPS é obrigatório para domínio remoto; HTTP é permitido apenas na URL loopback do Compose local. O login do painel Dokploy não protege automaticamente a aplicação publicada.
- [ ] Centralizar proteção das mutações: autenticação + origem exata + token CSRF. Emitir token autenticado em `/api/security-session` com `Cache-Control: no-store`, substituindo os tokens/guards separados de connections e updater. Cliente o usa também em scans, Guardrails e GitHub App. GETs que hoje disparam refresh com efeito persistente/remoto devem virar POST protegido ou receber a mesma checagem de origem. Não confiar em CORS ou em headers encaminhados pelo proxy como autenticação.
- [ ] Validar destinos contra raízes configuradas e mounts somente leitura. Negar `/`, diretório de segredos, dados privados, symlinks externos e prefixos parecidos com a raiz permitida. O seletor de pastas deve dizer “Repositórios no servidor” quando aplicável.

**Aceite:** chamadas anônimas não leem scans/credenciais/arquivos; mutações cross-origin ou sem CSRF retornam 403; updater funciona apenas no domínio autenticado; acesso fora de `/repos` é negado por todas as entradas. Testar navegação, downloads e reconexão SSE usando a autenticação real, sem headers especiais de teste.

### 3. Credenciais e GitHub sem desktop — 8–12 h

**Arquivos:** criar `apps/api/src/credentials/encrypted-secret-store.ts` e seu teste; ajustar `credentials/credential-vault.ts`, `credentials/system-credential-vault.ts`, `credentials/system-github-app-credential-store.ts`, `credentials/system-xai-oauth-credential-store.ts`, `provider-runtime.ts`, `github-app-api.ts`, `github-app/manifest-flow.ts`, `github-app/github-app-store.ts` e contratos compartilhados de disponibilidade do vault.

- [ ] Criar armazenamento criptografado autenticado com `node:crypto` (AES-256-GCM, nonce aleatório por escrita, versão do formato e namespace/ref autenticados). Gravar por troca atômica, com permissões privadas, usando `CSB_VAULT_KEY_FILE` externo ao volume. Não inventar algoritmo nem gravar credenciais em claro no SQLite.
- [ ] Usar adapters sobre o mesmo store para API keys, OAuth xAI e chave de GitHub App; manter keytar para execução desktop. Registrar todos os segredos no redator já existente. Chave ausente, errada, conteúdo adulterado ou indisponibilidade de escrita devem produzir erro explícito e impedir uso do segredo.
- [ ] Aceitar origem HTTPS configurada no fluxo de GitHub App; usar base de API `/api` no servidor para derivar `/api/guardrails/github-app/manifest/authorize` e `/api/guardrails/github-app/manifest/callback`, preservando as rotas locais. Persistir state com expiração e consumo único. Callback não exige CSRF de mutação, mas mantém autenticação administrativa e valida state. Não criar exceção ampla para rotas GitHub.
- [ ] Atualizar interface e traduções para indicar backend do servidor e explicar que sessões do desktop não são compartilhadas. OAuth que exigir aplicativo desktop deve ser mostrado como indisponível; só habilitar fluxos comprovados por URL/código ou callback remoto.

**Aceite:** conexões sobrevivem a recriação do container; banco, logs e `docker inspect` não revelam valores de credenciais; chave errada e ciphertext alterado falham; GitHub state sobrevive a reinício, expira e rejeita replay. Não prometer criptografia em repouso dos arquivos de autenticação gerados pelos próprios CLIs: eles precisam de volume e backup privados.

### 4. Engines, updater e encerramento — 8–14 h

**Arquivos:** ajustar `config.ts`, `index.ts`, `server-app.ts`, `db.ts`, `runner.ts`, `scanners/launch.ts`, `scanners/engine-updates.ts`, `scanners/managed-runtime-store.ts` e testes correspondentes; criar `apps/api/src/shutdown.ts` e `apps/api/src/shutdown.test.ts`.

- [ ] Padronizar `CSB_DATA_DIR`, `HOME`, `CODEX_HOME`, `CODEX_SECURITY_STATE_DIR`, cache e `TMPDIR=/var/lib/sentinel/tmp` dentro do volume. Inicializar diretórios com o UID correto; limpar temporários próprios concluídos, sem apagar evidências. Evitar tmpfs ilimitado para snapshots grandes.
- [ ] Preservar instalações privadas e rollback do updater entre redeploys. Fornecer fallback Linux versionado na imagem e mudar a resolução para: override externo explícito → manifesto gerenciado válido → runtime da imagem → fallback de desenvolvimento apenas no modo local. O runtime empacotado não deve ser tratado como override externo; assim o updater pode ativar uma versão privada no volume. No servidor, ausência dos runtimes exigidos deve falhar claramente, sem download de `latest` durante um scan. Não definir `CODEX_BIN`/`CODEX_SECURITY_BIN` no template.
- [ ] Começar com `CSB_MAX_CONCURRENT_SCANS=1`, permitir ajuste explícito e medir CPU/RSS/disco antes de recomendar aumento. Controlar concorrência também durante instalação de engines e materialização de repositórios.
- [ ] Implementar drain: conservar handle HTTP de `serve()`, recusar novos scans e instalações, marcar readiness falsa, fechar SSE/intervalos, finalizar/cancelar filhos com os mecanismos de identidade existentes, persistir estado incompleto/cancelado e então fechar servidor e SQLite por operação explícita em `db.ts`. `init: true` cuida da coleta de processos; `stop_grace_period: 90s` é a janela inicial proposta.
- [ ] No reinício após SIGKILL/OOM, reconciliar trabalhos sem processo como interrompidos; preservar artefatos e consumo registrado. Não relançar automaticamente uma execução que gere cobrança, nem apresentar falha como “0 vulnerabilidades” bem-sucedido.

**Aceite:** parar e recriar container preserva histórico; processos encerram dentro da janela; nenhuma execução é duplicada; updater bloqueia com scan ativo e mantém versão após restart. Testar processo filho longo controlado, falha de instalação, SIGTERM e SIGKILL sem usar um modelo real.

### 5. Compose, operação e documentação Dokploy — 6–10 h

**Arquivos:** criar `compose.yaml`, `compose.local.yaml`, `.env.example`, `docs/docker.md`, `docs/dokploy.md`, `scripts/docker/init-volume.mjs` e `scripts/docker/healthcheck.mjs`; ajustar `README.md`.

- [ ] Entregar Compose base sem porta pública, volume nomeado, segredos por arquivo, usuário não-root, `init`, healthcheck e encerramento. Um job efêmero `volume-init` prepara somente os diretórios fixos do volume com UID/GID 1000 e permissões privadas, antes de iniciar a aplicação; não faz `chown` recursivo de dados preexistentes. Root filesystem somente leitura se os contratos das engines passarem; trabalho e `TMPDIR` ficam no volume. Não usar `privileged`, host networking ou Docker socket para contornar falhas de sandbox.
- [ ] Entregar override local com porta presa a `127.0.0.1`, origem local e mount do repositório. Documentar criação de arquivos de segredos fora do checkout e permissões de leitura pelo UID do container, sem imprimi-los.
- [ ] Documentar Dokploy em modo Docker Compose: selecionar repositório/arquivo, configurar variáveis referenciadas, mounts e segredos; apontar domínio HTTPS para serviço `sentinel`, porta 8787; conferir Preview Compose e fazer deploy. O template base pode ser buildado no servidor; imagem versionada pré-construída é melhoria de distribuição posterior.
- [ ] Manter estado em volume nomeado fora do checkout recriado pelo Dokploy. Usar backup de volume com container parado, após drain/janela sem scans; guardar chave do vault separadamente e executar restauração em volume novo. Backup agendado que pare um scan também o interrompe: explicitar a janela operacional.
- [ ] Documentar atualização manual da imagem somente sem scans ativos; rollback de imagem exige compatibilidade com o esquema do banco ou restauração do backup correspondente. Rollback do CLI pelo updater é operação distinta.

**Aceite:** seguir os dois guias a partir de ambiente limpo sem conhecimento do checkout de desenvolvimento. Um redeploy preserva dados, conexões e versão gerenciada; backup restaurado abre relatórios e usa vault corretamente. Não depender de nomes de volume compartilhados globalmente entre instalações.

### 6. QA e liberação de suporte — 8–16 h

**Arquivos:** criar `scripts/docker/smoke.mjs`, `apps/web/e2e/docker-server.spec.ts` e `.github/workflows/docker.yml`; ajustar scripts de verificação quando necessário.

- [ ] Executar higiene, typecheck, testes e build do monorepo; construir a imagem no CI Linux amd64 e verificar addons nativos/entrypoints.
- [ ] Cobrir por UI autenticação, conexão, seletor de repositório, criação de scan, fases, cancelamento, relatório, comparação, updater e persistência. Usar API real e provider/CLI controlados nos testes; fixtures precisam produzir artefatos válidos e achados conhecidos, não apenas respostas vazias.
- [ ] Testar com domínio HTTPS pelo Dokploy: acesso anônimo, CSRF, SSE, download, rota profunda, restart, backup/restore, permissões de volume e disco cheio. Não converter falhas parciais em sucesso para cumprir o gate.
- [ ] Separar gate sem custo do ensaio real: após implementação, combinar explicitamente uma execução pequena com orçamento limitado e credencial do operador por rota anunciada. Se esse ensaio não ocorrer, registrar a rota como validada por contrato, com validação real pendente.
- [ ] Medir um checkout pequeno e outro representativo: pico de RSS, CPU, disco temporário, duração e consumo do provedor. Definir recomendação de capacidade a partir disso; 2 vCPU/8 GB é uma hipótese de teste, não mínimo garantido nem capacidade comercial.

**Aceite:** evidências frescas dos fluxos acima; nenhuma regressão no modo local. Divulgar amd64, versões testadas e limitações reais. Uma página abrindo, build verde ou teste com provedor simulado isoladamente não comprova o produto funcionando de ponta a ponta.

## Contrato proposto de configuração

```yaml
# Exemplo de destino arquitetural; exige implementar as etapas acima.
# Os caminhos ${...} apontam para arquivos preparados pelo operador,
# fora do repositório. Não colocar valores de segredos no YAML.
services:
  volume-init:
    build: .
    user: "0:0"
    restart: "no"
    command: ["node", "/app/scripts/docker/init-volume.mjs"]
    volumes:
      - sentinel_data:/var/lib/sentinel
  sentinel:
    build: .
    depends_on:
      volume-init:
        condition: service_completed_successfully
    init: true
    user: "1000:1000"
    restart: unless-stopped
    stop_grace_period: 90s
    expose: ["8787"]
    environment:
      NODE_ENV: production
      CSB_RUNTIME_MODE: server
      CSB_HOST: 0.0.0.0
      CSB_PORT: "8787"
      CSB_PUBLIC_ORIGIN: ${CSB_PUBLIC_ORIGIN:?Defina a origem}
      CSB_ADMIN_USER: admin
      CSB_ADMIN_PASSWORD_FILE: /run/secrets/admin_password
      CSB_VAULT_KEY_FILE: /run/secrets/vault_key
      CSB_DATA_DIR: /var/lib/sentinel/data
      CSB_REPOSITORY_ROOTS: /repos
      CSB_MAX_CONCURRENT_SCANS: "1"
      HOME: /var/lib/sentinel/home
      TMPDIR: /var/lib/sentinel/tmp
      CODEX_HOME: /var/lib/sentinel/codex-home
      CODEX_SECURITY_STATE_DIR: /var/lib/sentinel/codex-security-state
    volumes:
      - sentinel_data:/var/lib/sentinel
    secrets: [admin_password, vault_key]
    healthcheck:
      test: ["CMD", "node", "/app/scripts/docker/healthcheck.mjs"]
      interval: 30s
      timeout: 5s
      start_period: 120s
      retries: 3
volumes:
  sentinel_data:
secrets:
  admin_password:
    file: ${CSB_ADMIN_PASSWORD_PATH:?Defina o arquivo externo}
  vault_key:
    file: ${CSB_VAULT_KEY_PATH:?Defina o arquivo externo}
```

O job de inicialização encerra antes de a aplicação iniciar: permanece apenas um container de aplicação em execução. Arquivos de secrets também precisam ser legíveis pelo UID 1000; o job não recebe esses segredos. O override local acrescenta `ports: ["127.0.0.1:8787:8787"]` e um bind do checkout autorizado em `/repos/projeto` com `read_only: true` e `bind.create_host_path: false`. No Dokploy, montar o checkout existente no servidor pelo mecanismo documentado de mounts; nenhuma pasta do computador do visitante é transferida automaticamente. O contrato final incluirá os limites de recursos definidos pelo ensaio, o inventário dos diretórios graváveis e as restrições de capabilities que passarem nos testes das rotas suportadas.

Os secrets do Compose são arquivos montados em `/run/secrets`; `_FILE` é uma convenção que a aplicação precisa implementar, não uma função automática do Docker. Essa montagem não substitui proteção do arquivo no host. Fonte: [Docker Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/).

No Dokploy, variáveis da interface precisam ser referenciadas no Compose; seu arquivo `.env` não injeta automaticamente todas elas no container. A configuração de domínio para Compose adiciona integração com Traefik e exige redeploy. Fontes: [Dokploy Compose](https://docs.dokploy.com/docs/core/docker-compose), [domínios de Compose](https://docs.dokploy.com/docs/core/docker-compose/domains).

O recurso de backup do Dokploy cobre volumes nomeados, não bind mounts; há opção de desligar o container durante o backup. A proposta usa essa opção em janela sem scans, com restauração verificada. Fonte: [Dokploy Volume Backups](https://docs.dokploy.com/docs/core/volume-backups).

## Ordem, entrega e limite de conclusão

Executar 1 → 2 → 3 → 4 → 5 → 6. Partes de vault e empacotamento podem avançar em paralelo com escritores separados; integração de autenticação, origem, paths e cliente deve ter um responsável para evitar políticas divergentes.

Ao fim de cada etapa, registrar arquivos alterados, testes relevantes, limitações e commit. Não criar várias cópias de planos concluídos: manter decisões arquiteturais úteis aqui e detalhes de execução no histórico Git.

**Primeiro marco:** container local em funcionamento, sem exposição externa. **Marco de entrega:** aplicação no Dokploy com domínio autenticado, três rotas HTTP testadas, updater, dados preservados e restauração demonstrada. **Marco posterior:** Native e arm64, somente após os respectivos contratos e ensaios reais.

Este planejamento não executou Docker build, implantação, autenticação em provedor ou scans. A auditoria foi estática, com dois subagentes independentes e consulta à documentação oficial; os critérios acima são trabalho futuro, não resultados já obtidos.
