# Principes produit

[English](PRODUCT.md) · [Português (Brasil)](PRODUCT.pt-BR.md) · [Deutsch](PRODUCT.de.md) · [Français](PRODUCT.fr.md)

<!-- impeccable:product-schema 1 -->

## Plateforme

Application web avec API locale.

## Utilisateurs

Développeurs, professionnels DevSecOps, analystes sécurité et AI Engineers utilisent le produit individuellement pour exécuter des scans et collectivement pour examiner preuves, coût et efficacité technique.

## Finalité du produit

OKAMI Sentinel est un workbench local pour exécuter des scans Codex Security, Google Mantis et Capital One VulnHunter, suivre leur exécution, inspecter les findings, mesurer le coût estimé et comparer les combinaisons modèle/effort. Avant le lancement, Codex Security résout soit le contrat upstream Native, soit le profil défensif Portable maintenu par Sentinel. Le succès consiste à trouver un risque pertinent avec assez de contexte pour agir, tout en comprenant le coût et la limite d’exécution de chaque stratégie.

## Positionnement

Le produit réunit preuves de sécurité et télémétrie d’exécution. Findings, sévérité, modèle, effort, durée, tokens et coût estimé coexistent dans un flux comparable.

## Contexte opérationnel

Le produit est utilisé pendant le développement et la revue de sécurité de checkouts locaux ou de dépôts GitHub explicitement autorisés. Les scans peuvent être longs, partiels ou coûteux ; leurs résultats doivent rester lisibles pendant et après l’exécution. Le flux principal est vue d’ensemble → nouveau scan → activité/détail → comparaison → rapport.

## Capacités et limites

- Interface React/Vite locale, API Hono et métadonnées reflétées dans SQLite.
- Guardrails accepte deux autorités explicites de dépôt : checkout local ou installation GitHub App privée. Les cibles distantes doivent être résolues en SHA base/head immuables avant exécution ; `HEAD` distant implicite et fallback silencieux vers l’état local sont interdits.
- Un gate distant s’exécute depuis un snapshot immuable géré par Sentinel ou un caller GitHub Actions appartenant au dépôt et épinglé sur un SHA complet de release. La policy distante est en lecture seule dans Sentinel ; les propositions sont copiées ou téléchargées puis publiées via la revue pull request normale. Seul le workflow publie les GitHub Checks.
- Indexation des scans compatibles présents dans l’état local configuré des scanners et dans les sorties gérées par Sentinel.
- Moteur, connexion, protocole, profil d’exécution et sélection de modèle sont résolus et épinglés avant le lancement. Un scan fixe soit un modèle du catalogue en direct, soit, uniquement lorsque l’adapter le déclare, un runtime par défaut explicite. Un tuple qui exige une capability probe n’est éligible qu’après la réussite d’une probe fraîche et correspondante ; Sentinel ne bascule jamais silencieusement vers une autre route, un autre modèle ou profil.
- Les modèles et options d’effort de raisonnement proviennent du catalogue du runtime/provider sélectionné. Lorsqu’un provider ne publie pas de métadonnées d’effort, Sentinel laisse l’effort géré par le provider au lieu d’inventer des options.
- Interface en PT-BR, anglais, espagnol, allemand et français avec détection et persistance locale.
- Une baseline et jusqu’à cinq candidats par comparaison.
- Les scans interrompus ayant conservé des findings restent disponibles comme résultats partiels clairement identifiés.
- Portable conserve un dossier géré par le serveur et n’émet des pages de rapport que pour les candidats confirmés. Ces pages internes privées sont validées puis consolidées dans un seul rapport final ; les candidats rejetés et leur couverture sont dérivés par le serveur. Si une page ou sa validation échoue, aucun rapport final partiel n’est publié.
- Lorsqu’un artefact terminal échoue à la validation, Portable n’accorde qu’une petite fenêtre de réparation bornée, dans les limites globales existantes du scan pour les tours, outils, temps et coût configuré.
- Les scans standard et deep ne classent que les findings de l’exécution actuelle, en `new`, `persisting` ou `regressed`, par rapport à une baseline compatible de même lignée d’analyse. L’absence d’un finding ne constitue pas une remédiation ; `fixed` reste réservé à un futur contrat incrémental explicite.
- Les rapports individuels et comparatifs réutilisent le même modèle de preuves, coût et efficacité et peuvent être imprimés ou exportés en PDF.
- Le coût n’apparaît que lorsque l’usage rapporté et un prix correspondant sont disponibles ; sinon il reste indisponible, jamais un zéro inventé ou une facture d’abonnement. Le plafond USD facultatif de Portable utilise l’usage rapporté et un devis correspondant figé : il bloque la requête suivante une fois atteint, tandis qu’une requête déjà en vol peut encore faire dépasser l’estimation.
- High par dollar est une heuristique, pas une preuve d’exactitude.
- Les preuves du scanner restent dans leur langue source pour préserver le sens technique.
- Le registre des runs expose l’identité du moteur et du modèle, ainsi que High+ et le total des findings, afin qu’une ligne soit compréhensible sans ouvrir son détail.
- Seuls les scans terminalisés peuvent être retirés explicitement après confirmation. Sentinel retire l’enregistrement local et, le cas échéant, ses artefacts gérés ; jamais le dépôt analysé ni des chemins externes.
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
