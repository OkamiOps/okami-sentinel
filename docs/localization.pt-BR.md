# Localização da interface

[English](localization.md) · [Português (Brasil)](localization.pt-BR.md) · [Deutsch](localization.de.md) · [Français](localization.fr.md)

O frontend do OKAMI Sentinel suporta cinco locales:

- `pt-BR` — português do Brasil e fallback;
- `en` — inglês;
- `es` — espanhol;
- `de` — alemão;
- `fr` — francês.

## Comportamento

Na primeira visita, `resolveLocale` compara o idioma do navegador com os locales suportados. A escolha feita no barramento superior é salva em `localStorage` como `okami-sentinel.locale` e atualiza o atributo `lang` do documento.

Datas e números usam `Intl` com o locale ativo. A moeda continua em USD porque o custo do scan é uma métrica do produto, não uma conversão cambial.

## Arquitetura

- `apps/web/src/i18n.tsx`: tipos, dicionários, resolução, persistência e provider React.
- `apps/web/src/components/LanguageSwitcher.tsx`: seletor acessível baseado no dropdown compartilhado.
- `apps/web/src/format.ts`: formatação localizada de datas, números e USD.
- `apps/web/src/lib/i18n.test.ts`: fallback, variantes do navegador e interpolação.

Adicione a chave ao dicionário canônico e forneça um valor em todos os demais dicionários. O tipo `TranslationKey` impede referências a chaves inexistentes.

## Limite deliberado

Comandos, estados e orientação operacional da interface são localizados. Títulos, resumos de findings, evidências, código, caminhos e logs produzidos pelo scanner permanecem no idioma original. A tradução automática poderia alterar a evidência usada em uma decisão de segurança.

## Verificação mínima

```bash
pnpm --filter @csb/web test
pnpm --filter @csb/web typecheck
pnpm --filter @csb/web build
```

A validação visual deve cobrir desktop e mobile. Dê atenção especial ao alemão e ao francês por terem labels mais longos e confirme que nenhuma ação fica sobreposta ou inacessível.
