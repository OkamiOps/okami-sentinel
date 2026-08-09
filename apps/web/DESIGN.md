---
name: Codex Security Benchmark / Test Bench
description: Dark security instrumentation workspace built around evidence channels
colors:
  canvas: "#090c0b"
  machine: "#101412"
  alloy: "#171c1a"
  edge: "#2b332f"
  ink: "#edf0eb"
  signal-copper: "#e8a15e"
  evidence-seafoam: "#70cdbd"
  attention-straw: "#d6bd76"
  risk-coral: "#ed6a62"
  context-blue: "#73aeca"
typography:
  display: "Manrope Variable"
  body: "Geist Variable"
  telemetry: "JetBrains Mono Variable"
geometry:
  radius: "2px"
  border: "1px"
---

# Design system: Test Bench

## North star

O produto é uma bancada de benchmark, não um painel SaaS. A interface organiza o trabalho como canais, sinais, traces, patch bays, manifests e inspectors. As referências foram traduzidas em cinco padrões recorrentes: heatmaps densos, workspaces multipainel, listas operacionais, command bars persistentes e readouts de instrumento.

## Assinatura

O **Evidence Spectrum** é o elemento proprietário. Cada run vira um canal e cada canal recebe uma faixa normalizada de severidade. A faixa permite comparar distribuição, volume, custo e estado sem abrir uma coleção de cards ou recorrer a um donut.

## Shell

- Barra horizontal compacta; nenhuma sidebar.
- Módulos numerados e estado do motor no mesmo barramento.
- Seletor de idioma compacto no barramento superior, com o nome nativo de cada idioma e estado selecionado explícito.
- Command deck persistente na base para lançar ou retornar ao processo ativo.
- Canvas quase preto com grid estrutural discreto.
- Painéis conectados por bordas; raio de 2px apenas onde a primitive exige.

## Cor

- Copper: comando, custo e seleção ativa.
- Seafoam: evidência, conclusão e eficiência.
- Coral: critical/high e falha.
- Straw: medium e amostras neutras.
- Blue: low/contexto.

Cor nunca carrega significado sozinha; status e severidade sempre têm label textual.

## Rotas

- **Visão:** channel index + Evidence Spectrum + sample readout + trace custo × evidência.
- **Runs:** ledger denso; cancelados e falhos ficam fora do recorte corrente por padrão.
- **Operar:** sequenciador conectado de target, strategy e authorization.
- **Comparar:** sample library + patch bay + efficiency plane + truth table; nenhum radar.
- **Relatórios:** leitura editorial para impressão/PDF, com marca Okami Sentinel, resumo executivo, métricas comparáveis e detalhe de findings sem transformar o documento em um índice de dezenas de páginas.
- **Atividade:** live bus e event trace contínuo.
- **Detalhe:** header de canal + evidence index/list/inspector em três painéis.
- **Sistema:** engine matrix, capacity envelope e operação de índice.

## Component policy

Shadcn fornece primitives de ação, input, sheet e infraestrutura. DaisyUI fornece controles de formulário, tabelas e loaders. Recharts desenha os traces e planos comparativos. CSS próprio fica restrito a tokens, grid do canvas e composições específicas do produto; não recria buttons, inputs, sheets ou tabelas.

## Regras

1. Nenhuma rota começa com quatro KPIs em cards.
2. Nenhuma informação decorativa compete com o sinal operacional.
3. Valores financeiros exibem USD explicitamente.
4. Gráficos precisam expor valores absolutos ou sua regra de normalização.
5. Conteúdo largo usa overflow local; o documento nunca cria scroll horizontal.
6. Mobile empilha módulos mantendo a ordem da decisão.
7. Movimento respeita `prefers-reduced-motion`.
8. Componentes precisam acomodar alemão e francês sem truncar ações essenciais; textos auxiliares podem quebrar linha, mas controles não podem se sobrepor.
9. Datas e números seguem o locale ativo, enquanto USD e os códigos técnicos do scanner permanecem explícitos.
10. Evidência de scanner não é traduzida automaticamente: fidelidade técnica tem prioridade sobre uniformidade editorial.
