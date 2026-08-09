# Contribuer à OKAMI Sentinel

[English](CONTRIBUTING.md) · [Português (Brasil)](CONTRIBUTING.pt-BR.md) · [Deutsch](CONTRIBUTING.de.md) · [Français](CONTRIBUTING.fr.md)

Merci d’améliorer OKAMI Sentinel. Toute contribution doit préserver trois propriétés : fonctionnement local-first, fidélité des preuves et issues de sécurité explicites.

## Avant de commencer

- Ouvrez une issue pour les changements importants de comportement, schéma ou workflow.
- Gardez les pull requests ciblées ; le nettoyage sans rapport doit être séparé.
- Ne commitez jamais l’état du scanner, les bases, logs, identifiants, secrets ou chemins personnels.
- Les findings générés sont des entrées non fiables. Échappez-les et limitez-les à chaque frontière d’affichage ou de publication.

## Installation locale

```bash
corepack enable
corepack prepare pnpm@11.5.2 --activate
pnpm install
pnpm dev
```

Les prérequis et l’authentification sont décrits dans le [README](README.fr.md#prérequis).

## Vérifications obligatoires

```bash
pnpm typecheck
pnpm test
pnpm build
```

## Checklist de pull request

- [ ] Le changement poursuit un objectif clair.
- [ ] Les tests couvrent le comportement et les erreurs introduits.
- [ ] Typecheck, tests et build réussissent localement.
- [ ] Les textes de l’interface existent dans les cinq dictionnaires.
- [ ] Dates, nombres et USD utilisent les formateurs partagés.
- [ ] Desktop et mobile ont été vérifiés contre chevauchements, coupures et défauts clavier.
- [ ] Les libellés allemands et français plus longs ont été examinés.
- [ ] Une erreur opérationnelle ne peut jamais devenir un résultat de sécurité positif.
- [ ] Documentation et screenshots sont mis à jour lorsque le workflow change.

## Interface et design

- Préservez l’identité sombre Test Bench et le langage visuel Evidence Spectrum.
- Préférez les primitives shadcn/daisyUI partagées ; ne recréez pas boutons, champs, dialogues ou tableaux en CSS spécifique.
- Utilisez Recharts ou les primitives graphiques existantes.
- La couleur peut renforcer le sens, mais ne doit jamais être le seul signal d’état.
- Respectez `prefers-reduced-motion`, le focus visible et le contraste WCAG AA.
- Validez les changements d’impression/PDF avec un PDF réellement généré.

Voir le [système de design](apps/web/DESIGN.fr.md) et les [principes produit](apps/web/PRODUCT.fr.md).

## Localisation

Toute nouvelle clé doit fournir PT-BR, anglais, espagnol, allemand et français dans le même changement. Ne traduisez pas automatiquement les titres, résumés, codes, chemins, preuves ou logs du scanner.

Voir l’[architecture de localisation](docs/localization.fr.md).

Utilisez des messages de commit concis et impératifs. La pull request doit expliquer le problème, le comportement retenu, les preuves de validation, les screenshots et les limites restantes.

Toute contribution implique l’acceptation de la [politique de sécurité](SECURITY.fr.md).
