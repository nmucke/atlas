import { PaperAttachments } from './PaperAttachments';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Archive,
  ArrowDownUp,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Bookmark,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  FolderClosed,
  Inbox,
  LibraryBig,
  LoaderCircle,
  Menu,
  Newspaper,
  Radar,
  LayoutDashboard,
  PanelRightClose,
  RefreshCw,
  Search,
  Sparkles,
  Star,
  Tags,
  X,
} from 'lucide-react';
import type {
  AppInfo,
  Collection,
  LibraryResponse,
  Paper,
  Project,
  ReadingStatus,
  Tag,
} from '../shared/types';
import { CollectionsPage } from './CollectionsPage';
import { AIRecordList, AssistantPage, InboxRecommendations, useAssistant } from './Assistant';
import { PaperTags } from './PaperTags';
import { PaperAISummary } from './PaperAISummary';
import { Recommendations } from './Recommendations';
import { Projects } from './Projects';
import { News, newsTitles, useNewsSummary, type NewsView } from './News';
import { NewsSources } from './NewsSources';
import { TagManager, type TagSection } from './TagManager';

const PdfReader = lazy(() => import('./PdfReader'));

type View = 'inbox' | 'all' | 'reading' | 'read' | 'starred' | 'archived';
type Sort = 'recent' | 'title' | 'year';
type Draft = { summary: string; notes: string };
type PaperPatch = Partial<Pick<Paper, 'status' | 'starred' | 'archived' | 'summary' | 'notes'>>;
const emptyPapers: Paper[] = [];
const emptyCollections: Collection[] = [];

const nav: { id: View; label: string; icon: typeof Inbox }[] = [
  { id: 'inbox', label: 'Inbox', icon: Inbox },
  { id: 'all', label: 'All papers', icon: LibraryBig },
  { id: 'reading', label: 'Reading', icon: BookOpen },
  { id: 'read', label: 'Read', icon: Check },
  { id: 'starred', label: 'Starred', icon: Star },
  { id: 'archived', label: 'Archived', icon: Archive },
];

