---
name: OKAMI Sentinel / Test Bench
description: Espace sombre d’instrumentation de sécurité organisé autour de canaux de preuves
---

# Système de design : Test Bench

[English](DESIGN.md) · [Português (Brasil)](DESIGN.pt-BR.md) · [Deutsch](DESIGN.de.md) · [Français](DESIGN.fr.md)

## Étoile polaire

Le produit est un banc de benchmark de sécurité, pas un dashboard SaaS. Le travail s’organise en canaux, signaux, traces, patch bays, manifests et inspecteurs. Le langage visuel repose sur des heatmaps denses, des workspaces multipanneaux, des listes opérationnelles, des barres de commande persistantes et des affichages d’instrument.

## Signature

L’**Evidence Spectrum** est le visuel propriétaire. Chaque run devient un canal doté d’une bande normalisée de sévérité. Cette bande compare distribution, volume, coût et état sans cacher les preuves dans des cartes KPI ou des donuts décoratifs.

## Shell

- Barre de commande horizontale compacte ; aucune sidebar permanente.
- Modules numérotés et état du moteur sur le même rail.
- Sélecteur de langue compact avec noms natifs et sélection explicite.
- Command dock persistant pour lancer ou retrouver le travail actif.
- Canvas presque noir avec grille structurelle discrète.
- Panneaux connectés et rayon de 2px uniquement lorsque la primitive l’exige.

## Rôles des couleurs

- **Orange :** commande, lancement, confirmation destructive et action principale.
- **Cyan :** preuve, sélection, focus et efficacité.
- **Magenta :** priorité critical/high et divergence significative.
- **Ambre :** medium, avertissement et résultat partiel.
- **Vert :** terminé, prêt et état opérationnel vérifié.

La couleur ne porte jamais seule le sens ; statut et sévérité disposent toujours d’un label textuel.

## Routes

- **Vue d’ensemble :** index des canaux, Evidence Spectrum, sample readout et traces coût/preuves.
- **Runs :** registre dense avec badges visibles de moteur et de modèle, ainsi que High+ et le total des findings. Les runs annulés ou en échec sont filtrés délibérément ; seuls les runs terminalisés peuvent être retirés explicitement après confirmation destructive, jamais supprimés silencieusement.
- **Exécuter :** séquenceur connecté de target, strategy et authorization.
- **Comparer :** bibliothèque de runs, baseline/candidats, plan d’efficacité, cockpit de décision et diff.
- **Rapports :** lecture éditoriale print/PDF avec identité OKAMI, synthèse, métriques et détail borné des findings.
- **Activité :** bus live et event trace continu.
- **Détail du scan :** header du canal, index, liste, inspecteur, télémétrie et profil.
- **Guardrails :** portfolio de dépôts, pipeline, éditeur de politique et Decision Graph.
- **Système :** engine matrix, capacity envelope, authentification et opération de l’index.

## Politique de composants

shadcn fournit les primitives d’action, input, dropdown, sheet, dialogue et infrastructure. daisyUI fournit formulaires, tableaux et loaders compatibles. Recharts dessine les traces et plans comparatifs. Le CSS spécifique reste limité aux tokens, à la grille du canvas, à la composition d’impression et aux layouts connectés propres au produit.

## Règles

1. Aucune route ne commence par quatre cartes KPI génériques.
2. La décoration ne concurrence jamais le signal opérationnel.
3. Les valeurs financières affichent explicitement USD.
4. Les graphiques exposent les valeurs absolues ou leur règle de normalisation.
5. Le contenu large utilise un overflow local ; aucun scroll horizontal global.
6. Mobile empile les modules dans l’ordre de décision.
7. Le mouvement respecte `prefers-reduced-motion`.
8. Les textes allemands et français ne doivent couper aucune action essentielle.
9. Dates et nombres suivent la locale ; USD et codes scanner restent explicites.
10. Les preuves du scanner ne sont pas traduites automatiquement.
11. L’impression est validée dans un vrai PDF A4 et ne doit jamais masquer l’overflow.
12. Une erreur opérationnelle ne ressemble jamais à une approbation de sécurité.
