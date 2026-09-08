import { useEffect, useState } from "react";
import { githubMonitorApi } from "../../lib/github-monitor-api";
import { useScopedI18n } from "../../i18n/scoped";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

const messages = {
  "pt-BR": { all: "Todas as branches, incluindo novas", specific: "Branches específicas", allHint: "Novas branches serão acompanhadas automaticamente. O estado inicial não dispara scans retroativos.", search: "Buscar branch", loading: "Carregando branches…", error: "Não foi possível carregar as branches.", retry: "Atualizar lista", empty: "Nenhuma branch encontrada.", saved: "Seleções salvas fora desta lista", hint: "Selecione até 20 branches do repositório. A busca apenas filtra a lista." },
  en: { all: "All branches, including new ones", specific: "Specific branches", allHint: "New branches will be followed automatically. The initial state does not trigger retroactive scans.", search: "Search branches", loading: "Loading branches…", error: "Could not load branches.", retry: "Refresh list", empty: "No branches found.", saved: "Saved selections outside this list", hint: "Select up to 20 repository branches. Search only filters the list." },
  es: { all: "Todas las branches, incluidas las nuevas", specific: "Branches específicas", allHint: "Las nuevas branches se seguirán automáticamente. El estado inicial no lanza scans retroactivos.", search: "Buscar branch", loading: "Cargando branches…", error: "No se pudieron cargar las branches.", retry: "Actualizar lista", empty: "No se encontraron branches.", saved: "Selecciones guardadas fuera de esta lista", hint: "Selecciona hasta 20 branches del repositorio. La búsqueda solo filtra la lista." },
  de: { all: "Alle Branches, auch neue", specific: "Bestimmte Branches", allHint: "Neue Branches werden automatisch verfolgt. Der Ausgangszustand löst keine rückwirkenden Scans aus.", search: "Branches suchen", loading: "Branches werden geladen…", error: "Branches konnten nicht geladen werden.", retry: "Liste aktualisieren", empty: "Keine Branches gefunden.", saved: "Gespeicherte Auswahl außerhalb dieser Liste", hint: "Bis zu 20 Repository-Branches auswählen. Die Suche filtert nur die Liste." },
  fr: { all: "Toutes les branches, y compris les nouvelles", specific: "Branches spécifiques", allHint: "Les nouvelles branches seront suivies automatiquement. L’état initial ne déclenche aucune analyse rétroactive.", search: "Rechercher une branche", loading: "Chargement des branches…", error: "Impossible de charger les branches.", retry: "Actualiser la liste", empty: "Aucune branche trouvée.", saved: "Sélections enregistrées hors de cette liste", hint: "Sélectionnez jusqu’à 20 branches du dépôt. La recherche filtre uniquement la liste." },
};

export function GitHubBranchPicker({ id, repositoryKey, value, onChange, allowAll = false }: { allowAll?: boolean; id?: string; repositoryKey: string; value: string[]; onChange: (branches: string[]) => void }) {
  const { t } = useScopedI18n(messages);
  const [state, setState] = useState<{ key: string; branches: string[]; loading: boolean; error: boolean }>({ key: "", branches: [], loading: true, error: false });
  const allBranches = allowAll && value.includes("*");
  const [specific, setSpecific] = useState(value.filter((name) => name !== "*"));
  useEffect(() => { if (!value.includes("*")) setSpecific(value); }, [value.join("\n")]);
  const [query, setQuery] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setQuery("");
    setState({ key: repositoryKey, branches: [], loading: true, error: false });
    void githubMonitorApi.branches(repositoryKey).then((branches) => {
      if (active) setState({ key: repositoryKey, branches, loading: false, error: false });
    }).catch(() => { if (active) setState({ key: repositoryKey, branches: [], loading: false, error: true }); });
    return () => { active = false; };
  }, [repositoryKey, refresh]);
  const loading = state.key !== repositoryKey || state.loading;
  const branches = state.key === repositoryKey ? state.branches : [];
  const missing = value.filter((name) => !branches.includes(name));
  const toggle = (name: string) => onChange(value.includes(name) ? value.filter((item) => item !== name) : [...value, name]);
  const choice = (name: string) => <label key={name} className="flex min-h-10 cursor-pointer items-center gap-3 px-3 py-2 text-xs hover:bg-secondary"><input type="checkbox" className="size-4 shrink-0 accent-primary" checked={value.includes(name)} disabled={!value.includes(name) && value.length >= 20} onChange={() => toggle(name)} /><span className="min-w-0 break-all font-mono">{name}</span></label>;
  const visible = branches.filter((name) => name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <div className="min-w-0 space-y-2">
    {allowAll && <fieldset className="space-y-2 border p-3">
      <label className="flex min-h-10 items-center gap-3 text-xs"><input type="radio" name={`branch-scope-${repositoryKey}`} checked={allBranches} onChange={() => onChange(["*"])} />{t("all")}</label>
      <label className="flex min-h-10 items-center gap-3 text-xs"><input type="radio" name={`branch-scope-${repositoryKey}`} checked={!allBranches} onChange={() => onChange(specific)} />{t("specific")}</label>
      {allBranches && <p className="text-xs text-muted-foreground">{t("allHint")}</p>}
    </fieldset>}
    {!allBranches && <>

    <div className="flex gap-2"><Input id={id} aria-label={t("search")} placeholder={t("search")} value={query} onChange={(event) => setQuery(event.target.value)} /><Button type="button" variant="outline" size="sm" disabled={loading} onClick={() => setRefresh((n) => n + 1)}>{t("retry")}</Button></div>
    <p className="text-xs text-muted-foreground">{t("hint")}</p>
    {loading ? <p role="status" className="text-xs">{t("loading")}</p> : state.error ? <p role="alert" className="text-xs text-destructive">{t("error")}</p> : <div className="max-h-52 overflow-y-auto border" role="group" aria-label={t("search")}>{visible.length ? visible.map(choice) : <p className="p-3 text-xs text-muted-foreground">{t("empty")}</p>}</div>}
    {!loading && missing.length > 0 && <div className="border border-border"><p className="px-3 pt-2 text-xs text-muted-foreground">{t("saved")}</p>{missing.map(choice)}</div>}
    </>}
  </div>;
}