const newsIcons: Record<NewsView, typeof Inbox> = {
  today: Newspaper,
  saved: Bookmark,
  added: Check,
  dismissed: Archive,
  sources: Radar,
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.method && init.method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* Keep the HTTP error. */
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

function dateLabel(value: string | null | undefined) {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

function relativeDate(value: string | null | undefined) {
  if (!value) return 'Not synced yet';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days < 0) return dateLabel(value);
  if (days === 0) return 'Synced today';
  if (days === 1) return 'Synced yesterday';
  if (days < 7) return `Synced ${days} days ago`;
  return `Synced ${dateLabel(value)}`;
}

function validLink(url: string): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

function paperAuthorLine(paper: Paper) {
  const names = paper.authors.filter(Boolean);
  if (!names.length) return 'Unknown author';
  if (names.length <= 2) return names.join(' · ');
  return `${names[0]} et al.`;
}

function itemTypeLabel(value: string) {
  if (!value) return 'Research paper';
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLocaleLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function matchesView(paper: Paper, view: View) {
  if (view === 'archived') return paper.archived;
  if (paper.archived) return false;
  if (view === 'all') return true;
  if (view === 'starred') return paper.starred;
  return paper.status === view;
}

function AtlasMark({ small = false }: { small?: boolean }) {
  return (
    <span className={`atlas-mark${small ? ' atlas-mark-small' : ''}`} aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

function SourceBadge({ paper }: { paper: Paper }) {
  return paper.sourceMissing ? (
    <span
      className="source-badge"
      title="This paper is no longer available in Zotero. Your Atlas notes are preserved."
    >
      <AlertCircle size={12} /> Unavailable in Zotero
    </span>
  ) : null;
}

export default function App() {
  const [library, setLibrary] = useState<LibraryResponse | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [view, setView] = useState<View>('all');
  const [page, setPage] = useState<
    'papers' | 'collections' | 'tags' | 'projects' | 'assistant' | 'recommendations' | 'news'
  >('papers');
  const [newsView, setNewsView] = useState<NewsView>('today');
  const [libraryOpen, setLibraryOpen] = useState(true);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [newsOpen, setNewsOpen] = useState(true);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectDirty, setProjectDirty] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(true);
  const [tagSection, setTagSection] = useState<TagSection>('all');
  const [collectionId, setCollectionId] = useState<string | null>(null);
  const [tag, setTag] = useState<Tag | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('recent');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [mobileInspector, setMobileInspector] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [reader, setReader] = useState<{ paperId: string; attachmentId: string } | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [actionId, setActionId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const assistant = useAssistant();
  const newsSummary = useNewsSummary();

  const load = useCallback(async (showLoader = false) => {
    if (showLoader) setLoading(true);
    try {
      const [nextLibrary, nextInfo] = await Promise.all([
        request<LibraryResponse>('/api/library'),
        request<AppInfo>('/api/info'),
      ]);
      setLibrary(nextLibrary);
      setInfo(nextInfo);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not load your library.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadProjects = useCallback(async () => {
    try {
      setProjects(await request<Project[]>('/api/projects'));
      setProjectsError(null);
    } catch (error) {
      setProjectsError(error instanceof Error ? error.message : 'Could not load projects.');
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const refreshProjectData = useCallback(async () => {
    await Promise.all([loadProjects(), load()]);
  }, [loadProjects, load]);

  const onZoteroChanged = async () => {
    await Promise.all([assistant.refresh(), refreshProjectData()]);
  };

  const completedZoteroRevision = useRef<string | null>(null);
  useEffect(() => {
    if (!assistant.data?.zotero) return;
    const revision = assistant.data.zotero.actions
      .filter((action) => action.status === 'completed')
      .map((action) => `${action.id}:${action.updatedAt}`)
      .sort()
      .join('|');
    if (completedZoteroRevision.current === null) {
      completedZoteroRevision.current = revision;
      return;
    }
    if (completedZoteroRevision.current !== revision) {
      completedZoteroRevision.current = revision;
      void refreshProjectData();
    }
  }, [assistant.data?.zotero, refreshProjectData]);

  const decideAI = async (id: string, approve: boolean) => {
    await assistant.decide(id, approve);
    await refreshProjectData();
  };

  useEffect(() => {
    if (!info?.sync.syncing || syncing) return;
    const timer = window.setInterval(async () => {
      try {
        const nextInfo = await request<AppInfo>('/api/info');
        setInfo(nextInfo);
        if (!nextInfo.sync.syncing) await load();
      } catch {
        /* Keep the visible state and retry. */
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [info?.sync.syncing, syncing, load]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const editing = target.matches('input, textarea, [contenteditable="true"]');
      if (
        (event.key === '/' && !editing) ||
        ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k')
      ) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (!mobileNav && !mobileInspector) return;
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || reader) return;
      setMobileNav(false);
      setMobileInspector(false);
    };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [mobileNav, mobileInspector, reader]);

  const papers = library?.papers ?? emptyPapers;
  const collections = library?.collections ?? emptyCollections;
  useEffect(() => {
    const hasUnsaved = papers.some((paper) => {
      const draft = drafts[paper.id];
      return draft && (draft.summary !== paper.summary || draft.notes !== paper.notes);
    });
    if (!hasUnsaved) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [papers, drafts]);
  const tags = library?.tags ?? [];
  const counts = useMemo(
    () =>
      Object.fromEntries(
        nav.map((item) => [item.id, papers.filter((paper) => matchesView(paper, item.id)).length]),
      ) as Record<View, number>,
    [papers],
  );
  const visiblePapers = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    const filtered = papers.filter((paper) => {
      if (!matchesView(paper, view)) return false;
      if (collectionId && !paper.collections.includes(collectionId)) return false;
      if (tag && !(tag.origin === 'atlas' ? paper.tags : paper.zoteroTags).includes(tag.name))
        return false;
      if (search) {
        const haystack = [
          paper.title,
          ...paper.authors,
          paper.publication,
          paper.year,
          paper.abstract,
          ...paper.tags,
          ...paper.zoteroTags,
        ]
          .join(' ')
          .toLocaleLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    });
    filtered.sort((a, b) => {
      if (sort === 'title') return a.title.localeCompare(b.title);
      if (sort === 'year')
        return (Number(b.year) || 0) - (Number(a.year) || 0) || a.title.localeCompare(b.title);
      return new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime();
    });
    return filtered;
  }, [papers, view, collectionId, tag, query, sort]);

  useEffect(() => {
    if (!visiblePapers.length) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !visiblePapers.some((paper) => paper.id === selectedId))
      setSelectedId(visiblePapers[0].id);
  }, [visiblePapers, selectedId]);

  const selected = papers.find((paper) => paper.id === selectedId) ?? null;
  const selectedDraft = selected
    ? (drafts[selected.id] ?? { summary: selected.summary, notes: selected.notes })
    : null;
  const dirty =
    !!selected &&
    !!selectedDraft &&
    (selectedDraft.summary !== selected.summary || selectedDraft.notes !== selected.notes);
  const activeCollection = collections.find((item) => item.id === collectionId);
  const title =
    page === 'news'
      ? newsTitles[newsView]
      : page === 'recommendations'
        ? 'Recommendations'
        : page === 'assistant'
          ? 'Assistant'
          : page === 'projects'
            ? (projects.find((project) => project.id === projectId)?.name ?? 'Dashboard')
            : page === 'collections'
              ? 'Collections'
              : page === 'tags'
                ? tagSection === 'all'
                  ? 'All tags'
                  : tagSection === 'zotero'
                    ? 'Zotero tags'
                    : tagSection
                : (activeCollection?.name ??
                  (tag
                    ? `# ${tag.name}`
                    : (nav.find((item) => item.id === view)?.label ?? 'Library')));
  const isSyncing = syncing || !!info?.sync.syncing;
  const isTagContext = page === 'tags' || tag !== null;

  const mayLeaveProject = () =>
    !projectDirty || window.confirm('You have unsaved project changes. Leave without saving?');

  const chooseProject = (id: string | null) => {
    if (page === 'projects' && id === projectId) {
      setMobileNav(false);
      return;
    }
    if (!mayLeaveProject()) return;
    setProjectDirty(false);
    setPage('projects');
    setProjectId(id);
    setMobileNav(false);
  };

  const chooseNews = (next: NewsView) => {
    if (!mayLeaveProject()) return;
    setProjectDirty(false);
    setPage('news');
    setNewsView(next);
    setCollectionId(null);
    setTag(null);
    setMobileNav(false);
  };

  const chooseAssistant = () => {
    if (!mayLeaveProject()) return;
    setProjectDirty(false);
    setPage('assistant');
    setMobileNav(false);
  };

  const openAIPaper = (id: string) => {
    if (!mayLeaveProject()) return;
    setProjectDirty(false);
    setPage('papers');
    // Archived papers are only listed in the Archived view; any other view would reselect.
    setView(papers.find((paper) => paper.id === id)?.archived ? 'archived' : 'all');
    setCollectionId(null);
    setTag(null);
    setQuery('');
    setSelectedId(id);
    setInspectorOpen(true);
    setMobileInspector(true);
    setMobileNav(false);
  };

  const chooseView = (next: View) => {
    if (!mayLeaveProject()) return;
    setProjectDirty(false);
    setPage('papers');
    setView(next);
    setCollectionId(null);
    setTag(null);
    setMobileNav(false);
  };

  const chooseCollection = (id: string) => {
    if (!mayLeaveProject()) return;
    setProjectDirty(false);
    setPage('papers');
    setView('all');
    setCollectionId(id);
    setTag(null);
    setQuery('');
    setMobileNav(false);
  };

  const chooseTag = (value: Tag) => {
    if (!mayLeaveProject()) return;
    setProjectDirty(false);
    setPage('papers');
    setView('all');
    setTag(value);
    setCollectionId(null);
    setQuery('');
    setMobileNav(false);
  };

  const chooseTagSection = (section: TagSection) => {
    if (!mayLeaveProject()) return;
    setProjectDirty(false);
    setPage('tags');
    setTagSection(section);
    setTag(null);
    setCollectionId(null);
    setMobileNav(false);
  };

  const sync = async () => {
    if (isSyncing) return;
    setSyncing(true);
    setSyncError(null);
    try {
      const nextState = await request<AppInfo['sync']>('/api/sync', { method: 'POST' });
      setInfo((previous) => (previous ? { ...previous, sync: nextState } : previous));
      if (nextState.error) setSyncError(nextState.error);
      await load();
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : 'Sync failed. Please try again.');
      await load();
    } finally {
      setSyncing(false);
    }
  };

  const updatePaper = async (paper: Paper, patch: PaperPatch) => {
    setActionId(paper.id);
    setActionError(null);
    try {
      const next = await request<Paper>(`/api/papers/${encodeURIComponent(paper.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      setLibrary((previous) =>
        previous
          ? {
              ...previous,
              papers: previous.papers.map((item) => (item.id === next.id ? next : item)),
            }
          : previous,
      );
      if (patch.archived !== undefined) await load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not update this paper.');
    } finally {
      setActionId(null);
    }
  };

  const updatePaperTags = async (paper: Paper, nextTags: string[]) => {
    const next = await request<Paper>(`/api/papers/${encodeURIComponent(paper.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ tags: nextTags }),
    });
    setLibrary((previous) =>
      previous
        ? {
            ...previous,
            papers: previous.papers.map((item) => (item.id === next.id ? next : item)),
          }
        : previous,
    );
    await load();
  };

  const saveDraft = async (paper: Paper) => {
    const draft = drafts[paper.id] ?? { summary: paper.summary, notes: paper.notes };
    if (draft.summary === paper.summary && draft.notes === paper.notes) return;
    setSavingId(paper.id);
    setSaveError(null);
    try {
      const next = await request<Paper>(`/api/papers/${encodeURIComponent(paper.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ summary: draft.summary, notes: draft.notes }),
      });
      setLibrary((previous) =>
        previous
          ? {
              ...previous,
              papers: previous.papers.map((item) => (item.id === next.id ? next : item)),
            }
          : previous,
      );
      setDrafts((previous) => {
        const current = previous[paper.id];
        if (current?.summary !== draft.summary || current?.notes !== draft.notes) return previous;
        const copy = { ...previous };
        delete copy[paper.id];
        return copy;
      });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Could not save your notes.');
    } finally {
      setSavingId(null);
    }
  };

  const updateDraft = (paper: Paper, key: keyof Draft, value: string) => {
    setSaveError(null);
    setDrafts((previous) => ({
      ...previous,
      [paper.id]: {
        ...(previous[paper.id] ?? { summary: paper.summary, notes: paper.notes }),
        [key]: value,
      },
    }));
  };

  const openPdf = (paper: Paper) => {
    const attachment = paper.attachments.find(
      (item) =>
        !item.hidden &&
        (item.contentType.toLowerCase().includes('pdf') ||
          item.filename.toLowerCase().endsWith('.pdf')),
    );
    if (attachment) setReader({ paperId: paper.id, attachmentId: attachment.id });
  };

  return (
    <div className="app-shell">
      {mobileNav && (
        <button
          className="mobile-scrim"
          aria-label="Close navigation"
          onClick={() => setMobileNav(false)}
        />
      )}
      <aside className={`sidebar${mobileNav ? ' sidebar-open' : ''}`}>
        <div className="brand">
          <AtlasMark />
          <span>
            atlas<span className="brand-period">.</span>
          </span>
          <button
            className="icon-button mobile-nav-close"
            aria-label="Close navigation"
            onClick={() => setMobileNav(false)}
          >
            <X size={19} />
          </button>
        </div>
        <div className="sidebar-content">
          <div className="sidebar-group">
            <button
              className="sidebar-heading sidebar-disclosure"
              onClick={() => setLibraryOpen((open) => !open)}
              aria-expanded={libraryOpen}
              aria-controls="library-navigation"
            >
              LIBRARY {libraryOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            {libraryOpen && (
              <nav aria-label="Library" id="library-navigation">
                {nav.map((item) => (
                  <button
                    key={item.id}
                    className={`nav-item nav-item-nested${page === 'papers' && view === item.id && !collectionId && !tag ? ' active' : ''}`}
                    onClick={() => chooseView(item.id)}
                    aria-current={
                      page === 'papers' && view === item.id && !collectionId && !tag
                        ? 'page'
                        : undefined
                    }
                  >
                    <item.icon size={17} strokeWidth={1.9} />
                    <span>{item.label}</span>
                    <span className="nav-count">{counts[item.id]}</span>
                  </button>
                ))}
                <button
                  className={`nav-item nav-item-nested${page === 'recommendations' ? ' active' : ''}`}
                  aria-current={page === 'recommendations' ? 'page' : undefined}
                  onClick={() => {
                    if (!mayLeaveProject()) return;
                    setProjectDirty(false);
                    setPage('recommendations');
                    setCollectionId(null);
                    setTag(null);
                    setMobileNav(false);
                  }}
                >
                  <Sparkles size={17} strokeWidth={1.9} />
                  <span>Recommendations</span>
                </button>
                <button
                  className={`nav-item nav-item-nested${page === 'collections' || !!collectionId ? ' active' : ''}`}
                  onClick={() => {
                    if (!mayLeaveProject()) return;
                    setProjectDirty(false);
                    setPage('collections');
                    setCollectionId(null);
                    setTag(null);
                    setMobileNav(false);
                  }}
                  aria-current={page === 'collections' ? 'page' : undefined}
                >
                  <FolderClosed size={17} strokeWidth={1.9} />
                  <span>Collections</span>
                  <span className="nav-count">{collections.length}</span>
                </button>
              </nav>
            )}
          </div>
          <div className="sidebar-group sidebar-future">
            <button
              className="sidebar-heading sidebar-disclosure"
              onClick={() => setProjectsOpen((open) => !open)}
              aria-expanded={projectsOpen}
              aria-controls="projects-navigation"
            >
              PROJECTS {projectsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            {projectsOpen && (
              <nav aria-label="Projects" id="projects-navigation">
                <button
                  className={`nav-item nav-item-nested${page === 'projects' && !projectId ? ' active' : ''}`}
                  onClick={() => chooseProject(null)}
                  aria-current={page === 'projects' && !projectId ? 'page' : undefined}
                >
                  <LayoutDashboard size={17} strokeWidth={1.9} />
                  <span>Dashboard</span>
                  <span className="nav-count">{projects.length}</span>
                </button>
                {projects.map((project) => (
                  <button
                    key={project.id}
                    className={`nav-item nav-item-nested${page === 'projects' && projectId === project.id ? ' active' : ''}`}
                    onClick={() => chooseProject(project.id)}
                    aria-current={
                      page === 'projects' && projectId === project.id ? 'page' : undefined
                    }
                    title={project.name}
                  >
                    <FolderClosed size={17} strokeWidth={1.9} />
                    <span className="truncate">{project.name}</span>
                  </button>
                ))}
              </nav>
            )}
          </div>
          <div className="sidebar-group">
            <button
              className="sidebar-heading sidebar-disclosure"
              onClick={() => setNewsOpen((open) => !open)}
              aria-expanded={newsOpen}
              aria-controls="news-navigation"
            >
              NEWS {newsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            {newsOpen && (
              <nav aria-label="News" id="news-navigation">
                {(['today', 'saved', 'added', 'dismissed', 'sources'] as const).map((item) => {
                  const active = page === 'news' && newsView === item;
                  const count =
                    item === 'today'
                      ? newsSummary.counts?.new
                      : item === 'sources'
                        ? newsSummary.suggestions
                        : newsSummary.counts?.[item];
                  const Icon = newsIcons[item];
                  return (
                    <button
                      key={item}
                      className={`nav-item nav-item-nested${active ? ' active' : ''}`}
                      onClick={() => chooseNews(item)}
                      aria-current={active ? 'page' : undefined}
                    >
                      <Icon size={17} strokeWidth={1.9} />
                      <span>{newsTitles[item]}</span>
                      {item === 'today' && !!count ? (
                        <span
                          className="news-nav-badge"
                          title={`${count} new · ${newsSummary.counts?.untriaged ?? 0} not ranked yet`}
                        >
                          {count}
                        </span>
                      ) : item === 'sources' ? (
                        !!count && (
                          <span className="nav-count" title={`${count} suggested sources waiting`}>
                            {count} new
                          </span>
                        )
                      ) : (
                        count !== undefined && <span className="nav-count">{count}</span>
                      )}
                    </button>
                  );
                })}
              </nav>
            )}
          </div>
          <div className="sidebar-group sidebar-dynamic">
            <button
              className="sidebar-heading sidebar-disclosure"
              onClick={() => setTagsOpen((open) => !open)}
              aria-expanded={tagsOpen}
              aria-controls="tags-navigation"
            >
              TAGS {tagsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            {tagsOpen && (
              <nav aria-label="Tags" id="tags-navigation">
                {(
                  [
                    ['all', 'All tags'],
                    ['method', 'method'],
                    ['data', 'data'],
                    ['domain', 'domain'],
                    ['model', 'model'],
                    ['task', 'task'],
                    ['zotero', 'Zotero tags'],
                  ] as const
                ).map(([section, label]) => (
                  <button
                    key={section}
                    className={`nav-item nav-item-small${page === 'tags' && tagSection === section ? ' active' : ''}`}
                    onClick={() => chooseTagSection(section)}
                    aria-current={page === 'tags' && tagSection === section ? 'page' : undefined}
                  >
                    <span className="tag-dot" />
                    <span className="truncate">{label}</span>
                    <span className="nav-count">
                      {
                        tags.filter((item) =>
                          section === 'zotero'
                            ? item.origin === 'zotero'
                            : item.origin === 'atlas' &&
                              (section === 'all' || item.category === section),
                        ).length
                      }
                    </span>
                  </button>
                ))}
              </nav>
            )}
          </div>
          <div className="sidebar-group">
            <div className="sidebar-heading">ASSISTANT</div>
            <nav aria-label="Assistant">
              <button
                className={`nav-item nav-item-nested${page === 'assistant' ? ' active' : ''}`}
                onClick={chooseAssistant}
                aria-current={page === 'assistant' ? 'page' : undefined}
              >
                <Sparkles size={17} strokeWidth={1.9} />
                <span>Profile & queue</span>
                {!!assistant.data?.records.filter((record) => record.status === 'pending')
                  .length && (
                  <span className="nav-count">
                    {assistant.data.records.filter((record) => record.status === 'pending').length}
                  </span>
                )}
              </button>
            </nav>
          </div>
        </div>
        <div className="sidebar-footer">
          <div className="sync-orbit">
            <RefreshCw size={15} className={isSyncing ? 'spin' : ''} />
          </div>
          <div className="sync-text">
            <strong>{isSyncing ? 'Syncing Zotero…' : 'Zotero library'}</strong>
            <span>{isSyncing ? 'This may take a moment' : relativeDate(info?.sync.lastSync)}</span>
          </div>
          <button
            className="footer-sync"
            onClick={() => void sync()}
            disabled={isSyncing}
            aria-label="Sync Zotero library"
            title="Sync Zotero library"
          >
            <RefreshCw size={15} className={isSyncing ? 'spin' : ''} />
          </button>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            aria-label="Open navigation"
            onClick={() => setMobileNav(true)}
          >
            <Menu size={20} />
          </button>
          <div className="breadcrumb">
            <button
              className="breadcrumb-link"
              onClick={() =>
                page === 'news'
                  ? chooseNews('today')
                  : page === 'assistant'
                    ? chooseAssistant()
                    : page === 'projects'
                      ? chooseProject(null)
                      : isTagContext
                        ? chooseTagSection('all')
                        : chooseView('all')
              }
            >
              {page === 'news'
                ? 'News'
                : page === 'assistant'
                  ? 'Workspace'
                  : page === 'projects'
                    ? 'Projects'
                    : isTagContext
                      ? 'Tags'
                      : 'Library'}
            </button>
            <ChevronRight size={14} />
            <strong>{title}</strong>
          </div>
          <div className="topbar-actions">
            <button className="top-sync" onClick={() => void sync()} disabled={isSyncing}>
              <RefreshCw size={15} className={isSyncing ? 'spin' : ''} />
              <span>{isSyncing ? 'Syncing…' : 'Sync library'}</span>
            </button>
            <span className="topbar-separator" />
            <div className="avatar" aria-label="Atlas workspace">
              A
            </div>
          </div>
        </header>

        {loadError && (
          <div className="notice error-notice" role="alert">
            <AlertCircle size={17} />
            <span>{loadError}</span>
            <button onClick={() => void load(true)}>Retry</button>
          </div>
        )}
        {(syncError || info?.sync.error) && (
          <div className="notice warning-notice" role="alert">
            <AlertCircle size={17} />
            <span>Sync issue: {syncError || info?.sync.error}</span>
            <button
              onClick={() => {
                setSyncError(null);
                void sync();
              }}
            >
              Retry sync
            </button>
          </div>
        )}
        {actionError && (
          <div className="notice error-notice" role="alert">
            <AlertCircle size={17} />
            <span>{actionError}</span>
            <button aria-label="Dismiss error" onClick={() => setActionError(null)}>
              <X size={16} />
            </button>
          </div>
        )}

        <div className="workspace">
          <section
            className={`library-panel${page === 'projects' ? ' projects-panel' : ''}`}
            aria-label={
              page === 'projects'
                ? 'Projects'
                : page === 'assistant'
                  ? 'Assistant'
                  : page === 'recommendations'
                    ? 'Recommendations'
                    : page === 'news'
                      ? 'News'
                      : 'Papers'
            }
          >
            {page === 'news' ? (
              newsView === 'sources' ? (
                <NewsSources onChanged={() => void newsSummary.refresh()} />
              ) : (
                <News
                  view={newsView}
                  projects={projects}
                  collections={collections}
                  onOpenPaper={openAIPaper}
                  onOpenProject={chooseProject}
                  onOpenSources={() => chooseNews('sources')}
                  onLibraryChanged={refreshProjectData}
                  onCounts={newsSummary.setCounts}
                />
              )
            ) : page === 'recommendations' ? (
              <Recommendations
                records={assistant.data?.records ?? []}
                papers={papers}
                projects={projects}
                loading={assistant.loading}
                error={assistant.error}
                onRefresh={assistant.refresh}
                onDecision={decideAI}
                onOpenPaper={openAIPaper}
                onOpenProject={chooseProject}
                onOpenAssistant={chooseAssistant}
                onSetStatus={(paper, status) => updatePaper(paper, { status })}
                onReadPdf={openPdf}
              />
            ) : page === 'assistant' ? (
              <AssistantPage
                data={assistant.data}
                loading={assistant.loading}
                error={assistant.error}
                papers={papers}
                projects={projects}
                profileDraft={assistant.profileDraft}
                onProfileDraftChange={assistant.setProfileDraft}
                onRefresh={assistant.refresh}
                onZoteroChanged={onZoteroChanged}
                onDecision={decideAI}
                onSaveProfile={assistant.saveProfile}
                onRebuildIndex={assistant.rebuildIndex}
                onOpenPaper={openAIPaper}
                onOpenProject={chooseProject}
              />
            ) : page === 'projects' ? (
              <Projects
                key={projectId ?? 'dashboard'}
                projectId={projectId}
                projects={projects}
                papers={papers}
                tags={tags}
                loading={projectsLoading}
                loadError={projectsError}
                onRetry={() => void loadProjects()}
                onOpen={chooseProject}
                onProjectsChanged={refreshProjectData}
                onDirtyChange={setProjectDirty}
                assistantRecords={assistant.data?.records ?? []}
                onAssistantDecision={decideAI}
              />
            ) : page === 'collections' ? (
              <CollectionsPage
                collections={collections}
                papers={papers}
                onOpen={chooseCollection}
                loading={loading && !library}
              />
            ) : page === 'tags' ? (
              <TagManager
                section={tagSection}
                tags={tags}
                loading={loading && !library}
                onOpen={chooseTag}
                onChanged={() => load()}
              />
            ) : (
              <>
                {collectionId && (
                  <button
                    className="context-back"
                    onClick={() => {
                      setPage('collections');
                      setCollectionId(null);
                    }}
                  >
                    <ChevronRight size={14} /> Back to collections
                  </button>
                )}
                {tag && (
                  <button
                    className="context-back"
                    onClick={() =>
                      chooseTagSection(tag.origin === 'zotero' ? 'zotero' : (tag.category ?? 'all'))
                    }
                  >
                    <ChevronRight size={14} /> Back to{' '}
                    {tag.origin === 'zotero' ? 'Zotero tags' : (tag.category ?? 'All tags')}
                  </button>
                )}
                <div className="page-heading">
                  <div>
                    <div className="eyebrow">YOUR RESEARCH SPACE</div>
                    <h1>{title}</h1>
                    <p>
                      {loading
                        ? 'Loading your library…'
                        : `${visiblePapers.length} ${visiblePapers.length === 1 ? 'paper' : 'papers'}${query || collectionId || tag ? ' in this view' : ''}`}
                    </p>
                  </div>
                  <button
                    className="mobile-inspector-button"
                    disabled={!selected}
                    onClick={() => setMobileInspector(true)}
                  >
                    <FileText size={17} /> Details
                  </button>
                </div>

                {view === 'inbox' && !collectionId && !tag && (
                  <InboxRecommendations
                    records={assistant.data?.records ?? []}
                    papers={papers}
                    projects={projects}
                    onDecision={decideAI}
                    onOpenPaper={openAIPaper}
                    onOpenProject={chooseProject}
                  />
                )}

                <div className="toolbar">
                  <label className="search-field">
                    <Search size={18} />
                    <input
                      ref={searchRef}
                      type="search"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="Search papers, authors, tags…"
                      aria-label="Search papers"
                    />
                    <kbd>⌘ K</kbd>
                  </label>
                  <label className="sort-select">
                    <ArrowDownUp size={16} />
                    <select
                      value={sort}
                      onChange={(event) => setSort(event.target.value as Sort)}
                      aria-label="Sort papers"
                    >
                      <option value="recent">Recently added</option>
                      <option value="title">Title A–Z</option>
                      <option value="year">Year (newest)</option>
                    </select>
                    <ChevronDown size={14} />
                  </label>
                </div>

                {(collectionId || tag) && (
                  <div className="filter-chip">
                    <span>
                      {collectionId ? <FolderClosed size={13} /> : <Tags size={13} />}
                      {activeCollection?.name ?? tag?.name}
                    </span>
                    <button
                      aria-label="Clear filter"
                      onClick={() => {
                        setCollectionId(null);
                        setTag(null);
                      }}
                    >
                      <X size={14} />
                    </button>
                  </div>
                )}

                <div className="paper-list">
                  {loading && !library ? (
                    <div className="loading-view">
                      <LoaderCircle className="spin" size={26} />
                      <span>Opening your library…</span>
                    </div>
                  ) : !papers.length && !loadError ? (
                    <div className="empty-state onboarding">
                      <div className="empty-art">
                        <div className="art-sheet art-back" />
                        <div className="art-sheet art-front">
                          <span />
                          <span />
                          <span />
                        </div>
                        <div className="art-star">✳</div>
                      </div>
                      <div className="empty-eyebrow">A SPACE TO THINK CLEARLY</div>
                      <h2>Your library starts here.</h2>
                      <p>
                        Bring in your Zotero papers, PDFs, collections, and tags. Then keep what
                        matters close as you read and write.
                      </p>
                      <button
                        className="primary-button"
                        onClick={() => void sync()}
                        disabled={isSyncing}
                      >
                        <RefreshCw size={16} className={isSyncing ? 'spin' : ''} />
                        {isSyncing ? 'Syncing your library…' : 'Sync with Zotero'}
                        <ArrowRight size={16} />
                      </button>
                      <div className="empty-footnote">
                        Your research will appear here after the first sync.
                      </div>
                    </div>
                  ) : !visiblePapers.length ? (
                    <div className="empty-state filtered-empty">
                      <div className="empty-icon">
                        <Search size={23} />
                      </div>
                      <h2>No papers here yet</h2>
                      <p>
                        {query
                          ? `No matches for “${query}”. Try another search or clear your filters.`
                          : 'Papers that match this view will appear here.'}
                      </p>
                      <button
                        className="text-button"
                        onClick={() => {
                          setQuery('');
                          setCollectionId(null);
                          setTag(null);
                          chooseView('all');
                        }}
                      >
                        View all papers <ArrowRight size={15} />
                      </button>
                    </div>
                  ) : (
                    visiblePapers.map((paper) => {
                      const pdf = paper.attachments.some(
                        (item) =>
                          !item.hidden &&
                          (item.contentType.toLowerCase().includes('pdf') ||
                            item.filename.toLowerCase().endsWith('.pdf')),
                      );
                      return (
                        <article
                          key={paper.id}
                          className={`paper-row${selectedId === paper.id ? ' selected' : ''}`}
                        >
                          <button
                            className="paper-select"
                            onClick={() => {
                              setSelectedId(paper.id);
                              setInspectorOpen(true);
                              setMobileInspector(true);
                            }}
                            aria-label={`Open details for ${paper.title}`}
                            aria-current={selectedId === paper.id ? 'true' : undefined}
                          >
                            <div className="paper-topline">
                              <span className="paper-type">{itemTypeLabel(paper.itemType)}</span>
                              {paper.year && <span className="paper-year">{paper.year}</span>}
                              <SourceBadge paper={paper} />
                            </div>
                            <h3>{paper.title || 'Untitled paper'}</h3>
                            <div className="paper-byline">
                              {paperAuthorLine(paper)}
                              {paper.publication && (
                                <>
                                  <span className="middle-dot">·</span>
                                  {paper.publication}
                                </>
                              )}
                            </div>
                            <div className="paper-bottomline">
                              <span className={`status-pill status-${paper.status}`}>
                                {paper.status === 'inbox'
                                  ? 'In inbox'
                                  : paper.status === 'reading'
                                    ? 'Reading'
                                    : 'Read'}
                              </span>
                              {paper.tags.slice(0, 2).map((item) => (
                                <span
                                  key={item}
                                  className="row-tag"
                                  title={
                                    tags.find((tag) => tag.origin === 'atlas' && tag.name === item)
                                      ?.description || 'No explanation yet'
                                  }
                                >
                                  {item}
                                </span>
                              ))}
                              {paper.tags.length > 2 && (
                                <span className="more-tags">+{paper.tags.length - 2}</span>
                              )}
                            </div>
                          </button>
                          <div className="paper-row-actions">
                            <button
                              className={`row-action${paper.starred ? ' is-starred' : ''}`}
                              onClick={() => void updatePaper(paper, { starred: !paper.starred })}
                              disabled={actionId === paper.id}
                              aria-label={paper.starred ? 'Remove star' : 'Star paper'}
                              title={paper.starred ? 'Remove star' : 'Star paper'}
                            >
                              <Star size={17} fill={paper.starred ? 'currentColor' : 'none'} />
                            </button>
                            {pdf && (
                              <button
                                className="row-action pdf-action"
                                onClick={() => openPdf(paper)}
                                aria-label={`Read PDF of ${paper.title}`}
                                title="Read PDF"
                              >
                                <FileText size={17} />
                              </button>
                            )}
                          </div>
                        </article>
                      );
                    })
                  )}
                </div>
              </>
            )}
          </section>

          {page === 'papers' && inspectorOpen && mobileInspector && (
            <button
              className="mobile-inspector-scrim"
              aria-label="Close paper details"
              onClick={() => setMobileInspector(false)}
            />
          )}
          {page === 'papers' && inspectorOpen && (
            <aside
              className={`inspector${mobileInspector ? ' inspector-mobile-open' : ''}`}
              aria-label="Paper details"
            >
              <div className="inspector-toolbar">
                <span>PAPER DETAILS</span>
                <div>
                  <button
                    className="icon-button mobile-inspector-close"
                    aria-label="Close details"
                    onClick={() => setMobileInspector(false)}
                  >
                    <X size={18} />
                  </button>
                  <button
                    className="icon-button desktop-inspector-close"
                    aria-label="Hide details"
                    onClick={() => setInspectorOpen(false)}
                    title="Hide details"
                  >
                    <PanelRightClose size={17} />
                  </button>
                </div>
              </div>
              {selected ? (
                <div className="inspector-scroll" key={selected.id}>
                  <div className="inspector-intro">
                    <div className="inspector-type">
                      <FileText size={15} /> {itemTypeLabel(selected.itemType)}{' '}
                      <SourceBadge paper={selected} />
                    </div>
                    <h2>{selected.title || 'Untitled paper'}</h2>
                    <p>
                      {selected.authors.length ? selected.authors.join(', ') : 'Unknown author'}
                    </p>
                    {selected.publication && (
                      <div className="publication-line">
                        {selected.publication}
                        {selected.year && ` · ${selected.year}`}
                      </div>
                    )}
                  </div>
                  <div className="inspector-actions">
                    <button
                      className={`quiet-action${selected.starred ? ' active-star' : ''}`}
                      onClick={() => void updatePaper(selected, { starred: !selected.starred })}
                      disabled={actionId === selected.id}
                    >
                      <Star size={16} fill={selected.starred ? 'currentColor' : 'none'} />{' '}
                      {selected.starred ? 'Starred' : 'Star'}
                    </button>
                    <button
                      className="quiet-action"
                      onClick={() => void updatePaper(selected, { archived: !selected.archived })}
                      disabled={actionId === selected.id}
                    >
                      <Archive size={16} /> {selected.archived ? 'Restore' : 'Archive'}
                    </button>
                  </div>
                  <div className="inspector-section">
                    <div className="section-label">READING STATUS</div>
                    <div className="status-options">
                      {(['inbox', 'reading', 'read'] as ReadingStatus[]).map((status) => (
                        <button
                          key={status}
                          className={selected.status === status ? 'chosen' : ''}
                          onClick={() => void updatePaper(selected, { status })}
                          disabled={actionId === selected.id}
                          aria-pressed={selected.status === status}
                        >
                          {status === 'inbox' ? 'Inbox' : status === 'reading' ? 'Reading' : 'Read'}
                        </button>
                      ))}
                    </div>
                  </div>
                  {!!selected.attachments.length && (
                    <PaperAttachments
                      key={`attachments:${selected.id}`}
                      attachments={selected.attachments}
                      onVisibilityChange={(id, hidden) =>
                        setLibrary((previous) =>
                          previous
                            ? {
                                ...previous,
                                papers: previous.papers.map((paper) =>
                                  paper.id === selected.id
                                    ? {
                                        ...paper,
                                        attachments: paper.attachments.map((item) =>
                                          item.id === id ? { ...item, hidden } : item,
                                        ),
                                      }
                                    : paper,
                                ),
                              }
                            : previous,
                        )
                      }
                      onRead={(id) => setReader({ paperId: selected.id, attachmentId: id })}
                    />
                  )}
                  <div className="inspector-section">
                    <div className="section-label">OVERVIEW</div>
                    <div className="detail-grid">
                      {selected.year && (
                        <>
                          <span>Year</span>
                          <strong>{selected.year}</strong>
                        </>
                      )}
                      {selected.publication && (
                        <>
                          <span>Published in</span>
                          <strong>{selected.publication}</strong>
                        </>
                      )}
                      {selected.doi && (
                        <>
                          <span>DOI</span>
                          <a
                            href={`https://doi.org/${encodeURIComponent(selected.doi)}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {selected.doi}
                            <ExternalLink size={13} />
                          </a>
                        </>
                      )}
                      {validLink(selected.url) && (
                        <>
                          <span>Source</span>
                          <a href={validLink(selected.url)!} target="_blank" rel="noreferrer">
                            Open link
                            <ExternalLink size={13} />
                          </a>
                        </>
                      )}
                      {selected.addedAt && (
                        <>
                          <span>Added</span>
                          <strong>{dateLabel(selected.addedAt)}</strong>
                        </>
                      )}
                    </div>
                  </div>
                  {!!selected.abstract && (
                    <div className="inspector-section">
                      <div className="section-label">ABSTRACT</div>
                      <p className="abstract-text">{selected.abstract}</p>
                    </div>
                  )}
                  {!!assistant.data?.records.some(
                    (record) =>
                      record.paperId === selected.id &&
                      (record.kind === 'review' || record.kind === 'tags') &&
                      record.status !== 'rejected',
                  ) && (
                    <div className="inspector-section assistant-inspector">
                      <div className="section-label">ASSISTANT PROPOSALS</div>
                      <AIRecordList
                        records={assistant.data.records.filter(
                          (record) =>
                            record.paperId === selected.id &&
                            (record.kind === 'review' || record.kind === 'tags') &&
                            record.status !== 'rejected',
                        )}
                        empty=""
                        onDecision={decideAI}
                      />
                    </div>
                  )}
                  <PaperTags
                    key={`tags:${selected.id}`}
                    paper={selected}
                    tags={tags}
                    onChange={(nextTags) => updatePaperTags(selected, nextTags)}
                    onOpen={chooseTag}
                  />
                  {!!selected.collections.length && (
                    <div className="inspector-section">
                      <div className="section-label">COLLECTIONS</div>
                      <div className="inspector-tags">
                        {selected.collections.map((id) => (
                          <button key={id} onClick={() => chooseCollection(id)}>
                            <FolderClosed size={13} />
                            {collections.find((item) => item.id === id)?.name ?? id}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <PaperAISummary records={assistant.data?.records ?? []} paperId={selected.id} />
                  <div className="inspector-section note-section">
                    <div className="section-label">
                      <span>HUMAN SUMMARY</span>
                      <span className="private-label">PRIVATE</span>
                    </div>
                    <textarea
                      value={selectedDraft?.summary ?? ''}
                      onChange={(event) => updateDraft(selected, 'summary', event.target.value)}
                      placeholder="Capture the main idea in your own words…"
                      rows={4}
                      aria-label="Human summary"
                    />
                  </div>
                  <div className="inspector-section note-section">
                    <div className="section-label">
                      <span>NOTES</span>
                      <span className="private-label">PRIVATE</span>
                    </div>
                    <textarea
                      value={selectedDraft?.notes ?? ''}
                      onChange={(event) => updateDraft(selected, 'notes', event.target.value)}
                      placeholder="Questions, connections, ideas to revisit…"
                      rows={6}
                      aria-label="Your notes"
                    />
                  </div>
                  <div className="save-area">
                    {saveError && (
                      <div className="field-error" role="alert">
                        {saveError}
                      </div>
                    )}
                    <div className="save-row">
                      <span>{dirty ? 'Unsaved changes' : 'Notes saved'}</span>
                      <button
                        className="save-button"
                        onClick={() => void saveDraft(selected)}
                        disabled={!dirty || savingId === selected.id}
                      >
                        {savingId === selected.id ? (
                          <LoaderCircle size={15} className="spin" />
                        ) : (
                          <Check size={15} />
                        )}
                        {savingId === selected.id ? 'Saving…' : 'Save notes'}
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="inspector-placeholder">
                  <FileText size={24} />
                  <p>Select a paper to see its details.</p>
                </div>
              )}
            </aside>
          )}
          {page === 'papers' && !inspectorOpen && !!selected && (
            <button
              className="reopen-inspector"
              onClick={() => setInspectorOpen(true)}
              title="Show details"
              aria-label="Show paper details"
            >
              <FileText size={17} />
            </button>
          )}
        </div>
      </main>
      {reader &&
        (() => {
          const paper = papers.find((item) => item.id === reader.paperId);
          const attachment = paper?.attachments.find((item) => item.id === reader.attachmentId);
          return paper && attachment ? (
            <Suspense
              fallback={
                <div className="reader-overlay reader-loading-overlay">
                  <LoaderCircle size={27} className="spin" />
                  <span>Opening reader…</span>
                </div>
              }
            >
              <PdfReader
                key={`${paper.id}:${attachment.id}`}
                paper={paper}
                attachment={attachment}
                onClose={() => setReader(null)}
              />
            </Suspense>
          ) : null;
        })()}
    </div>
  );
}
