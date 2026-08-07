# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Desenvolvedores, profissionais de DevSecOps e AI Engineers usam o produto individualmente para operar scans e em equipe para revisar resultados, custo e eficiência técnica.

## Product Purpose

O Codex Security Benchmark é um console local para iniciar scans do `@openai/codex-security`, acompanhar execução, inspecionar findings, medir custo estimado e comparar combinações de modelo e effort. Sucesso significa localizar risco relevante com contexto suficiente para agir e entender o custo de cada estratégia de scan.

## Positioning

O produto cruza evidência de segurança com telemetria de execução: findings, severidade, modelo, effort, duração, tokens e custo estimado convivem no mesmo fluxo comparável.

## Operating Context

O uso acontece durante desenvolvimento e revisão de segurança, com repositórios locais, state do Codex Security, scans longos e resultados que precisam ser lidos tanto durante a execução quanto depois. O fluxo principal é dashboard → novo scan → atividade/detalhe → comparação.

## Capabilities and Constraints

- Interface React/Vite local com API Hono e dados espelhados em SQLite.
- O dashboard indexa scans existentes do state do Codex Security.
- Custos são estimativas de tokens e não valores de cobrança confirmados.
- Comparações de high por dólar são heurísticas, não prova absoluta de qualidade.
- O produto precisa continuar funcional em desktop e mobile, com teclado, foco visível e reduced motion.

## Brand Commitments

O nome Codex Security Benchmark e a natureza técnica do produto devem permanecer. O tema principal é dark. A identidade deve evitar a aparência de SaaS genérico e traduzir as referências fornecidas pelo usuário para um instrumento de segurança, sem copiar produtos ou inventar claims.

## Evidence on Hand

- Dados reais de scans, métricas e findings expostos pela API local.
- Referências visuais fornecidas pelo usuário em 6 de agosto de 2026.
- Nenhum logo proprietário ou benchmark comercial foi fornecido; não fabricar.

## Product Principles

- Mostrar sinal antes de decoração.
- Manter custo e risco legíveis na mesma decisão.
- Diferenciar estado operacional, evidência e estimativa.
- Permitir leitura rápida individual e explicação clara para o time.
- Preservar dados brutos e tornar ações destrutivas explícitas.

## Accessibility & Inclusion

Contraste WCAG AA, navegação por teclado, estados que não dependem apenas de cor, alvos confortáveis e respeito a `prefers-reduced-motion` são requisitos do produto.
