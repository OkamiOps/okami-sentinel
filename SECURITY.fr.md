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
- Le produit est local-first par défaut. Les données ne quittent la machine que par une intégration explicitement demandée, comme GitHub Checks ou un workflow Actions avec API.
- Une erreur opérationnelle ne doit jamais devenir une décision de sécurité positive.
- `OPENAI_API_KEY` est un secret GitHub Actions. L’application vérifie sa présence, mais ne lit ni ne conserve sa valeur.
- La suppression d’un scan géré peut retirer sa sortie locale ; la cible et l’effet doivent rester explicites dans l’interface.

Ne joignez jamais de secrets réels, de code privé, d’état complet du scanner, de base de données ou de chemins personnels à une issue publique. Expurgez les logs et fournissez le plus petit artefact permettant de reproduire le problème.
