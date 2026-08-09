# Contribuindo com o OKAMI Sentinel

[English](CONTRIBUTING.md) · [Português (Brasil)](CONTRIBUTING.pt-BR.md) · [Deutsch](CONTRIBUTING.de.md) · [Français](CONTRIBUTING.fr.md)

Obrigado por melhorar o OKAMI Sentinel. Toda contribuição deve preservar três propriedades: operação local-first, fidelidade da evidência e outcomes de segurança explícitos.

## Antes de começar

- Abra uma issue para mudanças grandes de comportamento, schema ou workflow.
- Mantenha o pull request focado; limpeza não relacionada deve ficar em outra mudança.
- Nunca faça commit de state do scanner, bancos, logs, credenciais, secrets ou caminhos pessoais.
- Findings gerados são entrada não confiável. Escape e limite esse conteúdo em toda fronteira de renderização ou publicação.

## Setup local

```bash
corepack enable
corepack prepare pnpm@11.5.2 --activate
pnpm install
pnpm dev
```

Os requisitos e a autenticação estão no [README](README.pt-BR.md#pré-requisitos).

## Validações obrigatórias

```bash
pnpm typecheck
pnpm test
pnpm build
```

## Checklist do pull request

- [ ] A mudança tem um objetivo claro.
- [ ] Há testes para o comportamento ou falha introduzidos.
- [ ] Typecheck, testes e build passam localmente.
- [ ] Textos da interface existem nos cinco dicionários.
- [ ] Datas, números e USD usam os formatadores compartilhados.
- [ ] Desktop e mobile foram verificados contra sobreposição, corte e falhas de teclado.
- [ ] Labels em alemão e francês foram revisados por serem mais longos.
- [ ] Falhas operacionais não podem aparecer como resultado de segurança aprovado.
- [ ] Documentação e screenshots foram atualizados quando o fluxo mudou.

## Contribuições de interface e design

- Preserve a identidade dark Test Bench e a linguagem visual Evidence Spectrum.
- Prefira primitives compartilhadas do shadcn/daisyUI; não recrie botões, inputs, dialogs ou tabelas em CSS próprio.
- Use Recharts ou os gráficos existentes.
- Cor pode reforçar, mas nunca ser o único sinal de estado.
- Respeite `prefers-reduced-motion`, foco visível e contraste WCAG AA.
- Valide mudanças de impressão/PDF com um PDF realmente gerado.

Veja o [design system](apps/web/DESIGN.pt-BR.md) e os [princípios do produto](apps/web/PRODUCT.pt-BR.md).

## Localização

Adicione a chave ao dicionário canônico e entregue PT-BR, inglês, espanhol, alemão e francês na mesma mudança. Não traduza automaticamente título, resumo, código, caminho, evidência ou log produzido pelo scanner.

Veja a [arquitetura de localização](docs/localization.pt-BR.md).

Use mensagens de commit concisas e imperativas. No pull request, explique problema, comportamento escolhido, evidências de validação, screenshots e limitações restantes.

Ao contribuir, você concorda com a [política de segurança](SECURITY.pt-BR.md).
