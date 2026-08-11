import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import type {
  CreateProviderConnectionRequest,
  ProviderConnection,
  UpdateProviderConnectionRequest,
} from "@csb/shared";
import { Cable, Cloud, KeyRound, LaptopMinimal, LockKeyhole, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { type TranslationKey, useI18n } from "../../i18n";
import {
  CONNECTION_PRESETS,
  MIMO_TOKEN_PLAN_REGIONS,
  applyConnectionPreset,
  applyMimoTokenPlanRegion,
  connectionPresetNeedsSecret,
  customEndpointDraftError,
  getConnectionPreset,
  mimoTokenPlanDraftError,
  presetForConnection,
  presetShowsEndpointFields,
  tryGetConnectionPreset,
  type ConnectionPreset,
  type ConnectionPresetId,
  type MimoTokenPlanRegionId,
} from "../../lib/connection-presets";
import {
  blankConnectionDraft,
  createConnectionRequest,
  type ConnectionDraft,
  type ConnectionDraftError,
  updateConnectionRequest,
  validateConnectionDraft,
} from "../../lib/connections";

type Props = {
  open: boolean;
  connection?: ProviderConnection | null;
  onOpenChange: (open: boolean) => void;
  onCreate: (body: CreateProviderConnectionRequest) => Promise<void>;
  onUpdate: (id: string, body: UpdateProviderConnectionRequest) => Promise<void>;
};

const editorErrorId = "connection-editor-error";
const initialPresetId: ConnectionPresetId = "openai-local-codex";

const providerOptions = [
  { id: "openai", label: "OpenAI" },
  { id: "xai", label: "xAI" },
  { id: "anthropic", label: "Anthropic" },
  { id: "cursor", label: "Cursor" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "google", label: "Google" },
  { id: "deepseek", label: "DeepSeek" },
  { id: "minimax", label: "MiniMax" },
  { id: "xiaomi", label: "Xiaomi MiMo" },
  { id: "custom", labelKey: "connections.preset.compatibleProvider" },
] as const;

const transportKeys = {
  "local-cli": "connections.transport.local-cli",
  "codex-app-server": "connections.transport.codex-app-server",
  "http-inference": "connections.transport.http-inference",
  "remote-agent-api": "connections.transport.remote-agent-api",
} as const satisfies Record<ConnectionPreset["transport"], TranslationKey>;

const authKeys = {
  "existing-session": "connections.auth.existing-session",
  "browser-oauth": "connections.auth.browser-oauth",
  "device-code": "connections.auth.device-code",
  "api-key": "connections.auth.api-key",
  "custom-headers": "connections.auth.custom-headers",
} as const satisfies Record<ConnectionPreset["authKind"], TranslationKey>;

export function ConnectionEditorSheet({ open, connection, onOpenChange, onCreate, onUpdate }: Props) {
  const { t } = useI18n();
  const editing = connection != null;
  const [draft, setDraft] = useState<ConnectionDraft>(() => blankConnectionDraft(connection ?? undefined));
  const [presetId, setPresetId] = useState<ConnectionPresetId>(initialPresetId);
  const [mimoRegion, setMimoRegion] = useState<MimoTokenPlanRegionId | null>("cn");
  const [error, setError] = useState<ConnectionDraftError | "mimo-region" | "custom-endpoint" | "custom-replacement" | "request" | null>(null);
  const [saving, setSaving] = useState(false);

  const storedPreset = useMemo(() => presetForConnection(connection), [connection]);
  const activePreset = editing ? storedPreset : getConnectionPreset(presetId);

  useEffect(() => {
    if (!open) return;
    const stored = presetForConnection(connection);
    const selectedId = stored?.id as ConnectionPresetId | undefined;
    const base = blankConnectionDraft(connection ?? undefined);
    const next = connection ? base : applyConnectionPreset(base, initialPresetId, t(getConnectionPreset(initialPresetId).labelKey));
    const region = MIMO_TOKEN_PLAN_REGIONS.find((candidate) => candidate.baseUrl === next.baseUrl)?.id ?? (stored?.id === "mimo-token-plan" ? null : "cn");
    setDraft(next);
    setPresetId(selectedId ?? initialPresetId);
    setMimoRegion(region);
    setError(null);
  }, [connection, open, t]);

  const clearSensitiveDraft = () => setDraft((current) => ({ ...current, apiKey: "", baseUrl: "", discoveryUrl: "", headers: "" }));
  const close = () => {
    clearSensitiveDraft();
    setError(null);
    onOpenChange(false);
  };
  const update = <Key extends keyof ConnectionDraft>(key: Key, value: ConnectionDraft[Key]) => setDraft((current) => ({ ...current, [key]: value }));

  const choosePreset = (nextId: string) => {
    const next = tryGetConnectionPreset(nextId);
    if (next === null) return;
    const region = next.id === "mimo-token-plan" ? "cn" : mimoRegion;
    setPresetId(next.id as ConnectionPresetId);
    setMimoRegion(region);
    setDraft((current) => applyConnectionPreset(current, next.id, t(next.labelKey)));
    setError(null);
  };

  const chooseProvider = (providerKind: string) => {
    const firstRoute = CONNECTION_PRESETS.find((preset) => preset.providerKind === providerKind);
    if (firstRoute !== undefined) choosePreset(firstRoute.id);
  };

  const chooseMimoRegion = (regionId: MimoTokenPlanRegionId) => {
    setMimoRegion(regionId);
    setDraft((current) => applyMimoTokenPlanRegion(current, regionId));
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const mimoError = mimoTokenPlanDraftError(draft, editing, mimoRegion);
    if (mimoError !== null) {
      setError(mimoError);
      return;
    }
    const customEndpointError = customEndpointDraftError(draft, editing);
    if (customEndpointError !== null) {
      setError(customEndpointError);
      return;
    }
    const validation = validateConnectionDraft(draft, { requireHttpSecret: !editing });
    if (validation) {
      setError(validation);
      return;
    }
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

  const errorMessage = error === "request" ? t("connections.saveError")
    : error === "mimo-region" ? t("connections.draftError.mimoRegion")
      : error === "custom-endpoint" ? t("connections.draftError.customEndpoint")
        : error === "custom-replacement" ? t("connections.draftError.customReplacement")
          : error ? t(`connections.draftError.${error}`) : null;
  const secretInvalid = error === "secret" || error === "custom-endpoint" || error === "custom-replacement";

  return <Sheet open={open} onOpenChange={(next) => next ? onOpenChange(true) : close()}>
    <SheetContent side="right" className="w-full gap-0 overflow-y-auto border-border bg-background p-0 sm:max-w-[43rem]">
      <SheetHeader className="border-b border-border pr-12">
        <div className="bench-label">{t("connections.chrome.writeOnly")}</div>
        <SheetTitle>{editing ? t("connections.editorEdit") : t("connections.editorNew")}</SheetTitle>
        <SheetDescription>{t("connections.editorDescription")}</SheetDescription>
      </SheetHeader>
      <form onSubmit={(event) => void submit(event)} className="flex min-h-full flex-1 flex-col">
        <div className="space-y-6 p-4 pb-28 sm:p-5">
          {errorMessage && <div id={editorErrorId} role="alert" aria-live="assertive" className="border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">{errorMessage}</div>}
          <fieldset className="space-y-4" disabled={saving}>
            {!editing && activePreset && <PresetSelector
              preset={activePreset}
              onProviderChange={chooseProvider}
              onPresetChange={choosePreset}
            />}
            {editing && <RegisteredRoute connection={connection} preset={activePreset} />}
            <Field id="connection-name" label={t("connections.name")} invalid={error === "name"}>
              {(a11y) => <Input {...a11y} value={draft.name} onChange={(event) => update("name", event.target.value)} autoComplete="off" />}
            </Field>
          </fieldset>
          {activePreset && <CredentialSection
            preset={activePreset}
            draft={draft}
            editing={editing}
            mimoRegion={mimoRegion}
            secretInvalid={secretInvalid}
            headersInvalid={error === "headers" || secretInvalid}
            onUpdate={update}
            onMimoRegionChange={chooseMimoRegion}
          />}
        </div>
        <SheetFooter className="sticky bottom-0 border-t border-border bg-background/95 backdrop-blur-sm sm:flex-row sm:justify-end"><Button type="button" variant="outline" onClick={close} disabled={saving}>{t("common.cancel")}</Button><Button type="submit" disabled={saving}>{saving ? t("connections.saving") : t("connections.save")}</Button></SheetFooter>
      </form>
    </SheetContent>
  </Sheet>;
}

function PresetSelector({ preset, onProviderChange, onPresetChange }: { preset: ConnectionPreset; onProviderChange: (providerKind: string) => void; onPresetChange: (presetId: string) => void }) {
  const { t } = useI18n();
  const matchingRoutes = CONNECTION_PRESETS.filter((candidate) => candidate.providerKind === preset.providerKind);
  return <section className="border border-border bg-muted/20 p-4 sm:p-5" aria-label={t("connections.preset.chooseRoute")}>
    <div className="mb-4 flex items-start gap-3">
      <span className="grid size-9 shrink-0 place-items-center border border-primary/35 bg-primary/[.06] text-primary"><Cable aria-hidden className="size-4" /></span>
      <div><p className="bench-label">01 / {t("connections.preset.chooseProvider")}</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t("connections.preset.providerHelp")}</p></div>
    </div>
    <div className="grid gap-3 sm:grid-cols-2">
      <Field id="connection-provider-preset" label={t("connections.preset.chooseProvider")}>
        {(a11y) => <Select value={preset.providerKind} onValueChange={onProviderChange}><SelectTrigger {...a11y} className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectLabel>{t("connections.provider")}</SelectLabel>{providerOptions.map((provider) => <SelectItem key={provider.id} value={provider.id}>{"label" in provider ? provider.label : t(provider.labelKey)}</SelectItem>)}</SelectGroup></SelectContent></Select>}
      </Field>
      <Field id="connection-route-preset" label={t("connections.preset.chooseRoute")}>
        {(a11y) => <Select value={preset.id} onValueChange={onPresetChange}><SelectTrigger {...a11y} className="w-full"><SelectValue /></SelectTrigger><SelectContent>{matchingRoutes.map((route) => <SelectItem key={route.id} value={route.id}>{t(route.labelKey)}</SelectItem>)}</SelectContent></Select>}
      </Field>
    </div>
    <div className="mt-4 border-t border-border pt-3"><p className="text-[11px] leading-relaxed text-muted-foreground">{t("connections.preset.routeHelp")}</p><RouteSignature preset={preset} /></div>
  </section>;
}

function RegisteredRoute({ connection, preset }: { connection: ProviderConnection; preset: ConnectionPreset | null }) {
  const { t } = useI18n();
  return <section className="border border-border bg-muted/20 p-4" aria-label={t("connections.preset.routeFixed")}>
    <div className="flex items-start gap-3"><span className="grid size-9 shrink-0 place-items-center border border-border bg-background text-muted-foreground"><LockKeyhole aria-hidden className="size-4" /></span><div><p className="bench-label">{t("connections.preset.routeFixed")}</p><p className="mt-1 text-sm font-semibold">{connection.display.providerLabel} · {connection.display.routeLabel}</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t("connections.preset.editRouteHelp")}</p></div></div>
    {preset && <RouteSignature preset={preset} />}
  </section>;
}

