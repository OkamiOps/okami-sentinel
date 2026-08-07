import { useCallback, useEffect, useMemo, useState } from "react";
import type { FsListResponse } from "@csb/shared";
import { ArrowUp, ChevronRight, Folder, FolderOpen, Keyboard } from "lucide-react";

import { api } from "../../api";
import { cx } from "../ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";

export function RepositoryDirectoryBrowser({
  active,
  value,
  onChange,
}: {
  active: boolean;
  value: string;
  onChange: (path: string) => void;
}) {
  const [directory, setDirectory] = useState<FsListResponse | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualPath, setManualPath] = useState(value);
  const [initialRequested, setInitialRequested] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openDirectory = useCallback(async (path?: string) => {
    setLoading(true);
    setError(null);
    try {
      const next = await api.listFs(path?.trim() || undefined);
      setDirectory(next);
      setManualPath(next.path);
      onChange(next.path);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível abrir esta pasta");
    } finally {
      setLoading(false);
    }
  }, [onChange]);

  useEffect(() => {
    if (!active || initialRequested) return;
    setInitialRequested(true);
    void openDirectory(value || undefined);
  }, [active, initialRequested, openDirectory, value]);

  const folders = useMemo(
    () => directory?.entries.filter((entry) => entry.isDirectory) ?? [],
    [directory],
  );

  return (
    <div className="overflow-hidden border" aria-busy={loading}>
      <div className="grid gap-3 border-b bg-secondary/30 p-3 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center">
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={loading || !directory?.parent}
          onClick={() => directory?.parent && void openDirectory(directory.parent)}
        >
          <ArrowUp aria-hidden size={14} />Subir
        </Button>
        <div className="min-w-0">
          <div className="bench-label text-primary">PASTA ATUAL / SERÁ CADASTRADA</div>
          <div className="mt-1 flex min-w-0 items-center gap-2">
            <FolderOpen aria-hidden size={14} className="shrink-0 text-primary" />
            <span className="truncate font-mono text-[10px]" title={directory?.path ?? "Carregando"}>{directory?.path ?? "Carregando…"}</span>
          </div>
        </div>
      </div>

      {error && (
        <div role="alert" className="flex items-center justify-between gap-3 border-b border-destructive/50 bg-destructive/[.08] px-3 py-2 text-xs text-destructive">
          <span>{error}</span>
          <Button type="button" variant="outline" className="min-h-9" onClick={() => void openDirectory(manualPath || undefined)}>Tentar novamente</Button>
        </div>
      )}

      <ScrollArea className="h-64">
        <div className="min-h-full">
          {loading && !directory ? (
            <div className="grid h-64 place-items-center font-mono text-[10px] text-muted-foreground">LENDO DIRETÓRIOS…</div>
          ) : folders.length ? folders.map((entry) => (
            <Button
              key={entry.path}
              type="button"
              variant="ghost"
              className="grid h-auto min-h-12 w-full grid-cols-[1.5rem_minmax(0,1fr)_auto] justify-start gap-2 whitespace-normal rounded-none border-x-0 border-t-0 px-3 text-left"
              disabled={loading}
              onClick={() => void openDirectory(entry.path)}
            >
              <Folder aria-hidden size={14} className="text-muted-foreground" />
              <span className="truncate font-mono text-[10px] text-foreground">{entry.name}</span>
              <span className="flex items-center gap-1 font-mono text-[8px] text-muted-foreground">ABRIR <ChevronRight aria-hidden size={12} /></span>
            </Button>
          )) : (
            <div className="grid h-64 place-items-center px-6 text-center text-xs leading-5 text-muted-foreground">Esta pasta não contém outros diretórios. Você ainda pode cadastrá-la como repositório.</div>
          )}
        </div>
      </ScrollArea>

      <div className="border-t p-3">
        <Button
          type="button"
          variant="ghost"
          className="min-h-11 w-full justify-start"
          aria-expanded={manualOpen}
          onClick={() => setManualOpen((current) => !current)}
        >
          <Keyboard aria-hidden size={14} />Já sei o caminho absoluto
        </Button>
        {manualOpen && (
          <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
            <Input
              aria-label="Caminho absoluto manual"
              className="min-h-11 font-mono text-xs"
              value={manualPath}
              onChange={(event) => setManualPath(event.target.value)}
            />
            <Button type="button" variant="outline" className="min-h-11" disabled={loading || !manualPath.trim()} onClick={() => void openDirectory(manualPath)}>Abrir caminho</Button>
          </div>
        )}
      </div>
    </div>
  );
}
