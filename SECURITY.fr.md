# Politique de sécurité

[English](SECURITY.md) · [Português (Brasil)](SECURITY.pt-BR.md) · [Deutsch](SECURITY.de.md) · [Français](SECURITY.fr.md)

## Version prise en charge

Les corrections de sécurité ciblent actuellement le dernier commit de `main`. Avant une version stable, aucun backport n’est garanti pour les anciens commits ou les forks locaux.

## Signaler une vulnérabilité

Ne publiez **pas** de détails exploitables dans une issue publique. Utilisez **Security → Report a vulnerability** lorsque cette option est disponible, ou contactez en privé le responsable du dépôt via GitHub.

Incluez :

- le composant et le commit affectés ;
- les étapes de reproduction ou une preuve de concept minimale ;
- l’impact attendu et les prérequis de l’attaque ;
- l’exposition éventuelle de l’état du scanner, des GitHub Checks ou des données du dépôt ;
- toute mitigation déjà testée.

Laissez le temps nécessaire à la validation avant toute divulgation publique. Aucun SLA de réponse n’est promis tant que le projet reste pré-stable, mais les rapports exploitables seront traités en priorité.

## Frontières de sécurité

- Sortie du scanner, findings, chemins, logs et contenu du dépôt sont des entrées non fiables.
- Le produit est local-first par défaut. Démarrer un scan autorise explicitement la connexion sélectionnée à recevoir les prompts et les preuves bornées du dépôt nécessaires à la méthodologie. La publication GitHub reste une action distincte.
- Une erreur opérationnelle ne doit jamais devenir une décision de sécurité positive.
- Les secrets de fournisseurs et jetons OAuth sont accessibles uniquement en écriture via l’API locale et stockés dans le coffre de credentials du système. SQLite ne conserve que des références opaques et les DTO publics ne renvoient jamais de credential.
- Manifestes de scan, télémétrie, événements SSE et logs persistés passent par la frontière de rédaction partagée. Les processus locaux par abonnement reçoivent un environnement minimal.
- Les endpoints compatibles personnalisés sont une configuration non fiable et doivent réussir les contrôles d’URL, de transport, de redirection, de taille et de capacité avant qu’un modèle soit éligible au scan.
- La suppression d’un scan géré peut retirer sa sortie locale ; la cible et l’effet doivent rester explicites dans l’interface.

Ne joignez jamais de secrets réels, de code privé, d’état complet du scanner, de base de données ou de chemins personnels à une issue publique. Expurgez les logs et fournissez le plus petit artefact permettant de reproduire le problème.
