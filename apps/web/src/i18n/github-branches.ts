import type { ScopedMessages } from "./scoped";

export const githubBranchesMessages = {
  "pt-BR": {
    "label": "Branches acompanhadas no Actions",
    "hint": "Separe por vírgulas. Ex.: main, release/**. Vazio acompanha todas. Em PRs, o filtro vale para a branch de destino.",
    "invalid": "Use até 20 nomes ou padrões de branch válidos."
  },
  "en": {
    "label": "Branches followed in Actions",
    "hint": "Separate with commas. Example: main, release/**. Empty follows all. For PRs, this filters the target branch.",
    "invalid": "Use up to 20 valid branch names or patterns."
  },
  "es": {
    "label": "Branches seguidas en Actions",
    "hint": "Separa con comas. Ej.: main, release/**. Vacío sigue todas. En PRs, filtra la rama de destino.",
    "invalid": "Usa hasta 20 nombres o patrones de rama válidos."
  },
  "de": {
    "label": "In Actions verfolgte Branches",
    "hint": "Mit Kommas trennen, z. B. main, release/**. Leer folgt allen. Bei PRs gilt der Filter für den Zielbranch.",
    "invalid": "Bis zu 20 gültige Branch-Namen oder Muster verwenden."
  },
  "fr": {
    "label": "Branches suivies dans Actions",
    "hint": "Séparez par des virgules. Ex. : main, release/**. Vide suit toutes les branches. Pour les PR, filtre la branche cible.",
    "invalid": "Utilisez au maximum 20 noms ou motifs de branche valides."
  }
} satisfies ScopedMessages<"label" | "hint" | "invalid">;
