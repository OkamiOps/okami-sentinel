import type { ScopedMessages } from "./scoped";

export const githubBranchesMessages = {
  "pt-BR": {
    "label": "Branches acompanhadas no Actions",
    "hint": "Selecione na lista. Sem seleção acompanha todas. Em PRs, o filtro vale para a branch de destino.",
    "invalid": "Use até 20 nomes ou padrões de branch válidos."
  },
  "en": {
    "label": "Branches followed in Actions",
    "hint": "Select from the list. No selection follows all. For PRs, this filters the target branch.",
    "invalid": "Use up to 20 valid branch names or patterns."
  },
  "es": {
    "label": "Branches seguidas en Actions",
    "hint": "Selecciona en la lista. Sin selección sigue todas. En PRs, filtra la rama de destino.",
    "invalid": "Usa hasta 20 nombres o patrones de rama válidos."
  },
  "de": {
    "label": "In Actions verfolgte Branches",
    "hint": "Aus der Liste auswählen. Ohne Auswahl gelten alle. Bei PRs gilt der Filter für den Zielbranch.",
    "invalid": "Bis zu 20 gültige Branch-Namen oder Muster verwenden."
  },
  "fr": {
    "label": "Branches suivies dans Actions",
    "hint": "Sélectionnez dans la liste. Sans sélection, toutes sont suivies. Pour les PR, le filtre vise la branche cible.",
    "invalid": "Utilisez au maximum 20 noms ou motifs de branche valides."
  }
} satisfies ScopedMessages<"label" | "hint" | "invalid">;