function RouteSignature({ preset }: { preset: ConnectionPreset }) {
  const { t } = useI18n();
  return <div className="mt-3 flex flex-wrap gap-2" aria-label={t(preset.labelKey)}>
    <RouteToken icon={preset.transport === "remote-agent-api" ? Cloud : LaptopMinimal}>{t(transportKeys[preset.transport])}</RouteToken>
    <RouteToken icon={preset.credentialMode === "managed-oauth" ? ShieldCheck : KeyRound}>{t(authKeys[preset.authKind])}</RouteToken>
  </div>;
}

function RouteToken({ icon: Icon, children }: { icon: typeof Cable; children: ReactNode }) {
  return <span className="inline-flex items-center gap-1.5 border border-border bg-background px-2 py-1 font-mono text-[9px] uppercase tracking-[.11em] text-muted-foreground"><Icon aria-hidden className="size-3" />{children}</span>;
}

function CredentialSection({
  preset,
  draft,
  editing,
  mimoRegion,
  secretInvalid,
  headersInvalid,
  onUpdate,
  onMimoRegionChange,
}: {
  preset: ConnectionPreset;
  draft: ConnectionDraft;
  editing: boolean;
  mimoRegion: MimoTokenPlanRegionId | null;
  secretInvalid: boolean;
  headersInvalid: boolean;
  onUpdate: <Key extends keyof ConnectionDraft>(key: Key, value: ConnectionDraft[Key]) => void;
  onMimoRegionChange: (region: MimoTokenPlanRegionId) => void;
}) {
  const { t } = useI18n();
  const needsSecret = connectionPresetNeedsSecret(preset);
  const customEndpoint = presetShowsEndpointFields(preset);
  const isMimo = preset.id === "mimo-token-plan";
  const isManaged = preset.credentialMode === "managed-oauth";
  const isLocal = preset.credentialMode === "none";
  const help = isLocal ? t("connections.preset.localHelp") : isManaged ? t("connections.preset.managedAuthHelp") : preset.credentialMode === "token-plan" ? t("connections.preset.tokenPlanHelp") : t("connections.preset.apiHelp");

  return <section className="border-t border-border pt-5">
    <div className="mb-4 flex items-start gap-3"><span className={cn("grid size-9 shrink-0 place-items-center border", needsSecret ? "border-primary/35 bg-primary/[.06] text-primary" : "border-border bg-muted/25 text-muted-foreground")}><KeyRound aria-hidden className="size-4" /></span><div><p className="bench-label">02 / {t("connections.auth")}</p><p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">{help}</p></div></div>
    {(isLocal || isManaged) && <div className="border border-border bg-muted/20 px-3 py-3 text-xs leading-relaxed text-muted-foreground"><span className="font-semibold text-foreground">{t(authKeys[preset.authKind])}</span><span> · {help}</span></div>}
    {needsSecret && <fieldset className="space-y-4">
      <legend className="sr-only">{t(editing ? "connections.section.secretBundleOptional" : "connections.section.secretBundleRequired")}</legend>
      {isMimo && <Field id="connection-mimo-region" label={t("connections.preset.mimoRegion")} description={mimoRegion === null ? t("connections.preset.mimoRegionUpdateHelp") : t("connections.preset.mimoRegionHelp")}>
        {(a11y) => <Select value={mimoRegion ?? undefined} onValueChange={(value) => onMimoRegionChange(value as MimoTokenPlanRegionId)}><SelectTrigger {...a11y} className="w-full"><SelectValue placeholder={t("connections.preset.chooseMimoRegion")} /></SelectTrigger><SelectContent>{MIMO_TOKEN_PLAN_REGIONS.map((region) => <SelectItem key={region.id} value={region.id}>{region.id.toUpperCase()} · {region.baseUrl}</SelectItem>)}</SelectContent></Select>}
      </Field>}
      {!customEndpoint && !isMimo && <EndpointPinned />}
      {isMimo && <EndpointPinned />}
      <Field id="connection-api-key" label={t("connections.apiKey")} invalid={secretInvalid}>
        {(a11y) => <Input {...a11y} type="password" value={draft.apiKey} onChange={(event) => onUpdate("apiKey", event.target.value)} autoComplete="new-password" placeholder={t("connections.placeholder.apiKey")} />}
      </Field>
      {customEndpoint && <div className="space-y-4 border-l border-primary/40 pl-3"><p className="bench-label text-primary">{t("connections.preset.customEndpoint")}</p><p role="note" className="border border-primary/30 bg-primary/[.06] px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">{t(editing ? "connections.preset.customBundleReplacementWarning" : "connections.preset.customBundleRequiredHelp")}</p><Field id="connection-base-url" label={t("connections.customBaseUrl")} invalid={secretInvalid}>{(a11y) => <Input {...a11y} type="url" value={draft.baseUrl} onChange={(event) => onUpdate("baseUrl", event.target.value)} autoComplete="off" placeholder={t("connections.placeholder.baseUrl")} />}</Field><Field id="connection-discovery-url" label={t("connections.discoveryUrl")} invalid={secretInvalid}>{(a11y) => <Input {...a11y} type="url" value={draft.discoveryUrl} onChange={(event) => onUpdate("discoveryUrl", event.target.value)} autoComplete="off" placeholder={t("connections.placeholder.discoveryUrl")} />}</Field><Field id="connection-headers" label={t("connections.headers")} description={t("connections.headersHelp")} invalid={headersInvalid}>{(a11y) => <textarea {...a11y} value={draft.headers} onChange={(event) => onUpdate("headers", event.target.value)} autoComplete="off" className="min-h-20 w-full resize-y border border-input bg-transparent px-2.5 py-2 font-mono text-xs outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50" placeholder={t("connections.placeholder.headers")} />}</Field></div>}
    </fieldset>}
  </section>;
}

function EndpointPinned() {
  const { t } = useI18n();
  return <div className="flex items-center gap-2 border border-border bg-muted/20 px-3 py-2 font-mono text-[10px] uppercase tracking-[.1em] text-muted-foreground"><ShieldCheck aria-hidden className="size-3.5 text-primary" />{t("connections.preset.endpointPinned")}</div>;
}

type FieldControlProps = {
  id: string;
  "aria-label": string;
  "aria-labelledby": string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
};

function Field({ id, label, description, invalid = false, children }: { id: string; label: string; description?: string; invalid?: boolean; children: (props: FieldControlProps) => ReactNode }) {
  const descriptionId = description ? `${id}-description` : undefined;
  const describedBy = [descriptionId, invalid ? editorErrorId : undefined].filter(Boolean).join(" ") || undefined;
  const labelId = `${id}-label`;
  return <div className="block space-y-1.5"><label id={labelId} htmlFor={id} className="bench-label">{label}</label>{children({ id, "aria-label": label, "aria-labelledby": labelId, "aria-describedby": describedBy, ...(invalid ? { "aria-invalid": true } : {}) })}{description && <span id={descriptionId} className="block text-[10px] leading-relaxed text-muted-foreground">{description}</span>}</div>;
}
