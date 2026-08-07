import type { GuardrailPolicy } from "@csb/shared";

export function PolicyDiffPreview({ before, after }: { before: GuardrailPolicy; after: GuardrailPolicy }) {
  const beforeJson = `${JSON.stringify(before, null, 2)}\n`;
  const afterJson = `${JSON.stringify(after, null, 2)}\n`;
  return (
    <section className="bench-panel min-w-0" aria-labelledby="policy-diff-title">
      <div className="border-b px-4 py-2.5">
        <div className="bench-label text-primary">EXACT JSON DIFF</div>
        <h2 id="policy-diff-title" className="mt-0.5 text-sm font-semibold">Antes e depois</h2>
      </div>
      <div className="grid min-w-0 lg:grid-cols-2">
        <JsonPane label="Arquivo atual" value={beforeJson} />
        <JsonPane label="Próximo arquivo" value={afterJson} next />
      </div>
    </section>
  );
}

function JsonPane({ label, value, next = false }: { label: string; value: string; next?: boolean }) {
  return (
    <div className={next ? "min-w-0 border-t lg:border-l lg:border-t-0" : "min-w-0"}>
      <div className="border-b px-3 py-2 font-mono text-[8px] uppercase tracking-[0.1em] text-muted-foreground">{label}</div>
      <pre className="max-h-96 overflow-auto p-3 font-mono text-[10px] leading-5 text-muted-foreground" tabIndex={0}>{value}</pre>
    </div>
  );
}
