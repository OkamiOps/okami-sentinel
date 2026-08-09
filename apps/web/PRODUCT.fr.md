# Principes produit

[English](PRODUCT.md) · [Português (Brasil)](PRODUCT.pt-BR.md) · [Deutsch](PRODUCT.de.md) · [Français](PRODUCT.fr.md)

<!-- impeccable:product-schema 1 -->

## Plateforme

Application web avec API locale.

## Utilisateurs

Développeurs, professionnels DevSecOps, analystes sécurité et AI Engineers utilisent le produit individuellement pour exécuter des scans et collectivement pour examiner preuves, coût et efficacité technique.

## Finalité du produit

OKAMI Sentinel est un workbench local pour lancer des scans `@openai/codex-security`, suivre leur exécution, inspecter les findings, mesurer le coût estimé et comparer les combinaisons modèle/effort. Le succès consiste à trouver un risque pertinent avec assez de contexte pour agir, tout en comprenant le coût de chaque stratégie.

## Positionnement

Le produit réunit preuves de sécurité et télémétrie d’exécution. Findings, sévérité, modèle, effort, durée, tokens et coût estimé coexistent dans un flux comparable.

## Contexte opérationnel

Le produit est utilisé pendant le développement et la revue de sécurité de dépôts locaux. Les scans peuvent être longs, partiels ou coûteux ; leurs résultats doivent rester lisibles pendant et après l’exécution. Le flux principal est vue d’ensemble → nouveau scan → activité/détail → comparaison → rapport.

## Capacités et limites

- Interface React/Vite locale, API Hono et métadonnées reflétées dans SQLite.
- Indexation des scans compatibles présents dans l’état Codex Security.
- Interface en PT-BR, anglais, espagnol, allemand et français avec détection et persistance locale.
- Une baseline et jusqu’à cinq candidats par comparaison.
- Les scans interrompus ayant conservé des findings restent disponibles comme résultats partiels clairement identifiés.
- Les rapports individuels et comparatifs réutilisent le même modèle de preuves, coût et efficacité et peuvent être imprimés ou exportés en PDF.
- Les coûts sont des estimations fondées sur les tokens, pas une facturation confirmée.
- High par dollar est une heuristique, pas une preuve d’exactitude.
- Les preuves du scanner restent dans leur langue source pour préserver le sens technique.
- Desktop, mobile, clavier, focus visible et reduced motion sont des exigences.

## Engagements de marque

Le nom OKAMI Sentinel et sa nature de benchmark technique de sécurité sont conservés. Le thème principal est sombre. L’interface évite les motifs SaaS génériques et se comporte comme un instrument de sécurité, sans copier d’autres produits ni inventer de promesses.

## Preuves disponibles

- Métadonnées, métriques et findings réels exposés par l’API locale.
- Références visuelles fournies pendant le redesign d’août 2026.
- Identité OKAMI Sentinel fournie pour le produit et les rapports ; aucune variante ou promesse commerciale non validée.

## Principes

- Afficher le signal avant la décoration.
- Garder risque et coût lisibles dans la même décision.
- Séparer état opérationnel, preuve et estimation.
- Permettre une lecture rapide et un handoff clair vers l’équipe.
- Préserver les données brutes et rendre explicites les actions destructives.
- Ne jamais qualifier une preuve absente de correction sans confirmation.

## Accessibilité et inclusion

Contraste WCAG AA, navigation clavier, labels ne dépendant pas seulement de la couleur, cibles confortables, textes allemands/français plus longs et `prefers-reduced-motion` sont des exigences.
