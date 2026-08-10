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
import { type TranslationKey, useI18n } from "../../i18n";
import { blankConnectionDraft, changeConnectionTransport, createConnectionRequest, type ConnectionDraft, type ConnectionDraftError, updateConnectionRequest, validateConnectionDraft } from "../../lib/connections";

type Props = {
  open: boolean;
  connection?: ProviderConnection | null;
  onOpenChange: (open: boolean) => void;
  onCreate: (body: CreateProviderConnectionRequest) => Promise<void>;
  onUpdate: (id: string, body: UpdateProviderConnectionRequest) => Promise<void>;
};

const cliProtocols: ProviderProtocol[] = ["codex-cli", "claude-code-cli", "cursor-agent-cli", "grok-build-cli"];
const apiProtocols: ProviderProtocol[] = ["openai-responses", "openai-chat", "anthropic-messages"];
const protocolLabels: Record<ProviderProtocol, TranslationKey> = {
  "codex-cli": "connections.protocol.codex-cli",
  "codex-app-server": "connections.protocol.codex-app-server",
  "claude-code-cli": "connections.protocol.claude-code-cli",
  "cursor-agent-cli": "connections.protocol.cursor-agent-cli",
  "grok-build-cli": "connections.protocol.grok-build-cli",
  "xai-oauth-responses": "connections.protocol.xai-oauth-responses",
  "openai-responses": "connections.protocol.openai-responses",
  "openai-chat": "connections.protocol.openai-chat",
  "anthropic-messages": "connections.protocol.anthropic-messages",
  "cursor-background-agents": "connections.protocol.cursor-background-agents",
};
const editorErrorId = "connection-editor-error";

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
  const switchTransport = (transport: ConnectionTransport) => setDraft((current) => changeConnectionTransport(current, transport));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validation = validateConnectionDraft(draft, { requireHttpSecret: !editing });
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
  const secretInvalid = error === "secret";

  return <Sheet open={open} onOpenChange={(next) => next ? onOpenChange(true) : close()}>
    <SheetContent side="right" className="gap-0 overflow-y-auto border-border bg-background p-0 sm:max-w-[34rem]">
      <SheetHeader className="border-b border-border pr-12">
        <div className="bench-label">{t("connections.chrome.writeOnly")}</div>
        <SheetTitle>{editing ? t("connections.editorEdit") : t("connections.editorNew")}</SheetTitle>
        <SheetDescription>{t("connections.editorDescription")}</SheetDescription>
      </SheetHeader>
      <form onSubmit={(event) => void submit(event)} className="flex min-h-full flex-1 flex-col">
        <div className="space-y-5 p-4 pb-28">
          {errorMessage && <div id={editorErrorId} role="alert" aria-live="assertive" className="border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">{errorMessage}</div>}
          <fieldset className="space-y-3" disabled={saving}>
            <legend className="bench-label mb-2">{t("connections.section.routeMetadata")}</legend>
            <Field id="connection-name" label={t("connections.name")} invalid={error === "name"}>{(a11y) => <Input {...a11y} value={draft.name} onChange={(event) => update("name", event.target.value)} autoComplete="off" />}</Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="connection-provider" label={t("connections.providerKind")} invalid={error === "provider"}>{(a11y) => <Input {...a11y} value={draft.providerKind} onChange={(event) => update("providerKind", event.target.value)} autoComplete="off" disabled={editing} />}</Field>
              <Field id="connection-route" label={t("connections.routeKind")} invalid={error === "route"}>{(a11y) => <Input {...a11y} value={draft.routeKind} onChange={(event) => update("routeKind", event.target.value)} autoComplete="off" disabled={editing} />}</Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="connection-transport" label={t("connections.transport")}>{(a11y) => <Select value={draft.transport} onValueChange={(value) => switchTransport(value as ConnectionTransport)} disabled={editing}><SelectTrigger {...a11y} className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="local-cli">{t("connections.transport.local-cli")}</SelectItem><SelectItem value="http-inference">{t("connections.transport.http-inference")}</SelectItem></SelectContent></Select>}</Field>
              <Field id="connection-auth" label={t("connections.auth")}>{(a11y) => <Select value={draft.authKind} onValueChange={(value) => update("authKind", value as ConnectionAuthKind)} disabled={editing}><SelectTrigger {...a11y} className="w-full"><SelectValue /></SelectTrigger><SelectContent>{draft.transport === "local-cli" ? <SelectItem value="existing-session">{t("connections.auth.existing-session")}</SelectItem> : <><SelectItem value="api-key">{t("connections.auth.api-key")}</SelectItem><SelectItem value="custom-headers">{t("connections.auth.custom-headers")}</SelectItem></>}</SelectContent></Select>}</Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="connection-protocol" label={t("connections.protocol")}>{(a11y) => <Select value={draft.protocol} onValueChange={(value) => update("protocol", value as ProviderProtocol)} disabled={editing}><SelectTrigger {...a11y} className="w-full"><SelectValue /></SelectTrigger><SelectContent>{protocolOptions.map((protocol) => <SelectItem key={protocol} value={protocol}>{t(protocolLabels[protocol])}</SelectItem>)}</SelectContent></Select>}</Field>
              <Field id="connection-model-mode" label={t("connections.modelMode")}>{(a11y) => <Select value={draft.modelSelectionMode} onValueChange={(value) => update("modelSelectionMode", value as ConnectionDraft["modelSelectionMode"])} disabled={editing}><SelectTrigger {...a11y} className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="runtime-default">{t("connections.model.runtime-default")}</SelectItem><SelectItem value="catalog">{t("connections.model.catalog")}</SelectItem></SelectContent></Select>}</Field>
            </div>
          </fieldset>
          {draft.transport === "http-inference" && <fieldset className="space-y-3 border-t border-border pt-5" disabled={saving}>
            <legend className="bench-label mb-2">{t(editing ? "connections.section.secretBundleOptional" : "connections.section.secretBundleRequired")}</legend>
            <p id="connection-secret-help" className="text-[11px] leading-relaxed text-muted-foreground">{t(editing ? "connections.secretHelp" : "connections.secretCreateHelp")}</p>
            <Field id="connection-api-key" label={t("connections.apiKey")} descriptionId="connection-secret-help" invalid={secretInvalid}>{(a11y) => <Input {...a11y} type="password" value={draft.apiKey} onChange={(event) => update("apiKey", event.target.value)} autoComplete="new-password" placeholder={t("connections.placeholder.apiKey")} />}</Field>
            <Field id="connection-base-url" label={t("connections.customBaseUrl")} descriptionId="connection-secret-help" invalid={secretInvalid}>{(a11y) => <Input {...a11y} type="url" value={draft.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} autoComplete="off" placeholder={t("connections.placeholder.baseUrl")} />}</Field>
            <Field id="connection-discovery-url" label={t("connections.discoveryUrl")} descriptionId="connection-secret-help" invalid={secretInvalid}>{(a11y) => <Input {...a11y} type="url" value={draft.discoveryUrl} onChange={(event) => update("discoveryUrl", event.target.value)} autoComplete="off" placeholder={t("connections.placeholder.discoveryUrl")} />}</Field>
            <Field id="connection-headers" label={t("connections.headers")} description={t("connections.headersHelp")} invalid={error === "headers" || secretInvalid}>{(a11y) => <textarea {...a11y} value={draft.headers} onChange={(event) => update("headers", event.target.value)} autoComplete="off" className="min-h-20 w-full resize-y border border-input bg-transparent px-2.5 py-2 font-mono text-xs outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50" placeholder={t("connections.placeholder.headers")} />}</Field>
          </fieldset>}
        </div>
        <SheetFooter className="sticky bottom-0 border-t border-border bg-background/95 backdrop-blur-sm sm:flex-row sm:justify-end"><Button type="button" variant="outline" onClick={close} disabled={saving}>{t("common.cancel")}</Button><Button type="submit" disabled={saving}>{saving ? t("connections.saving") : t("connections.save")}</Button></SheetFooter>
      </form>
    </SheetContent>
  </Sheet>;
}

type FieldControlProps = {
  id: string;
  "aria-label": string;
  "aria-labelledby": string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
};

function Field({ id, label, description, descriptionId, invalid = false, children }: { id: string; label: string; description?: string; descriptionId?: string; invalid?: boolean; children: (props: FieldControlProps) => ReactNode }) {
  const ownDescriptionId = description ? `${id}-description` : undefined;
  const describedBy = [descriptionId ?? ownDescriptionId, invalid ? editorErrorId : undefined].filter(Boolean).join(" ") || undefined;
  const labelId = `${id}-label`;
  return <div className="block space-y-1.5"><label id={labelId} htmlFor={id} className="bench-label">{label}</label>{children({ id, "aria-label": label, "aria-labelledby": labelId, "aria-describedby": describedBy, ...(invalid ? { "aria-invalid": true } : {}) })}{description && <span id={ownDescriptionId} className="block text-[10px] leading-relaxed text-muted-foreground">{description}</span>}</div>;
}
