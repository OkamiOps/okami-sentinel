# Princípios do produto

[English](PRODUCT.md) · [Português (Brasil)](PRODUCT.pt-BR.md) · [Deutsch](PRODUCT.de.md) · [Français](PRODUCT.fr.md)

<!-- impeccable:product-schema 1 -->

## Plataforma

Aplicação web com API local.

## Usuários

Desenvolvedores, profissionais de DevSecOps, revisores de segurança e AI Engineers usam o produto individualmente para operar scans e em equipe para revisar evidência, custo e eficiência técnica.

## Propósito do produto

O OKAMI Sentinel é um workbench local para iniciar scans do `@openai/codex-security`, acompanhar execução, inspecionar findings, medir custo estimado e comparar combinações de modelo e effort. Sucesso significa localizar risco relevante com contexto suficiente para agir e entender o custo de cada estratégia.

## Posicionamento

O produto cruza evidência de segurança com telemetria de execução. Findings, severidade, modelo, effort, duração, tokens e custo estimado convivem no mesmo fluxo comparável.

## Contexto operacional

O uso acontece durante desenvolvimento e revisão de segurança contra repositórios locais. Scans podem ser longos, parciais ou caros; resultados precisam permanecer legíveis durante e depois da execução. O fluxo principal é visão → novo scan → atividade/detalhe → comparação → relatório.

## Capabilities e limites

- Interface React/Vite local, API Hono e metadados espelhados em SQLite.
- Scans compatíveis existentes são indexados do state do Codex Security.
- A interface suporta PT-BR, inglês, espanhol, alemão e francês; o locale é detectado e a preferência persiste localmente.
- Comparações aceitam um baseline e até cinco candidatos.
- Scans interrompidos que preservaram findings continuam disponíveis como resultados parciais claramente identificados.
- Relatórios individuais e comparativos reutilizam a leitura de evidência, custo e eficiência do produto e podem ser impressos ou exportados em PDF.
- Custos são estimativas baseadas em tokens, não cobrança confirmada.
- High por dólar é heurística, não prova de precisão.
- Evidência do scanner permanece no idioma de origem para preservar o significado técnico.
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
