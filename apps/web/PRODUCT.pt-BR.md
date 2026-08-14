# Princípios do produto

[English](PRODUCT.md) · [Português (Brasil)](PRODUCT.pt-BR.md) · [Deutsch](PRODUCT.de.md) · [Français](PRODUCT.fr.md)

<!-- impeccable:product-schema 1 -->

## Plataforma

Aplicação web com API local.

## Usuários

Desenvolvedores, profissionais de DevSecOps, revisores de segurança e AI Engineers usam o produto individualmente para operar scans e em equipe para revisar evidência, custo e eficiência técnica.

## Propósito do produto

O OKAMI Sentinel é um workbench local para executar scans de Codex Security, Google Mantis e Capital One VulnHunter; acompanhar execução; inspecionar findings; medir custo estimado; e comparar combinações de modelo e effort. O Codex Security resolve antes do lançamento o contrato upstream Native ou o perfil defensivo Portable mantido pelo Sentinel. Sucesso significa localizar risco relevante com contexto suficiente para agir e entender custo e limite de execução de cada estratégia.

## Posicionamento

O produto cruza evidência de segurança com telemetria de execução. Findings, severidade, modelo, effort, duração, tokens e custo estimado convivem no mesmo fluxo comparável.

## Contexto operacional

O uso acontece durante desenvolvimento e revisão de segurança contra checkouts locais ou repositórios GitHub explicitamente autorizados. Scans podem ser longos, parciais ou caros; resultados precisam permanecer legíveis durante e depois da execução. O fluxo principal é visão → novo scan → atividade/detalhe → comparação → relatório.

## Capabilities e limites

- Interface React/Vite local, API Hono e metadados espelhados em SQLite.
- Guardrails aceita duas autoridades explícitas de repositório: checkout local ou instalação privada do GitHub App. Alvos remotos precisam resolver SHAs imutáveis de base/head antes de executar; `HEAD` remoto implícito e fallback silencioso para estado local são proibidos.
- Um gate remoto roda em snapshot imutável gerenciado pelo Sentinel ou em caller GitHub Actions do próprio repositório, fixado em um SHA completo de release. O Sentinel pode instalar ou atualizar esse caller pela GitHub App autorizada e persiste no próprio workflow os gatilhos de push, pull request e pós-merge escolhidos pelo usuário. A policy remota continua somente leitura; somente o workflow publica GitHub Checks.
- Scans compatíveis existentes são indexados do state local configurado dos scanners e das saídas gerenciadas pelo Sentinel.
- Motor, conexão, protocolo, perfil de execução e seleção de modelo são resolvidos e fixados antes do lançamento. O scan fixa um modelo do catálogo ao vivo ou, somente quando o adapter declara, um default de runtime explícito. Uma tupla que exige capability probe não fica elegível até a probe nova e correspondente passar; o Sentinel nunca faz fallback silencioso para outra rota, modelo ou perfil.
- Modelos e opções de esforço de raciocínio vêm do catálogo do runtime/provider selecionado. Quando o provider não publica metadados de esforço, o Sentinel deixa o esforço gerenciado pelo provider em vez de inventar opções.
- A interface suporta PT-BR, inglês, espanhol, alemão e francês; o locale é detectado e a preferência persiste localmente.
- Comparações aceitam um baseline e até cinco candidatos.
- Scans interrompidos que preservaram findings continuam disponíveis como resultados parciais claramente identificados.
- O Portable mantém um dossiê controlado pelo servidor e emite páginas de report somente com findings, cada uma com no máximo 16 candidatos confirmados. Essas páginas internas e privadas são validadas e consolidadas em um único relatório final; candidatos rejeitados e sua cobertura são derivados pelo servidor. No envelope máximo, são suportadas até 32 páginas e 512 findings normalizados. Se uma página, sua cobertura, seus anchors ou a normalização final falharem, nenhum relatório final parcial é publicado.
- O Deep Portable enumera e particiona por conta própria os arquivos auditáveis de código-fonte e configuração de segurança do snapshot imutável. A descoberta só termina depois que cada arquivo atribuído foi lido por completo; ela nunca depende de um Standard nem publica cobertura Deep parcial. Todos os grupos de effort Deep compartilham um único deadline de 90 minutos, enquanto os envelopes de turnos e ferramentas escalam de 48/384 até 128/1.024.
- Quando um artefato terminal falha na validação, o Portable permite apenas uma pequena janela de reparo limitada, dentro dos limites globais existentes de turnos, ferramentas, tempo e custo configurado do scan.
- Scans standard e deep classificam somente findings da execução atual como `new`, `persisting` ou `regressed` contra um baseline compatível da mesma linhagem. A ausência de um finding não é remediação; `fixed` permanece reservado para um contrato incremental explícito futuro.
- Relatórios individuais e comparativos reutilizam a leitura de evidência, custo e eficiência do produto e podem ser impressos ou exportados em PDF.
- O custo só aparece quando há usage reportado e preço correspondente disponível; caso contrário fica indisponível, nunca zero inventado ou fatura de assinatura. O teto opcional em USD do Portable usa usage reportado e cotação correspondente congelada: ele bloqueia a próxima request depois de atingido, mas uma request já em voo pode levar a estimativa além dele.
- High por dólar é heurística, não prova de precisão.
- Evidência do scanner permanece no idioma de origem para preservar o significado técnico.
- O ledger de runs exibe identidade do motor e do modelo, além de High+ e total de findings, para que a linha seja compreendida sem abrir o detalhe.
- Apenas scans terminalizados podem ser removidos explicitamente após confirmação. O Sentinel remove o registro local e, quando aplicável, seus artefatos gerenciados; nunca o repositório analisado nem caminhos externos.
- Desktop, mobile, teclado, foco visível e reduced motion são requisitos.

## Compromissos de marca

O produto preserva o nome OKAMI Sentinel e sua natureza de benchmark técnico de segurança. O tema principal é dark. A interface deve evitar padrões de SaaS genérico e operar como instrumento de segurança, sem copiar produtos ou inventar claims.

## Evidência disponível

- Metadados, métricas e findings reais expostos pela API local.
- Referências visuais fornecidas durante o redesign de agosto de 2026.
- Identidade OKAMI Sentinel fornecida para o produto e relatórios; nenhuma variação ou claim comercial não aprovado.

## Princípios

- Mostrar sinal antes de decoração.
- Manter risco e custo legíveis na mesma decisão.
- Separar estado operacional, evidência e estimativa.
- Permitir leitura rápida e handoff claro para o time.
- Preservar dados brutos e tornar ações destrutivas explícitas.
- Nunca descrever evidência ausente como correção sem confirmação.

## Acessibilidade e inclusão

Contraste WCAG AA, navegação por teclado, labels que não dependem apenas de cor, alvos confortáveis, textos longos em alemão/francês e suporte a `prefers-reduced-motion` são requisitos.
