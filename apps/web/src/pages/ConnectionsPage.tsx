import { useCallback, useEffect, useState } from "react";
import type { CreateProviderConnectionRequest, ProviderConnection, UpdateProviderConnectionRequest } from "@csb/shared";
import { Plus } from "lucide-react";

import { api } from "../api";
import { ConnectionEditorSheet } from "../components/connections/ConnectionEditorSheet";
import { ConnectionInspector } from "../components/connections/ConnectionInspector";
import { ConnectionList } from "../components/connections/ConnectionList";
import { SettingsSectionNav } from "../components/settings/SettingsSectionNav";
import { AlertBanner, EmptyState, Loading, PageHeader } from "../components/ui";
import { Button } from "@/components/ui/button";
import { selectConnection } from "../lib/connections";
import { connectionsLoadState, createMonotonicRequestGuard } from "../lib/connections-page-state";
import { useI18n } from "../i18n";

type EditorState = { open: false } | { open: true; connection: ProviderConnection | null };

export function ConnectionsPage() {
  const { t } = useI18n();
  const [connections, setConnections] = useState<ProviderConnection[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [editor, setEditor] = useState<EditorState>({ open: false });
  const [beginLoadRequest] = useState(createMonotonicRequestGuard);

  const load = useCallback(async () => {
    const isLatest = beginLoadRequest();
    setError(null);
    try {
      const next = await api.listConnections();
      if (!isLatest()) return;
      setConnections(next);
      setSelectedId((current) => selectConnection(next, current)?.id ?? null);
      setError(null);
    } catch {
      if (!isLatest()) return;
      setError(t("connections.error"));
    }
  }, [beginLoadRequest, t]);

  useEffect(() => {
    void load();
    return () => beginLoadRequest.invalidate();
  }, [beginLoadRequest, load]);

  const selected = selectConnection(connections ?? [], selectedId);
  const loadState = connectionsLoadState(connections, error);
  const saveCreated = async (body: CreateProviderConnectionRequest) => {
    const connection = await api.createConnection(body);
    setConnections((current) => [connection, ...(current ?? [])]);
    setSelectedId(connection.id);
    setNotice(t("connections.saved"));
  };
  const saveUpdated = async (id: string, body: UpdateProviderConnectionRequest) => {
    const connection = await api.updateConnection(id, body);
    setConnections((current) => (current ?? []).map((item) => item.id === id ? connection : item));
    setSelectedId(connection.id);
    setNotice(t("connections.saved"));
  };
  const remove = async () => {
    if (!selected || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await api.deleteConnection(selected.id);
      setConnections((current) => {
        const next = (current ?? []).filter((connection) => connection.id !== selected.id);
        setSelectedId(selectConnection(next, null)?.id ?? null);
        return next;
      });
      setNotice(t("connections.deleted"));
    } catch {
      setError(t("connections.deleteError"));
    } finally {
      setDeleting(false);
    }
  };

  return <div>
    <SettingsSectionNav />
    <PageHeader code={t("connections.moduleCode")} title={t("connections.title")} description={t("connections.description")} actions={<Button size="sm" onClick={() => setEditor({ open: true, connection: null })}><Plus aria-hidden="true" className="size-3" />{t("connections.add")}</Button>} />
    {error && loadState !== "error" && <AlertBanner>{error}</AlertBanner>}
    {notice && <AlertBanner tone="success">{notice}</AlertBanner>}
    {loadState === "loading" ? <Loading label={t("connections.loading")} /> : loadState === "error" ? <section className="bench-panel bench-corners"><div role="alert" aria-live="assertive" className="flex flex-col items-center gap-4 px-5 py-12 text-center"><p className="text-sm font-semibold text-destructive">{error}</p><Button type="button" onClick={() => void load()}>{t("common.retry")}</Button></div></section> : loadState === "empty" ? <section className="bench-panel bench-corners"><EmptyState title={t("connections.empty")} description={t("connections.emptyDescription")} /></section> : <section className="bench-panel bench-corners min-w-0 overflow-hidden"><div className="grid min-w-0 lg:grid-cols-[minmax(18rem,.72fr)_minmax(0,1.28fr)]"><ConnectionList connections={connections!} selectedId={selected?.id ?? null} onSelect={setSelectedId} /><ConnectionInspector connection={selected} onConnectionChange={(next) => setConnections((current) => (current ?? []).map((item) => item.id === next.id ? next : item))} onEdit={() => setEditor({ open: true, connection: selected })} onDelete={() => void remove()} deleting={deleting} /></div></section>}
    <ConnectionEditorSheet open={editor.open} connection={editor.open ? editor.connection : null} onOpenChange={(open) => setEditor(open ? { open: true, connection: editor.open ? editor.connection : null } : { open: false })} onCreate={saveCreated} onUpdate={saveUpdated} />
  </div>;
}
