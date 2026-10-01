import { Navigate, useParams } from "react-router-dom";

/**
 * The policy used to have a page of its own. It now lives on the repository's page,
 * alongside the baseline, the comment and the history — so this route only keeps the
 * old link working: `EvidenceTrace` points at it from every gate artifact already
 * written, and those links are in e-mails and in the operator's history.
 */
export function GuardrailPolicyPage() {
  const { repositoryKey = "" } = useParams();
  return <Navigate replace to={`/guardrails/repositories/${encodeURIComponent(repositoryKey)}`} />;
}

export default GuardrailPolicyPage;
