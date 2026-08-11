---
name: OKAMI Sentinel / Test Bench
description: Workspace dark de instrumentação de segurança organizado por canais de evidência
---

# Design system: Test Bench

[English](DESIGN.md) · [Português (Brasil)](DESIGN.pt-BR.md) · [Deutsch](DESIGN.de.md) · [Français](DESIGN.fr.md)

## North star

O produto é uma bancada de benchmark de segurança, não um dashboard SaaS. O trabalho se organiza como canais, sinais, traces, patch bays, manifests e inspectors. A linguagem visual usa heatmaps densos, workspaces multipainel, listas operacionais, command bars persistentes e readouts de instrumento.

## Assinatura

O **Evidence Spectrum** é o visual proprietário. Cada run vira um canal com faixa normalizada de severidade. A faixa compara distribuição, volume, custo e estado sem esconder evidência em grids de KPIs ou donuts decorativos.

## Shell

- Command bar horizontal compacta; nenhuma sidebar permanente.
- Módulos numerados e estado do motor no mesmo barramento.
- Seletor de idioma compacto com nomes nativos e seleção explícita.
- Command dock persistente na base para lançar ou retornar ao trabalho ativo.
- Canvas quase preto com grid estrutural discreto.
- Painéis conectados e raio de 2px apenas onde a primitive exige.

## Papéis das cores

- **Laranja:** comando, launch, confirmação destrutiva e ação primária.
- **Ciano:** evidência, seleção, foco e eficiência.
- **Magenta:** prioridade critical/high e divergência significativa.
- **Âmbar:** medium, warning e resultado parcial.
- **Verde:** concluído, pronto e estado operacional verificado.

Cor nunca carrega significado sozinha; status e severidade sempre têm label textual.

## Rotas

- **Visão:** índice de canais, Evidence Spectrum, sample readout e traces de custo/evidência.
- **Runs:** ledger denso com badges visíveis de motor e modelo, além de High+ e total de findings. Cancelados e falhos são filtrados deliberadamente; apenas runs terminalizados podem ser removidos após confirmação destrutiva, nunca destruídos silenciosamente.
- **Operar:** sequenciador conectado de target, strategy e authorization.
- **Comparar:** biblioteca de runs, baseline/candidatos, plano de eficiência, cockpit de decisão e diff.
- **Relatórios:** leitura editorial para print/PDF com identidade OKAMI, resumo executivo, métricas e detalhe limitado de findings.
- **Atividade:** live bus e event trace contínuo.
- **Detalhe:** header do canal, índice, lista, inspector, telemetria e perfil.
- **Guardrails:** portfolio de repositórios, pipeline, editor de política e Decision Graph.
- **Sistema:** engine matrix, capacity envelope, autenticação e operação do índice.

## Política de componentes

shadcn fornece primitives de ação, input, dropdown, sheet, dialog e infraestrutura. daisyUI fornece formulários, tabelas e loaders compatíveis. Recharts desenha traces e planos comparativos. CSS próprio fica restrito a tokens, grid do canvas, composição de impressão e layouts conectados específicos do produto.

## Regras

1. Nenhuma rota começa com quatro KPIs genéricos.
2. Decoração nunca compete com sinal operacional.
3. Valores financeiros exibem USD explicitamente.
4. Gráficos expõem valores absolutos ou a regra de normalização.
5. Conteúdo largo usa overflow local; a página não cria scroll horizontal global.
6. Mobile empilha módulos na ordem da decisão.
7. Movimento respeita `prefers-reduced-motion`.
8. Componentes acomodam alemão e francês sem cortar ações essenciais.
9. Datas e números seguem o locale; USD e códigos do scanner permanecem explícitos.
10. Evidência do scanner não é traduzida automaticamente.
11. Impressão é validada em PDF A4 real e não pode esconder overflow.
12. Falha operacional nunca recebe aparência de aprovação de segurança.
