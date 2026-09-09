import type { PortableCodexSecurityDossier } from "./portable-codex-security-dossier.js";

export interface PortableAssessmentPage {
  index: number;
  total: number;
  segment?: number;
  dossier: PortableCodexSecurityDossier;
}

export function assessmentPageDirectory(stage: string, page: Pick<PortableAssessmentPage, "index" | "segment">): string {
  return `${stage}-${String(page.index + 1).padStart(2, "0")}` +
    (page.segment === undefined ? "" : `-part-${String(page.segment + 1).padStart(2, "0")}`);
}

/** Keep legacy page identities so a recovery never repeats an accepted 32-candidate page. */
export function createPortableAssessmentPages(
  dossier: PortableCodexSecurityDossier,
  stage: "dataflow" | "validation",
  hasWholePageCheckpoint: (index: number) => boolean = () => false,
): PortableAssessmentPage[] {
  const pages: PortableAssessmentPage[] = [];
  const total = Math.ceil(dossier.candidates.length / 32);
  for (let index = 0; index < total; index++) {
    const whole = dossier.candidates.slice(index * 32, (index + 1) * 32);
    const split = stage === "validation" && whole.length > 8 && !hasWholePageCheckpoint(index);
    const size = split ? 8 : 32;
    for (let offset = 0; offset < whole.length; offset += size) {
      const candidates = whole.slice(offset, offset + size);
      const ids = new Set(candidates.map(candidate => candidate.id));
      pages.push({ index, total, ...(split ? { segment: offset / size } : {}), dossier: {
        ...dossier, candidates,
        assessments: dossier.assessments.filter(assessment => ids.has(assessment.candidateId)),
      } });
    }
  }
  return pages;
}
