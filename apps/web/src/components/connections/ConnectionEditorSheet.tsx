import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type {
  ConnectionAuthKind,
  ConnectionTransport,
  CreateProviderConnectionRequest,
  ProviderConnection,
  ProviderProtocol,
  UpdateProviderConnectionRequest,
} from "@csb/shared";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useI18n } from "../../i18n";
import { blankConnectionDraft, createConnectionRequest, type ConnectionDraft, type ConnectionDraftError, updateConnectionRequest, validateConnectionDraft } from "../../lib/connections";

type Props = {
  open: boolean;
  connection?: ProviderConnection | null;
  onOpenChange: (open: boolean) => void;
  onCreate: (body: CreateProviderConnectionRequest) => Promise<void>;
  onUpdate: (id: string, body: UpdateProviderConnectionRequest) => Promise<void>;
};

const cliProtocols: ProviderProtocol[] = ["codex-cli", "claude-code-cli", "cursor-agent-cli", "grok-build-cli"];
const apiProtocols: ProviderProtocol[] = ["openai-responses", "openai-chat", "anthropic-messages"];

export function ConnectionEditorSheet({ open, connection, onOpenChange, onCreate, onUpdate }: Props) {
  const { t } = useI18n();
  const editing = connection != null;
  const [draft, setDraft] = useState<ConnectionDraft>(() => blankConnectionDraft(connection ?? undefined));
  const [error, setError] = useState<ConnectionDraftError | "request" | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(blankConnectionDraft(connection ?? undefined));
      setError(null);
    }
  }, [connection, open]);

  const clearSensitiveDraft = () => setDraft((current) => ({ ...current, apiKey: "", baseUrl: "", discoveryUrl: "", headers: "" }));
  const close = () => {
    clearSensitiveDraft();
    setError(null);
    onOpenChange(false);
  };
  const update = <Key extends keyof ConnectionDraft>(key: Key, value: ConnectionDraft[Key]) => setDraft((current) => ({ ...current, [key]: value }));
  const switchTransport = (transport: ConnectionTransport) => {
    setDraft((current) => transport === "local-cli"
      ? { ...current, transport, authKind: "existing-session", protocol: "codex-cli", modelSelectionMode: "runtime-default" }
      : { ...current, transport, authKind: "api-key", protocol: "openai-chat", modelSelectionMode: "catalog" });
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validation = validateConnectionDraft(draft);
    if (validation) { setError(validation); return; }
    setSaving(true);
    setError(null);
    try {
      if (connection) {
        const request = updateConnectionRequest(draft);
        clearSensitiveDraft();
        await onUpdate(connection.id, request);
      } else {
        const request = createConnectionRequest(draft);
        clearSensitiveDraft();
        await onCreate(request);
      }
      close();
    } catch {
      setError("request");
    } finally {
      setSaving(false);
    }
  }

  const protocolOptions = draft.transport === "local-cli" ? cliProtocols : apiProtocols;
  const errorMessage = error === "request" ? t("connections.saveError") : error ? t(`connections.draftError.${error}`) : null;

  return <Sheet open={open} onOpenChange={(next) => next ? onOpenChange(true) : close()}>
    <SheetContent side="right" className="gap-0 overflow-y-auto border-border bg-background p-0 sm:max-w-[34rem]">
      <SheetHeader className="border-b border-border pr-12">
        <div className="bench-label">CONNECTION / WRITE-ONLY</div>
        <SheetTitle>{editing ? t("connections.editorEdit") : t("connections.editorNew")}</SheetTitle>
        <SheetDescription>{t("connections.editorDescription")}</SheetDescription>
      </SheetHeader>
      <form onSubmit={(event) => void submit(event)} className="flex min-h-full flex-1 flex-col">
        <div className="space-y-5 p-4 pb-28">
          {errorMessage && <div role="alert" className="border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">{errorMessage}</div>}
          <fieldset className="space-y-3" disabled={saving}>
            <legend className="bench-label mb-2">ROUTE METADATA</legend>
            <Field label={t("connections.name")}><Input value={draft.name} onChange={(event) => update("name", event.target.value)} autoComplete="off" /></Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("connections.providerKind")}><Input value={draft.providerKind} onChange={(event) => update("providerKind", event.target.value)} autoComplete="off" disabled={editing} /></Field>
              <Field label={t("connections.routeKind")}><Input value={draft.routeKind} onChange={(event) => update("routeKind", event.target.value)} autoComplete="off" disabled={editing} /></Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("connections.transport")}><Select value={draft.transport} onValueChange={(value) => switchTransport(value as ConnectionTransport)} disabled={editing}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="local-cli">local CLI</SelectItem><SelectItem value="http-inference">HTTP inference API</SelectItem></SelectContent></Select></Field>
              <Field label={t("connections.auth")}><Select value={draft.authKind} onValueChange={(value) => update("authKind", value as ConnectionAuthKind)} disabled={editing}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent>{draft.transport === "local-cli" ? <SelectItem value="existing-session">existing local session</SelectItem> : <><SelectItem value="api-key">API key</SelectItem><SelectItem value="custom-headers">custom headers</SelectItem></>}</SelectContent></Select></Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("connections.protocol")}><Select value={draft.protocol} onValueChange={(value) => update("protocol", value as ProviderProtocol)} disabled={editing}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent>{protocolOptions.map((protocol) => <SelectItem key={protocol} value={protocol}>{protocol}</SelectItem>)}</SelectContent></Select></Field>
              <Field label={t("connections.modelMode")}><Select value={draft.modelSelectionMode} onValueChange={(value) => update("modelSelectionMode", value as ConnectionDraft["modelSelectionMode"])} disabled={editing}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="runtime-default">runtime default</SelectItem><SelectItem value="catalog">catalog when available</SelectItem></SelectContent></Select></Field>
            </div>
          </fieldset>
          {draft.transport === "http-inference" && <fieldset className="space-y-3 border-t border-border pt-5" disabled={saving}>
            <legend className="bench-label mb-2">SECRET BUNDLE / OPTIONAL</legend>
            <p className="text-[11px] leading-relaxed text-muted-foreground">{t("connections.secretHelp")}</p>
            <Field label={t("connections.apiKey")}><Input type="password" value={draft.apiKey} onChange={(event) => update("apiKey", event.target.value)} autoComplete="new-password" placeholder="••••••••" /></Field>
            <Field label={t("connections.customBaseUrl")}><Input type="url" value={draft.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} autoComplete="off" placeholder="https://…" /></Field>
            <Field label={t("connections.discoveryUrl")}><Input type="url" value={draft.discoveryUrl} onChange={(event) => update("discoveryUrl", event.target.value)} autoComplete="off" placeholder="https://…/models" /></Field>
            <Field label={t("connections.headers")} description={t("connections.headersHelp")}><textarea value={draft.headers} onChange={(event) => update("headers", event.target.value)} autoComplete="off" className="min-h-20 w-full resize-y border border-input bg-transparent px-2.5 py-2 font-mono text-xs outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50" placeholder="X-Account: …" /></Field>
          </fieldset>}
        </div>
        <SheetFooter className="sticky bottom-0 border-t border-border bg-background/95 backdrop-blur-sm sm:flex-row sm:justify-end"><Button type="button" variant="outline" onClick={close} disabled={saving}>{t("common.cancel")}</Button><Button type="submit" disabled={saving}>{saving ? t("connections.saving") : t("connections.save")}</Button></SheetFooter>
      </form>
    </SheetContent>
  </Sheet>;
}

function Field({ label, description, children }: { label: string; description?: string; children: ReactNode }) {
  return <label className="block space-y-1.5"><span className="bench-label">{label}</span>{children}{description && <span className="block text-[10px] leading-relaxed text-muted-foreground">{description}</span>}</label>;
}
