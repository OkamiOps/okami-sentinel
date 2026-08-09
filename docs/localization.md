# Localização da interface

O frontend do Okami Sentinel suporta cinco locales:

- `pt-BR` — português do Brasil e fallback;
- `en` — inglês;
- `es` — espanhol;
- `de` — alemão;
- `fr` — francês.

## Comportamento

Na primeira visita, `resolveLocale` compara o idioma do navegador com os locales suportados. A escolha feita no seletor do barramento superior é salva em `localStorage` como `okami-sentinel.locale` e também atualiza o atributo `lang` do documento.

Datas e números usam `Intl` com o locale ativo. Moeda continua em USD porque custo de scan é uma métrica do produto, não uma conversão cambial.

## Arquitetura

- `apps/web/src/i18n.tsx`: tipos, dicionários, resolução de locale, persistência e provider React.
- `apps/web/src/components/LanguageSwitcher.tsx`: seletor acessível baseado no dropdown compartilhado.
- `apps/web/src/format.ts`: formatação localizada de datas, números e USD.
- `apps/web/src/lib/i18n.test.ts`: cobertura do fallback, variantes do navegador e interpolação.

Para adicionar um texto, crie primeiro a chave no dicionário `ptBR` e forneça a tradução nos quatro dicionários restantes. O tipo `TranslationKey` impede o uso de chaves inexistentes.

## Limite deliberado

A interface, os comandos, os estados e a orientação operacional são localizados. Conteúdo produzido pelo scanner — título e resumo de finding, evidência, código, caminhos e logs — permanece no idioma original. Traduzir esse material automaticamente poderia alterar a precisão da evidência usada em uma decisão de segurança.

## Verificação mínima

```bash
pnpm --filter @csb/web test
pnpm --filter @csb/web typecheck
pnpm --filter @csb/web build
```

Na validação visual, verifique desktop e mobile, com atenção especial ao alemão e ao francês por terem rótulos mais longos.
