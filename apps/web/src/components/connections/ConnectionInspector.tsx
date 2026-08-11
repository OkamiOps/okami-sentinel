import { useEffect, useRef, useState } from "react";
import type {
  ConnectionAuthKind,
  ConnectionTransport,
  ProviderAuthFlow,
  ProviderConnection,
  ProviderModel,
  ProviderProtocol,
} from "@csb/shared";
import { KeyRound, Link2, LogIn, Pencil, Play, PlugZap, RefreshCw, ShieldCheck, Trash2, Unplug, XCircle } from "lucide-react";

import { api } from "../../api";
import { type TranslationKey, useI18n } from "../../i18n";
import { authFlowPresentation, connectionOperationErrorKey, createAuthFlowPoller, disconnectMessageForStatus, isTerminalAuthFlow, probeSelectionForModel } from "../../lib/connection-inspector";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState } from "../ui";

type Props = {
  connection: ProviderConnection | null;
  onConnectionChange: (connection: ProviderConnection) => void;
  onEdit: () => void;
  onDelete: () => void;
  deleting?: boolean;
};

type BusyAction = "inspect" | "auth" | "cancel-auth" | "disconnect" | "refresh" | "probe" | null;
type MessageKey =
  | "connections.operations.inspectionReady"
  | "connections.operations.inspectionUnavailable"
  | "connections.operations.authPending"
  | "connections.operations.authCancelled"
  | "connections.operations.disconnected"
  | "connections.operations.disconnectRevoked"
  | "connections.operations.disconnectLocalRemoved"
  | "connections.operations.disconnectRevokePending"
  | "connections.operations.disconnectNotSupported"
  | "connections.operations.modelsUpdated"
  | "connections.operations.modelsUnavailable"
  | "connections.operations.probePassed"
  | "connections.operations.probeFailed"
  | "connections.operations.noModels"
  | "connections.operations.authMetadataInvalid"
  | "connections.operations.secureStorageUnavailable"
  | "connections.operations.providerUnavailable"
  | "connections.operations.protocolUnsupported"
  | "connections.operations.sessionExpired"
  | "connections.operations.authExpired"
  | "connections.operations.authDenied"
  | "connections.operations.error";

const statusLabels: Record<ProviderConnection["status"], TranslationKey> = {
  draft: "connections.status.draft",
  "authentication-required": "connections.status.authentication-required",
  testing: "connections.status.testing",
  ready: "connections.status.ready",
  degraded: "connections.status.degraded",
  expired: "connections.status.expired",
  unavailable: "connections.status.unavailable",
};
const transportLabels: Record<ConnectionTransport, TranslationKey> = {
  "local-cli": "connections.transport.local-cli",
  "codex-app-server": "connections.transport.codex-app-server",
  "http-inference": "connections.transport.http-inference",
  "remote-agent-api": "connections.transport.remote-agent-api",
};
const authLabels: Record<ConnectionAuthKind, TranslationKey> = {
  "existing-session": "connections.auth.existing-session",
  "browser-oauth": "connections.auth.browser-oauth",
  "device-code": "connections.auth.device-code",
  "api-key": "connections.auth.api-key",
  "custom-headers": "connections.auth.custom-headers",
};
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
const authFlowLabels: Record<ProviderAuthFlow["status"], TranslationKey> = {
  pending: "connections.operations.authPending",
  completed: "connections.operations.authCompleted",
  cancelled: "connections.operations.authCancelled",
  expired: "connections.operations.authExpired",
  denied: "connections.operations.authDenied",
  failed: "connections.operations.authFailed",
};

function InspectorReadout({ label, value, accent }: { label: string; value: string; accent?: "good" | "warn" | "signal" }) {
  const color = accent === "good" ? "text-chart-2" : accent === "warn" ? "text-chart-3" : accent === "signal" ? "text-chart-5" : "text-foreground";
  return <div className="min-w-0 border-l border-border px-3 py-2.5"><div className="bench-label">{label}</div><div className={`mt-1 truncate font-mono text-[10px] uppercase tracking-[0.08em] ${color}`}>{value}</div></div>;
}

