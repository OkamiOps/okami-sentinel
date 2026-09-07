import type { ScopedMessages } from "./scoped";

const ptBR = {
  "reportCommon.intelligence": "Inteligência de segurança local",
  "reportCommon.section": "Seção do relatório",
  "reportCommon.confidential": "confidencial",
};

export const reportCommonMessages: ScopedMessages<keyof typeof ptBR> = {
  "pt-BR": ptBR,
  en: {
    "reportCommon.intelligence": "Local security intelligence",
    "reportCommon.section": "Report section",
    "reportCommon.confidential": "confidential",
  },
  es: {
    "reportCommon.intelligence": "Inteligencia de seguridad local",
    "reportCommon.section": "Sección del informe",
    "reportCommon.confidential": "confidencial",
  },
  de: {
    "reportCommon.intelligence": "Lokale Sicherheitsanalyse",
    "reportCommon.section": "Berichtsabschnitt",
    "reportCommon.confidential": "vertraulich",
  },
  fr: {
    "reportCommon.intelligence": "Analyse de sécurité locale",
    "reportCommon.section": "Section du rapport",
    "reportCommon.confidential": "confidentiel",
  },
};
