# Localisation de l’interface

[English](localization.md) · [Português (Brasil)](localization.pt-BR.md) · [Deutsch](localization.de.md) · [Français](localization.fr.md)

Le frontend d’OKAMI Sentinel prend en charge cinq locales :

- `pt-BR` — portugais brésilien et fallback ;
- `en` — anglais ;
- `es` — espagnol ;
- `de` — allemand ;
- `fr` — français.

## Comportement

Lors de la première visite, `resolveLocale` compare la langue du navigateur aux locales prises en charge. La sélection effectuée dans la barre supérieure est enregistrée dans `localStorage` sous `okami-sentinel.locale` et met à jour l’attribut `lang` du document.

Les dates et nombres utilisent `Intl` avec la locale active. La monnaie reste en USD, car le coût d’un scan est une métrique produit et non une conversion de change.

## Architecture

- `apps/web/src/i18n.tsx` : types de locale, dictionnaires, résolution, persistance et provider React.
- `apps/web/src/components/LanguageSwitcher.tsx` : sélecteur accessible fondé sur le dropdown partagé.
- `apps/web/src/format.ts` : formatage localisé des dates, nombres et montants USD.
- `apps/web/src/lib/i18n.test.ts` : tests du fallback, des variantes navigateur et de l’interpolation.

Ajoutez toute nouvelle clé au dictionnaire canonique, puis fournissez une valeur dans chacun des autres dictionnaires. Le type `TranslationKey` empêche les références à des clés inconnues.

## Limite volontaire

Les commandes, états et indications opérationnelles de l’interface sont localisés. Les titres, résumés de findings, preuves, codes, chemins et logs produits par le scanner restent dans la langue source. Une traduction automatique pourrait modifier une preuve utilisée dans une décision de sécurité.

## Vérification minimale

```bash
pnpm --filter @csb/web test
pnpm --filter @csb/web typecheck
pnpm --filter @csb/web build
```

La validation visuelle doit couvrir desktop et mobile. Une attention particulière est nécessaire pour l’allemand et le français, dont les libellés sont souvent plus longs ; aucune action ne doit se chevaucher ni devenir inaccessible.
