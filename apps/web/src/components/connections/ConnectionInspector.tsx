import type { ConnectionAuthKind, ConnectionTransport, ProviderConnection, ProviderProtocol } from "@csb/shared";
import { KeyRound, Pencil, PlugZap, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "../ui";
import { type TranslationKey, useI18n } from "../../i18n";

type Props = {
  connection: ProviderConnection | null;
  onEdit: () => void;
  onDelete: () => void;
  deleting?: boolean;
};

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

function InspectorReadout({ label, value, accent }: { label: string; value: string; accent?: "good" | "warn" | "signal" }) {
  const color = accent === "good" ? "text-chart-2" : accent === "warn" ? "text-chart-3" : accent === "signal" ? "text-chart-5" : "text-foreground";
  return <div className="min-w-0 border-l border-border px-3 py-2.5"><div className="bench-label">{label}</div><div className={`mt-1 truncate font-mono text-[10px] uppercase tracking-[0.08em] ${color}`}>{value}</div></div>;
}

export function ConnectionInspector({ connection, onEdit, onDelete, deleting = false }: Props) {
  const { t } = useI18n();
  if (!connection) return <section className="flex min-h-72 items-center"><EmptyState title={t("connections.inspector")} description={t("connections.select")} /></section>;
  const isApi = connection.transport === "http-inference";
  return <section aria-labelledby="connection-inspector-title" className="min-w-0">
    <div className="flex min-h-12 items-start justify-between gap-4 border-b border-border px-4 py-3">
      <div className="min-w-0"><div className="bench-label">{t("connections.inspectorRoute", { id: connection.id.slice(0, 8).toUpperCase() })}</div><h2 id="connection-inspector-title" className="mt-1 truncate text-base font-semibold">{connection.name}</h2></div>
      <div className="flex shrink-0 gap-2"><Button size="sm" variant="outline" onClick={onEdit}><Pencil aria-hidden="true" className="size-3" />{t("connections.edit")}</Button><Button size="sm" variant="destructive" onClick={onDelete} disabled={deleting}>{deleting ? <span role="status" aria-live="polite">{t("connections.deleting")}</span> : <><Trash2 aria-hidden="true" className="size-3" />{t("connections.delete")}</>}</Button></div>
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
    <div className="border-t border-chart-5/30 bg-chart-5/5 px-4 py-3"><p className="font-mono text-[9px] leading-5 text-muted-foreground">{t("connections.editorDescription")}</p></div>
  </section>;
}

function SignalRow({ icon: Icon, label, detail, active }: { icon: typeof KeyRound; label: string; detail: string; active: boolean }) {
  return <div className="flex min-w-0 gap-3 border-r border-border px-4 py-3 last:border-r-0"><span className={`mt-0.5 flex size-6 shrink-0 items-center justify-center border ${active ? "border-chart-2/50 bg-chart-2/10 text-chart-2" : "border-border text-muted-foreground"}`}><Icon aria-hidden="true" className="size-3" /></span><span className="min-w-0"><span className="block text-xs font-medium">{label}</span><span className="mt-1 block text-[10px] leading-relaxed text-muted-foreground">{detail}</span></span></div>;
}

function MetaCell({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 bg-background px-4 py-3"><div className="bench-label">{label}</div><div className="mt-1 truncate font-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground">{value}</div></div>;
}