export function ConnectionInspector({ connection, onConnectionChange, onEdit, onDelete, deleting = false }: Props) {
  const { t } = useI18n();
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [authFlow, setAuthFlow] = useState<ProviderAuthFlow | null>(null);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [message, setMessage] = useState<{ key: MessageKey; tone: "success" | "error" | "info" } | null>(null);
  const pollerRef = useRef<ReturnType<typeof createAuthFlowPoller> | null>(null);
  const onConnectionChangeRef = useRef(onConnectionChange);
  onConnectionChangeRef.current = onConnectionChange;

  useEffect(() => {
    let alive = true;
    const connectionId = connection?.id ?? null;
    const poller = createAuthFlowPoller({
      client: {
        startAuth: api.startConnectionAuth,
        getAuth: api.getConnectionAuth,
        cancelAuth: api.cancelConnectionAuth,
      },
      onFlow(flow) { if (alive) setAuthFlow(flow); },
      onError(error) { if (alive) setMessage({ key: connectionOperationErrorKey(error), tone: "error" }); },
      onTerminal(flow) {
        if (!alive || connectionId === null || flow.status !== "completed") return;
        void api.inspectConnection(connectionId)
          .then(({ connection: updated }) => { if (alive) onConnectionChangeRef.current(updated); })
          .catch((error) => { if (alive) setMessage({ key: connectionOperationErrorKey(error), tone: "error" }); });
      },
    });
    pollerRef.current = poller;
    setModels([]);
    setSelectedModelId(null);
    setAuthFlow(null);
    setBusy(null);
    setMessage(null);
    if (connectionId !== null) {
      void api.listConnectionModels(connectionId).then((catalog) => {
        if (!alive) return;
        setModels(catalog);
        setSelectedModelId(catalog[0]?.id ?? null);
      }).catch(() => {
        if (alive) setModels([]);
      });
    }
    return () => {
      alive = false;
      if (pollerRef.current === poller) pollerRef.current = null;
      void poller.dispose();
    };
  }, [connection?.id]);

  if (!connection) return <section className="flex min-h-72 items-center"><EmptyState title={t("connections.inspector")} description={t("connections.select")} /></section>;
  const isApi = connection.transport === "http-inference";
  const authMode = connection.authKind === "browser-oauth" || connection.authKind === "device-code" ? connection.authKind : null;
  const canAuthenticate = authMode !== null;
  const selectedProbe = probeSelectionForModel(connection.id, models, selectedModelId);
  const canProbe = connection.modelSelectionMode === "catalog" && selectedProbe !== null;
  const isPendingAuth = authFlow !== null && !isTerminalAuthFlow(authFlow);
  const actionBusy = (action: Exclude<BusyAction, null>) => busy === action;
  const busyElsewhere = busy !== null;

  const run = async (action: Exclude<BusyAction, null>, work: () => Promise<void>) => {
    if (busyElsewhere) return;
    setBusy(action);
    setMessage(null);
    try {
      await work();
    } catch (error) {
      setMessage({ key: connectionOperationErrorKey(error), tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  const inspect = () => void run("inspect", async () => {
    const result = await api.inspectConnection(connection.id);
    onConnectionChange(result.connection);
    setMessage({ key: result.inspection.available ? "connections.operations.inspectionReady" : "connections.operations.inspectionUnavailable", tone: result.inspection.available ? "success" : "info" });
  });
  const startAuth = () => {
    if (authMode === null) return;
    void run("auth", async () => {
      const poller = pollerRef.current;
      if (poller === null) throw new Error("Authentication flow is unavailable");
      await poller.start(connection.id, authMode);
    });
  };
  const cancelAuth = () => void run("cancel-auth", async () => {
    const cancelled = await pollerRef.current?.cancel();
    if (cancelled !== true) throw new Error("Unable to cancel the active authentication flow");
    setMessage({ key: "connections.operations.authCancelled", tone: "info" });
  });
  const disconnect = () => void run("disconnect", async () => {
    const disconnectResult = await api.disconnectConnectionAuth(connection.id);
    const result = await api.inspectConnection(connection.id);
    onConnectionChange(result.connection);
    setMessage(disconnectMessageForStatus(disconnectResult.status));
  });
  const refreshModels = () => void run("refresh", async () => {
    const result = await api.refreshConnectionModels(connection.id);
    onConnectionChange(result.connection);
    setModels(result.discovery.models);
    setSelectedModelId((current) => result.discovery.models.some((model) => model.id === current) ? current : result.discovery.models[0]?.id ?? null);
    setMessage({ key: result.discovery.safeError ? "connections.operations.modelsUnavailable" : "connections.operations.modelsUpdated", tone: result.discovery.safeError ? "info" : "success" });
  });
  const probe = () => {
    if (selectedProbe === null) {
      setMessage({ key: "connections.operations.noModels", tone: "info" });
      return;
    }
    void run("probe", async () => {
      const result = await api.probeConnection(connection.id, selectedProbe);
      onConnectionChange(result.connection);
      setMessage({ key: result.report.status === "passed" ? "connections.operations.probePassed" : "connections.operations.probeFailed", tone: result.report.status === "passed" ? "success" : "info" });
    });
  };

  return <section aria-labelledby="connection-inspector-title" className="min-w-0">
    <div className="flex min-h-12 flex-wrap items-start justify-between gap-4 border-b border-border px-4 py-3">
      <div className="min-w-0"><div className="bench-label">{t("connections.inspectorRoute", { id: connection.id.slice(0, 8).toUpperCase() })}</div><h2 id="connection-inspector-title" className="mt-1 truncate text-base font-semibold">{connection.name}</h2></div>
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={onEdit} disabled={busyElsewhere}><Pencil aria-hidden="true" className="size-3" />{t("connections.edit")}</Button><Button size="sm" variant="destructive" onClick={onDelete} disabled={deleting || busyElsewhere}>{deleting ? <span role="status" aria-live="polite">{t("connections.deleting")}</span> : <><Trash2 aria-hidden="true" className="size-3" />{t("connections.delete")}</>}</Button></div>
    </div>
    <div className="grid border-b border-border sm:grid-cols-2 xl:grid-cols-3">
      <InspectorReadout label={t("connections.provider")} value={connection.display.providerLabel} />
      <InspectorReadout label={t("connections.route")} value={connection.display.routeLabel} accent="signal" />
      <InspectorReadout label={t("connections.status")} value={t(statusLabels[connection.status])} accent={connection.status === "ready" ? "good" : connection.status === "degraded" || connection.status === "expired" ? "warn" : undefined} />
    </div>
    <div className="grid border-b border-border sm:grid-cols-2">
      <SignalRow icon={KeyRound} label={connection.display.secretConfigured ? t("connections.secretReady") : t("connections.secretMissing")} detail={connection.display.secretConfigured ? t("connections.editorDescription") : t("connections.secretHelp")} active={connection.display.secretConfigured} />
      <SignalRow icon={PlugZap} label={connection.display.endpointConfigured ? t("connections.endpointConfigured") : t("connections.metadataOnly")} detail={isApi ? t("connections.customBaseUrl") : t("connections.routeKind")} active={connection.display.endpointConfigured} />
    </div>
    <div className="grid gap-px bg-border sm:grid-cols-3" aria-label={t("connections.inspector")}>
      <MetaCell label={t("connections.transport")} value={t(transportLabels[connection.transport])} />
      <MetaCell label={t("connections.auth")} value={t(authLabels[connection.authKind])} />
      <MetaCell label={t("connections.protocol")} value={t(protocolLabels[connection.protocol])} />
    </div>
    <section aria-label={t("connections.operations.title")} className="space-y-4 border-t border-border px-4 py-4">
      <div className="flex flex-wrap items-center gap-2"><Button size="sm" variant="outline" onClick={inspect} disabled={busyElsewhere}><ShieldCheck aria-hidden="true" className="size-3" />{actionBusy("inspect") ? `${t("connections.operations.inspect")}…` : t("connections.operations.inspect")}</Button>{canAuthenticate && !isPendingAuth && <Button size="sm" variant="outline" onClick={startAuth} disabled={busyElsewhere}><LogIn aria-hidden="true" className="size-3" />{actionBusy("auth") ? `${t("connections.operations.authenticate")}…` : t("connections.operations.authenticate")}</Button>}{canAuthenticate && !isPendingAuth && <Button size="sm" variant="outline" onClick={disconnect} disabled={busyElsewhere}><Unplug aria-hidden="true" className="size-3" />{actionBusy("disconnect") ? `${t("connections.operations.disconnect")}…` : t("connections.operations.disconnect")}</Button>}</div>
      {message && <div role={message.tone === "error" ? "alert" : "status"} aria-live={message.tone === "error" ? "assertive" : "polite"} className={message.tone === "error" ? "border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive" : message.tone === "success" ? "border border-chart-2/40 bg-chart-2/10 px-3 py-2 text-xs text-chart-2" : "border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground"}>{t(message.key)}</div>}
      {authFlow && <AuthFlowPanel flow={authFlow} busy={busy} onCancel={cancelAuth} />}
      <div className="border-t border-border pt-4"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="bench-label">{t("connections.operations.modelCatalog")}</p><p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{t("connections.operations.modelCatalogHelp")}</p></div><Button size="sm" variant="outline" onClick={refreshModels} disabled={busyElsewhere}><RefreshCw aria-hidden="true" className="size-3" />{actionBusy("refresh") ? `${t("connections.operations.refreshModels")}…` : t("connections.operations.refreshModels")}</Button></div><div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]"><Select value={selectedModelId ?? ""} onValueChange={setSelectedModelId} disabled={models.length === 0 || busyElsewhere}><SelectTrigger aria-label={t("connections.operations.selectModel")} className="w-full"><SelectValue placeholder={t("connections.operations.noModels")} /></SelectTrigger><SelectContent>{models.map((model) => <SelectItem key={model.id} value={model.id}>{model.displayName || model.id}</SelectItem>)}</SelectContent></Select><Button size="sm" onClick={probe} disabled={!canProbe || busyElsewhere}><Play aria-hidden="true" className="size-3" />{actionBusy("probe") ? `${t("connections.operations.probe")}…` : t("connections.operations.probe")}</Button></div></div>
    </section>
  </section>;
}

function AuthFlowPanel({ flow, busy, onCancel }: { flow: ProviderAuthFlow; busy: BusyAction; onCancel: () => void }) {
  const { t } = useI18n();
  const pending = !isTerminalAuthFlow(flow);
  const presentation = pending ? authFlowPresentation(flow) : null;
  const href = presentation === null ? null : safeAuthUrl(presentation.authUrl) ?? safeAuthUrl(presentation.verificationUrl);
  return <section aria-label={t("connections.operations.authFlow")} className="border border-primary/35 bg-primary/[.05] p-3"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="bench-label text-primary">{t("connections.operations.authFlow")}</p><p className="mt-1 text-xs font-medium">{t(authFlowLabels[flow.status])}</p></div>{pending && <Button size="sm" variant="outline" onClick={onCancel} disabled={busy !== null}><XCircle aria-hidden="true" className="size-3" />{busy === "cancel-auth" ? `${t("connections.operations.cancelAuth")}…` : t("connections.operations.cancelAuth")}</Button>}</div>{presentation && <div className="mt-3 grid gap-2 text-xs text-muted-foreground">{href && <a href={href} target="_blank" rel="noreferrer" className="inline-flex w-fit items-center gap-1.5 text-primary underline underline-offset-4"><Link2 aria-hidden="true" className="size-3" />{t("connections.operations.openAuth")}</a>}{presentation.userCode && <p><span className="bench-label mr-2">{t("connections.operations.userCode")}</span><code className="font-mono text-foreground">{presentation.userCode}</code></p>}{presentation.expiresAt && <p><span className="bench-label mr-2">{t("connections.operations.expiresAt")}</span>{formatExpiry(presentation.expiresAt)}</p>}</div>}</section>;
}

function safeAuthUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function formatExpiry(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function SignalRow({ icon: Icon, label, detail, active }: { icon: typeof KeyRound; label: string; detail: string; active: boolean }) {
  return <div className="flex min-w-0 gap-3 border-r border-border px-4 py-3 last:border-r-0"><span className={`mt-0.5 flex size-6 shrink-0 items-center justify-center border ${active ? "border-chart-2/50 bg-chart-2/10 text-chart-2" : "border-border text-muted-foreground"}`}><Icon aria-hidden="true" className="size-3" /></span><span className="min-w-0"><span className="block text-xs font-medium">{label}</span><span className="mt-1 block text-[10px] leading-relaxed text-muted-foreground">{detail}</span></span></div>;
}

function MetaCell({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 bg-background px-4 py-3"><div className="bench-label">{label}</div><div className="mt-1 truncate font-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground">{value}</div></div>;
}
