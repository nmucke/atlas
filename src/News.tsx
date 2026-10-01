import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  AlertCircle,
  Bookmark,
  BookmarkCheck,
  Check,
  ChevronDown,
  Database,
  ExternalLink,
  FileText,
  FolderClosed,
  GitBranch,
  Keyboard,
  Link2,
  LoaderCircle,
  Newspaper,
  Plus,
  Radar,
  RefreshCw,
  RotateCcw,
  Search,
  ThumbsDown,
  ThumbsUp,
  X,
} from 'lucide-react';
import type {
  NewsAddToZoteroInput,
  NewsAddToZoteroResult,
  NewsCollectStatus,
  NewsDismissReason,
  NewsFeedbackAction,
  NewsItem,
  NewsItemKind,
  NewsResponse,
  NewsState,
} from '../shared/news';
import type { Collection, Project } from '../shared/types';
import { errorMessage, request, send } from './api';
import type { NewsSourcesResponse } from './NewsSources';
import type { ZoteroStatus } from './ZoteroActions';
import './news.css';

export type NewsView = 'today' | 'saved' | 'added' | 'dismissed' | 'sources';
export type NewsCounts = NewsResponse['counts'];

export const newsTitles: Record<NewsView, string> = {
  today: 'Today',
  saved: 'Saved',
  added: 'Added',
  dismissed: 'Dismissed',
  sources: 'Sources',
};

const viewState: Record<Exclude<NewsView, 'sources'>, NewsState> = {
  today: 'new',
  saved: 'saved',
  added: 'added',
  dismissed: 'dismissed',
};

const PAGE_SIZE = 100;
const POLL_MS = 1500;
const LAST_COLLECTION_KEY = 'atlas.news.lastCollection';

const dismissReasons: { id: NewsDismissReason; label: string }[] = [
  { id: 'not_relevant', label: 'Not relevant' },
  { id: 'already_known', label: 'Already know it' },
  { id: 'low_quality', label: 'Low quality' },
  { id: 'less_from_source', label: 'Less from this source' },
];

type KindFilter = 'all' | 'paper' | 'post' | 'repo' | 'dataset';
const kindFilters: { id: KindFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'paper', label: 'Papers' },
  { id: 'post', label: 'Posts' },
  { id: 'repo', label: 'Repos & releases' },
  { id: 'dataset', label: 'Datasets' },
];
const kindGroup = (kind: NewsItemKind): KindFilter => (kind === 'release' ? 'repo' : kind);
const kindLabel: Record<NewsItemKind, string> = {
  paper: 'Paper',
  post: 'Post',
  repo: 'Repo',
  release: 'Release',
  dataset: 'Dataset',
};
const kindIcon: Record<NewsItemKind, typeof FileText> = {
  paper: FileText,
  post: Newspaper,
  repo: GitBranch,
  release: GitBranch,
  dataset: Database,
};

const scaleWords = [
  '',
  'Unlikely match',
  'Weak match',
  'Worth a look',
  'Good match',
  'Strong match',
];
const featureLabels: Record<string, string> = {
  lex: 'Matches your profile and projects',
  follow: 'From an author or work you follow',
  fresh: 'Freshness',
  sourcePrior: 'Source track record',
  neg: 'Similar to items you turned down',
};

function readStorage(key: string) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* Storage can be unavailable; the choice just isn't remembered. */
  }
}

function safeUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function age(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function timeLabel(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? `today ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
    : date.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
}

function authorLine(authors: string[]) {
  const names = authors.filter(Boolean);
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} et al.`;
}

function relevance(item: NewsItem) {
  if (item.triage) {
    const score = Math.max(1, Math.min(5, Math.round(item.triage.score)));
    return {
      bars: score,
      word: scaleWords[score],
      title: `Assistant rating ${score}/5 · ranking score ${Math.round(item.score * 100)}%`,
    };
  }
  const bars = Math.max(1, Math.min(5, Math.ceil(item.score * 5)));
  return {
    bars,
    word: `Est. ${scaleWords[bars].toLocaleLowerCase()}`,
    title: `Estimated relevance ${Math.round(item.preScore * 100)}% · not ranked by your assistant yet`,
  };
}

function isTyping(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.matches('input, textarea, select, [contenteditable="true"], [role="textbox"]')
  );
}

/** Nav counts for the sidebar. Reads only; collection never starts from here. */
export function useNewsSummary() {
  const [counts, setCounts] = useState<NewsCounts | null>(null);
  const [suggestions, setSuggestions] = useState(0);
  const refresh = useCallback(async () => {
    const [news, sources] = await Promise.allSettled([
      request<NewsResponse>('/api/news?state=new&limit=1'),
      request<NewsSourcesResponse>('/api/news/sources'),
    ]);
    if (news.status === 'fulfilled') setCounts(news.value.counts);
    if (sources.status === 'fulfilled') setSuggestions(sources.value.suggestions.length);
  }, []);
  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);
  return { counts, suggestions, refresh, setCounts };
}

interface Toast {
  id: number;
  message: string;
  undo?: () => Promise<void>;
  dismissedId?: string;
  reason?: NewsDismissReason | null;
}

interface Note {
  text: string;
  warn?: string;
}

interface ItemProblem {
  message: string;
  retry?: () => void;
  authorize?: boolean;
}

interface NewsProps {
  view: Exclude<NewsView, 'sources'>;
  projects: Project[];
  collections: Collection[];
  onOpenPaper: (paperId: string) => void;
  onOpenProject: (projectId: string) => void;
  onOpenSources: () => void;
  onLibraryChanged: () => Promise<void> | void;
  onCounts: (counts: NewsCounts) => void;
}

export function News({
  view,
  projects,
  collections,
  onOpenPaper,
  onOpenProject,
  onOpenSources,
  onLibraryChanged,
  onCounts,
}: NewsProps) {
  const state = viewState[view];
  const [items, setItems] = useState<NewsItem[]>([]);
  const [total, setTotal] = useState(0);
  const [lastTriageAt, setLastTriageAt] = useState<string | null>(null);
  const [collect, setCollect] = useState<NewsCollectStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [collectError, setCollectError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [kind, setKind] = useState<KindFilter>('all');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  const [popover, setPopover] = useState<{ id: string; mode: 'zotero' | 'project' } | null>(null);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [problems, setProblems] = useState<Record<string, ItemProblem>>({});
  const [notes, setNotes] = useState<Record<string, Note>>({});
  const [toast, setToast] = useState<Toast | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const helpRef = useRef<HTMLDialogElement>(null);
  const loadNumber = useRef(0);
  const toastTimer = useRef<number | undefined>(undefined);
  const lastZotero = useRef<Record<string, NewsAddToZoteroInput>>({});
  const countsRef = useRef<NewsCounts | null>(null);

  const publishCounts = useCallback(
    (counts: NewsCounts) => {
      countsRef.current = counts;
      onCounts(counts);
    },
    [onCounts],
  );

  const load = useCallback(async () => {
    const number = ++loadNumber.current;
    setLoading(true);
    try {
      const next = await request<NewsResponse>(
        `/api/news?state=${state}&limit=${PAGE_SIZE}&offset=0`,
      );
      if (number !== loadNumber.current) return;
      setItems(next.items);
      setTotal(next.counts[state] ?? next.items.length);
      setLastTriageAt(next.lastTriageAt);
      setCollect(next.collect);
      publishCounts(next.counts);
      setLoadError(null);
    } catch (error) {
      if (number === loadNumber.current) setLoadError(errorMessage(error, 'Could not load News.'));
    } finally {
      if (number === loadNumber.current) setLoading(false);
    }
  }, [state, publishCounts]);

  useEffect(() => {
    setItems([]);
    setExpanded(new Set());
    setFocusId(null);
    setPopover(null);
    setProblems({});
    setNotes({});
    void load();
  }, [load]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const next = await request<NewsResponse>(
        `/api/news?state=${state}&limit=${PAGE_SIZE}&offset=${items.length}`,
      );
      setItems((previous) => {
        const seen = new Set(previous.map((item) => item.id));
        return [...previous, ...next.items.filter((item) => !seen.has(item.id))];
      });
      setTotal(next.counts[state] ?? total);
      publishCounts(next.counts);
    } catch (error) {
      setLoadError(errorMessage(error, 'Could not load more items.'));
    } finally {
      setLoadingMore(false);
    }
  };

  // Poll while a collection runs (started here or by the assistant workflow), then reload once.
  const running = !!collect?.running;
  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const status = await request<NewsCollectStatus>('/api/news/collect');
        if (cancelled) return;
        setCollect(status);
        if (!status.running) void load();
      } catch {
        /* Keep the visible state and try again. */
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [running, load]);

  const startCollect = async () => {
    if (running || starting) return;
    setStarting(true);
    setCollectError(null);
    try {
      const status = await send<NewsCollectStatus>('/api/news/collect', 'POST');
      setCollect(status);
      if (!status.running) await load();
    } catch (error) {
      setCollectError(errorMessage(error, 'Could not start collecting.'));
    } finally {
      setStarting(false);
    }
  };

  const showToast = useCallback((next: Omit<Toast, 'id'>) => {
    window.clearTimeout(toastTimer.current);
    setToast({ ...next, id: Date.now() });
    toastTimer.current = window.setTimeout(() => setToast(null), 9000);
  }, []);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const adjustCounts = (from: NewsState, to: NewsState) => {
    const counts = countsRef.current;
    if (!counts || from === to) return;
    publishCounts({
      ...counts,
      [from]: Math.max(0, (counts[from] ?? 0) - 1),
      [to]: (counts[to] ?? 0) + 1,
    });
  };

  const replaceItem = (next: NewsItem) =>
    setItems((previous) => previous.map((item) => (item.id === next.id ? next : item)));

  const withBusy = async (id: string, key: string, action: () => Promise<void>) => {
    setBusy((previous) => ({ ...previous, [id]: key }));
    setProblems((previous) => {
      const copy = { ...previous };
      delete copy[id];
      return copy;
    });
    try {
      await action();
    } finally {
      setBusy((previous) => {
        const copy = { ...previous };
        delete copy[id];
        return copy;
      });
    }
  };

  const postState = (id: string, next: 'new' | 'saved' | 'dismissed', reason?: NewsDismissReason) =>
    send<NewsItem>(`/api/news/items/${encodeURIComponent(id)}/state`, 'POST', {
      state: next,
      ...(reason ? { reason } : {}),
    });

  const reinsert = (item: NewsItem, index: number) =>
    setItems((previous) => {
      if (previous.some((entry) => entry.id === item.id)) return previous;
      const copy = [...previous];
      copy.splice(Math.min(index, copy.length), 0, item);
      return copy;
    });

  const removeFromList = (item: NewsItem) => {
    const index = items.findIndex((entry) => entry.id === item.id);
    const ordered = orderedRef.current;
    const position = ordered.findIndex((entry) => entry.id === item.id);
    const neighbour = ordered[position + 1] ?? ordered[position - 1] ?? null;
    setItems((previous) => previous.filter((entry) => entry.id !== item.id));
    setTotal((value) => Math.max(0, value - 1));
    if (focusId === item.id) setFocusId(neighbour?.id ?? null);
    return index;
  };

  const dismiss = (item: NewsItem) =>
    withBusy(item.id, 'dismiss', async () => {
      const previousState: 'new' | 'saved' = item.state === 'saved' ? 'saved' : 'new';
      try {
        await postState(item.id, 'dismissed');
      } catch (error) {
        setProblems((previous) => ({
          ...previous,
          [item.id]: { message: errorMessage(error, 'Could not dismiss this item.') },
        }));
        return;
      }
      const index = removeFromList(item);
      adjustCounts(item.state, 'dismissed');
      showToast({
        message: `Dismissed “${item.title}”`,
        dismissedId: item.id,
        reason: null,
        undo: async () => {
          const restored = await postState(item.id, previousState);
          reinsert(restored, index);
          setTotal((value) => value + 1);
          adjustCounts('dismissed', restored.state);
          setFocusId(restored.id);
        },
      });
    });

  const restore = (item: NewsItem) =>
    withBusy(item.id, 'restore', async () => {
      try {
        const restored = await postState(item.id, 'new');
        const index = removeFromList(item);
        adjustCounts('dismissed', restored.state);
        showToast({
          message: `Restored “${item.title}” to Today`,
          undo: async () => {
            const again = await postState(item.id, 'dismissed', item.dismissReason ?? undefined);
            reinsert(again, index);
            setTotal((value) => value + 1);
            adjustCounts(restored.state, 'dismissed');
          },
        });
      } catch (error) {
        setProblems((previous) => ({
          ...previous,
          [item.id]: { message: errorMessage(error, 'Could not restore this item.') },
        }));
      }
    });

  const chooseReason = async (reason: NewsDismissReason) => {
    if (!toast?.dismissedId) return;
    const id = toast.dismissedId;
    setToast((current) =>
      current && current.dismissedId === id ? { ...current, reason } : current,
    );
    try {
      await postState(id, 'dismissed', reason);
    } catch (error) {
      showToast({ message: errorMessage(error, 'Could not save the reason.') });
    }
  };

  const toggleSave = (item: NewsItem) =>
    withBusy(item.id, 'save', async () => {
      const next = item.state === 'saved' ? 'new' : 'saved';
      try {
        const updated = await postState(item.id, next);
        replaceItem(updated);
        adjustCounts(item.state, updated.state);
        showToast({
          message: next === 'saved' ? 'Saved for later' : 'Removed from Saved',
          undo: async () => {
            const back = await postState(item.id, item.state === 'saved' ? 'saved' : 'new');
            setItems((previous) =>
              previous.some((entry) => entry.id === back.id)
                ? previous.map((entry) => (entry.id === back.id ? back : entry))
                : previous,
            );
            adjustCounts(updated.state, back.state);
          },
        });
      } catch (error) {
        setProblems((previous) => ({
          ...previous,
          [item.id]: { message: errorMessage(error, 'Could not save this item.') },
        }));
      }
    });

  const feedback = (item: NewsItem, action: NewsFeedbackAction) => {
    if (action === 'open') {
      void send<NewsItem>(`/api/news/items/${encodeURIComponent(item.id)}/feedback`, 'POST', {
        action,
      }).catch(() => undefined);
      return;
    }
    void withBusy(item.id, action, async () => {
      try {
        replaceItem(
          await send<NewsItem>(`/api/news/items/${encodeURIComponent(item.id)}/feedback`, 'POST', {
            action,
          }),
        );
        showToast({
          message: action === 'more' ? 'Noted: more like this' : 'Noted: fewer items like this one',
        });
      } catch (error) {
        setProblems((previous) => ({
          ...previous,
          [item.id]: { message: errorMessage(error, 'Could not save your feedback.') },
        }));
      }
    });
  };

  const addToZotero = (item: NewsItem, input: NewsAddToZoteroInput) => {
    lastZotero.current[item.id] = input;
    setPopover(null);
    void withBusy(item.id, 'zotero', async () => {
      try {
        const result = await send<NewsAddToZoteroResult>(
          `/api/news/items/${encodeURIComponent(item.id)}/zotero`,
          'POST',
          input,
        );
        replaceItem(result.item);
        adjustCounts(item.state, result.item.state);
        const projectName = input.projectId
          ? (projects.find((project) => project.id === input.projectId)?.name ?? 'the project')
          : null;
        setNotes((previous) => ({
          ...previous,
          [item.id]: {
            text: `Added to Zotero${result.pdf === 'attached' ? ' with its PDF' : ''}${projectName ? ` · linked to ${projectName}` : ''}.`,
            warn:
              result.pdf === 'failed'
                ? `PDF not attached${result.pdfError ? ` (${result.pdfError})` : ''}. The item was added; you can attach the PDF in Zotero.`
                : undefined,
          },
        }));
        showToast({ message: `Added “${item.title}” to Zotero` });
        await onLibraryChanged();
      } catch (error) {
        const message = errorMessage(error, 'Could not add this item to Zotero.');
        setProblems((previous) => ({
          ...previous,
          [item.id]: {
            message,
            retry: () => addToZotero(item, input),
            authorize: /authori[sz]|allow atlas|write access|permission/i.test(message),
          },
        }));
      }
    });
  };

  const authorizeAndRetry = (item: NewsItem) =>
    withBusy(item.id, 'authorize', async () => {
      try {
        await send<unknown>('/api/zotero/authorize', 'POST');
      } catch (error) {
        setProblems((previous) => ({
          ...previous,
          [item.id]: {
            message: errorMessage(error, 'Zotero did not grant write access.'),
            retry: () => authorizeAndRetry(item),
          },
        }));
        return;
      }
      const input = lastZotero.current[item.id];
      if (input) window.setTimeout(() => addToZotero(item, input), 0);
    });

  const linkProject = (item: NewsItem, projectId: string) => {
    setPopover(null);
    void withBusy(item.id, 'project', async () => {
      try {
        replaceItem(
          await send<NewsItem>(`/api/news/items/${encodeURIComponent(item.id)}/project`, 'POST', {
            projectId,
          }),
        );
        const name = projects.find((project) => project.id === projectId)?.name ?? 'the project';
        setNotes((previous) => ({ ...previous, [item.id]: { text: `Linked to ${name}.` } }));
        await onLibraryChanged();
      } catch (error) {
        setProblems((previous) => ({
          ...previous,
          [item.id]: {
            message: errorMessage(error, 'Could not link this paper to the project.'),
            retry: () => linkProject(item, projectId),
          },
        }));
      }
    });
  };

  const toggleExpanded = (id: string) =>
    setExpanded((previous) => {
      const copy = new Set(previous);
      if (copy.has(id)) copy.delete(id);
      else copy.add(id);
      return copy;
    });

  // Filtering and sections (keyboard order follows the rendered order).
  const kindCounts = useMemo(() => {
    const counts: Record<KindFilter, number> = { all: 0, paper: 0, post: 0, repo: 0, dataset: 0 };
    for (const item of items) {
      counts.all += 1;
      counts[kindGroup(item.kind)] += 1;
    }
    return counts;
  }, [items]);

  const visible = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return items.filter((item) => {
      if (kind !== 'all' && kindGroup(item.kind) !== kind) return false;
      if (!search) return true;
      return [
        item.title,
        item.abstract,
        item.venue ?? '',
        item.triage?.why ?? '',
        ...item.authors,
        ...item.sources.map((source) => source.label),
      ]
        .join(' ')
        .toLocaleLowerCase()
        .includes(search);
    });
  }, [items, kind, query]);

  const sections = useMemo(() => {
    if (view !== 'today') return [{ id: 'all', title: '', hint: '', items: visible }];
    const top = visible.filter((item) => item.triage && item.triage.score >= 4);
    const ranked = visible.filter((item) => item.triage && item.triage.score < 4);
    const unranked = visible.filter((item) => !item.triage);
    return [
      { id: 'top', title: 'TOP PICKS', hint: 'Your assistant rated these 4–5', items: top },
      {
        id: 'ranked',
        title: 'MORE FOR YOU',
        hint: 'Ranked lower by your assistant',
        items: ranked,
      },
      {
        id: 'unranked',
        title: 'NOT YET RANKED',
        hint: 'Ordered by an estimate from your profile, projects and sources',
        items: unranked,
      },
    ].filter((section) => section.items.length);
  }, [visible, view]);

  const ordered = useMemo(() => sections.flatMap((section) => section.items), [sections]);
  const orderedRef = useRef(ordered);
  orderedRef.current = ordered;

  const focusCard = (id: string) => {
    setFocusId(id);
    window.requestAnimationFrame(() => {
      const element = document.getElementById(`news-item-${id}`);
      element?.focus({ preventScroll: true });
      element?.scrollIntoView({ block: 'nearest' });
    });
  };

  // Keyboard shortcuts; ignored while typing, with modifiers, or while a dialog/popover is open.
  const keyHandler = useRef<(event: KeyboardEvent) => void>(() => undefined);
  keyHandler.current = (event: KeyboardEvent) => {
    if (event.defaultPrevented && event.key !== '/') return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (isTyping(event.target)) return;
    if (helpRef.current?.open) return;
    if (popover) {
      if (event.key === 'Escape') setPopover(null);
      return;
    }
    const list = orderedRef.current;
    const index = list.findIndex((item) => item.id === focusId);
    const current = index >= 0 ? list[index] : null;
    const key = event.key;
    if (key === '/') {
      event.preventDefault();
      searchRef.current?.focus();
      return;
    }
    if (key === '?') {
      event.preventDefault();
      helpRef.current?.showModal();
      return;
    }
    if (key === 'j' || key === 'k') {
      if (!list.length) return;
      event.preventDefault();
      const next =
        index < 0 ? 0 : Math.max(0, Math.min(list.length - 1, index + (key === 'j' ? 1 : -1)));
      focusCard(list[next].id);
      return;
    }
    if (key === 'u') {
      if (!toast?.undo) return;
      event.preventDefault();
      void runUndo();
      return;
    }
    if (toast?.dismissedId && /^[1-4]$/.test(key)) {
      event.preventDefault();
      void chooseReason(dismissReasons[Number(key) - 1].id);
      return;
    }
    if (!current || busy[current.id]) return;
    if (key === 'o') {
      event.preventDefault();
      toggleExpanded(current.id);
    } else if (key === 's') {
      event.preventDefault();
      void toggleSave(current);
    } else if (key === 'd') {
      event.preventDefault();
      void (current.state === 'dismissed' ? restore(current) : dismiss(current));
    } else if (key === 'z') {
      if (current.kind !== 'paper' || current.paperId) return;
      event.preventDefault();
      setPopover({ id: current.id, mode: 'zotero' });
    }
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => keyHandler.current(event);
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const runUndo = async () => {
    const undo = toast?.undo;
    if (!undo) return;
    setToast(null);
    try {
      await undo();
      showToast({ message: 'Undone' });
    } catch (error) {
      showToast({ message: errorMessage(error, 'Could not undo.') });
    }
  };

  const collectLine = () => {
    if (!collect) return null;
    if (collect.running)
      return (
        <span>
          <LoaderCircle size={13} className="spin" /> Collecting from your sources…
          {collect.fetched ? ` ${collect.fetched} fetched so far` : ''}
        </span>
      );
    if (!collect.finishedAt)
      return <span>Not collected yet. Press Refresh to check your sources.</span>;
    return (
      <span>
        Collected {timeLabel(collect.finishedAt)} · {collect.fetched} fetched · {collect.added} new
      </span>
    );
  };

  const emptyText =
    view === 'today'
      ? 'Nothing new right now. Press Refresh to check your sources, or add more sources.'
      : view === 'saved'
        ? 'Nothing saved yet. Press s on an item, or use Save, to keep it here.'
        : view === 'added'
          ? 'Papers you add to Zotero from News appear here.'
          : 'Dismissed items appear here, so you can restore them.';

  return (
    <div className="news-page">
      <div className="page-heading news-heading">
        <div>
          <div className="eyebrow">NEWS</div>
          <h1>{newsTitles[view]}</h1>
          <p>
            {view === 'today'
              ? `${total} new item${total === 1 ? '' : 's'} from your sources`
              : `${total} item${total === 1 ? '' : 's'}`}
          </p>
        </div>
        <section className="news-run-card" aria-label="Collection status">
          <div className="news-run-row" aria-live="polite">
            {collectLine()}
          </div>
          <div className="news-run-row">
            <span>
              {lastTriageAt
                ? `Last ranked by your assistant ${timeLabel(lastTriageAt)}`
                : 'Not ranked by your assistant yet'}
            </span>
          </div>
          {!!collect?.errors.length && !collect.running && (
            <details className="news-run-errors">
              <summary>
                <AlertCircle size={13} /> {collect.errors.length} source
                {collect.errors.length === 1 ? '' : 's'} failed
              </summary>
              <ul>
                {collect.errors.map((error) => (
                  <li key={error.sourceId}>
                    <strong>{error.label}</strong>: {error.message}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className="news-run-actions">
            <button
              className="news-btn primary"
              onClick={() => void startCollect()}
              disabled={running || starting}
            >
              <RefreshCw size={13} className={running || starting ? 'spin' : ''} />
              {running ? 'Collecting…' : 'Refresh'}
            </button>
            <button className="news-btn ghost" onClick={onOpenSources}>
              <Radar size={13} /> Sources
            </button>
            <button
              className="news-btn ghost icon"
              onClick={() => helpRef.current?.showModal()}
              aria-label="Keyboard shortcuts"
              title="Keyboard shortcuts (?)"
            >
              <Keyboard size={14} />
            </button>
          </div>
        </section>
      </div>
      <p className="news-hint">
        Nothing runs automatically: Refresh collects from your sources. To rank and explain items,
        ask your assistant to run the <code>atlas-news-scan</code> workflow.
      </p>

      {collectError && (
        <div className="assistant-page-error news-error" role="alert">
          <AlertCircle size={15} />
          <span>{collectError}</span>
          <button className="news-btn" onClick={() => void startCollect()}>
            <RotateCcw size={13} /> Retry
          </button>
        </div>
      )}
      {loadError && (
        <div className="assistant-page-error news-error" role="alert">
          <AlertCircle size={15} />
          <span>{loadError}</span>
          <button className="news-btn" onClick={() => void load()}>
            <RotateCcw size={13} /> Retry
          </button>
        </div>
      )}

      <div className="news-filterbar" role="toolbar" aria-label="Filter news">
        <div className="news-seg">
          {kindFilters.map((filter) => (
            <button
              key={filter.id}
              aria-pressed={kind === filter.id}
              onClick={() => setKind(filter.id)}
            >
              {filter.label} <span>{kindCounts[filter.id]}</span>
            </button>
          ))}
        </div>
        <label className="search-field news-search">
          <Search size={14} />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setQuery('');
                event.currentTarget.blur();
              }
            }}
            placeholder="Filter these items"
            aria-label="Filter items"
          />
          <kbd>/</kbd>
        </label>
      </div>

      {loading && !items.length ? (
        <p className="news-empty" role="status">
          <LoaderCircle size={15} className="spin" /> Loading News…
        </p>
      ) : !ordered.length ? (
        !loadError && (
          <div className="news-empty">
            <p>{items.length ? 'No items match this filter.' : emptyText}</p>
            {!items.length && view === 'today' && (
              <div className="news-empty-actions">
                <button
                  className="news-btn primary"
                  onClick={() => void startCollect()}
                  disabled={running || starting}
                >
                  <RefreshCw size={13} className={running ? 'spin' : ''} /> Refresh
                </button>
                <button className="news-btn" onClick={onOpenSources}>
                  <Radar size={13} /> Manage sources
                </button>
              </div>
            )}
          </div>
        )
      ) : (
        sections.map((section) => (
          <section key={section.id} aria-label={section.title || newsTitles[view]}>
            {section.title && (
              <div className="news-section-head">
                <h2>{section.title}</h2>
                <p>{section.hint}</p>
              </div>
            )}
            <div className="news-feed">
              {section.items.map((item) => (
                <NewsCard
                  key={item.id}
                  item={item}
                  focused={focusId === item.id}
                  expanded={expanded.has(item.id)}
                  busy={busy[item.id] ?? null}
                  problem={problems[item.id] ?? null}
                  note={notes[item.id] ?? null}
                  popover={popover?.id === item.id ? popover.mode : null}
                  projects={projects}
                  collections={collections}
                  onFocus={() => setFocusId(item.id)}
                  onToggleExpanded={() => toggleExpanded(item.id)}
                  onOpen={() => feedback(item, 'open')}
                  onFeedback={(action) => feedback(item, action)}
                  onSave={() => void toggleSave(item)}
                  onDismiss={() => void dismiss(item)}
                  onRestore={() => void restore(item)}
                  onPopover={(mode) => setPopover(mode ? { id: item.id, mode } : null)}
                  onAddToZotero={(input) => addToZotero(item, input)}
                  onLinkProject={(projectId) => linkProject(item, projectId)}
                  onAuthorize={() => void authorizeAndRetry(item)}
                  onOpenPaper={onOpenPaper}
                  onOpenProject={onOpenProject}
                />
              ))}
            </div>
          </section>
        ))
      )}

      {items.length < total && !loading && (
        <div className="news-more">
          <button className="news-btn" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore && <LoaderCircle size={13} className="spin" />} Load more (
            {total - items.length} left)
          </button>
        </div>
      )}

      <div className="news-toast-region" role="status" aria-live="polite">
        {toast && (
          <div className="news-toast" key={toast.id}>
            <div className="news-toast-row">
              <span>{toast.message}</span>
              {toast.undo && (
                <button className="news-btn" onClick={() => void runUndo()}>
                  Undo <kbd>u</kbd>
                </button>
              )}
              <button
                className="news-btn ghost icon"
                aria-label="Close notification"
                onClick={() => setToast(null)}
              >
                <X size={13} />
              </button>
            </div>
            {toast.dismissedId && (
              <div className="news-reasons" role="group" aria-label="Why dismiss? Optional">
                {dismissReasons.map((reason, index) => (
                  <button
                    key={reason.id}
                    aria-pressed={toast.reason === reason.id}
                    onClick={() => void chooseReason(reason.id)}
                  >
                    <kbd>{index + 1}</kbd>
                    {reason.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <dialog ref={helpRef} className="news-help" aria-labelledby="news-help-title">
        <h2 id="news-help-title">Keyboard shortcuts</h2>
        <div className="news-keys">
          {(
            [
              ['Next / previous item', 'j k'],
              ['Expand abstract and details', 'o'],
              ['Add paper to Zotero', 'z'],
              ['Save / unsave', 's'],
              ['Dismiss (restore in Dismissed)', 'd'],
              ['Reason after dismissing', '1–4'],
              ['Undo', 'u'],
              ['Filter items', '/'],
              ['This help', '?'],
            ] as const
          ).map(([label, keys]) => (
            <div key={label}>
              <span>{label}</span>
              <span>
                {keys.split(' ').map((value) => (
                  <kbd key={value}>{value}</kbd>
                ))}
              </span>
            </div>
          ))}
        </div>
        <p>Shortcuts are ignored while you type in a field.</p>
        <form method="dialog">
          <button className="news-btn primary">Close</button>
        </form>
      </dialog>
    </div>
  );
}

interface CardProps {
  item: NewsItem;
  focused: boolean;
  expanded: boolean;
  busy: string | null;
  problem: ItemProblem | null;
  note: Note | null;
  popover: 'zotero' | 'project' | null;
  projects: Project[];
  collections: Collection[];
  onFocus: () => void;
  onToggleExpanded: () => void;
  onOpen: () => void;
  onFeedback: (action: 'more' | 'less') => void;
  onSave: () => void;
  onDismiss: () => void;
  onRestore: () => void;
  onPopover: (mode: 'zotero' | 'project' | null) => void;
  onAddToZotero: (input: NewsAddToZoteroInput) => void;
  onLinkProject: (projectId: string) => void;
  onAuthorize: () => void;
  onOpenPaper: (paperId: string) => void;
  onOpenProject: (projectId: string) => void;
}

function NewsCard({
  item,
  focused,
  expanded,
  busy,
  problem,
  note,
  popover,
  projects,
  collections,
  onFocus,
  onToggleExpanded,
  onOpen,
  onFeedback,
  onSave,
  onDismiss,
  onRestore,
  onPopover,
  onAddToZotero,
  onLinkProject,
  onAuthorize,
  onOpenPaper,
  onOpenProject,
}: CardProps) {
  const Icon = kindIcon[item.kind];
  const url = safeUrl(item.url);
  const meter = relevance(item);
  const when = age(item.publishedAt ?? item.firstSeenAt);
  const titleId = `news-title-${item.id}`;
  const detailsId = `news-details-${item.id}`;
  const projectNames = (item.triage?.projectIds ?? [])
    .map((id) => projects.find((project) => project.id === id))
    .filter((project): project is Project => !!project);
  const isPaper = item.kind === 'paper';
  const inLibrary = !!item.paperId;
  const saved = item.state === 'saved';
  const features = Object.entries(item.features).filter(([, value]) => Number.isFinite(value));

  return (
    <article
      id={`news-item-${item.id}`}
      className={`news-card${focused ? ' is-focused' : ''}${expanded ? ' is-expanded' : ''}`}
      tabIndex={-1}
      aria-labelledby={titleId}
      onFocus={onFocus}
      onMouseDown={onFocus}
    >
      <div className="news-card-body">
        <div className="news-topline">
          <span className={`news-type news-type-${kindGroup(item.kind)}`}>
            <Icon size={12} />
            {kindLabel[item.kind]}
          </span>
          {inLibrary && (
            <span className="news-badge news-badge-lib">
              <Check size={11} /> In your library
            </span>
          )}
          {item.state === 'saved' && <span className="news-badge news-badge-saved">Saved</span>}
          <span className="news-source">
            {[item.sources.map((source) => source.label).join(', '), when]
              .filter(Boolean)
              .join(' · ')}
          </span>
          <span className="news-meter" title={meter.title}>
            <span className="news-bars" aria-hidden="true">
              {[1, 2, 3, 4, 5].map((value) => (
                <i key={value} className={value <= meter.bars ? 'on' : ''} />
              ))}
            </span>
            <span className="news-sr-only">{meter.title}.</span>
            {meter.word}
          </span>
        </div>
        <h3 className="news-title">
          {url ? (
            <a
              id={titleId}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={onOpen}
              onAuxClick={onOpen}
            >
              {item.title}
            </a>
          ) : (
            <span id={titleId}>{item.title}</span>
          )}
        </h3>
        <div className="news-byline">
          {[
            authorLine(item.authors),
            item.venue,
            item.publishedAt &&
              new Date(item.publishedAt).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              }),
            item.arxivId && `arXiv:${item.arxivId}`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
        {item.triage && (
          <p className="news-why">
            <b>WHY THIS MATTERS</b>
            {item.triage.why}
          </p>
        )}
        {!!projectNames.length && (
          <div className="news-chips">
            {projectNames.map((project) => (
              <button
                key={project.id}
                className="news-chip-project"
                onClick={() => onOpenProject(project.id)}
                title={`Open project ${project.name}`}
              >
                <FolderClosed size={12} /> {project.name}
              </button>
            ))}
          </div>
        )}
        <button
          className="news-expand"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={onToggleExpanded}
        >
          <ChevronDown size={13} className={expanded ? 'news-rotated' : ''} />
          {expanded ? 'Hide details' : 'Abstract and why you’re seeing this'}
        </button>
        {expanded && (
          <div className="news-details" id={detailsId}>
            <p className="news-abstract">{item.abstract || 'No abstract available.'}</p>
            <div className="news-prov">
              <div className="news-prov-head">WHY YOU’RE SEEING THIS</div>
              <div>
                <strong>Found by</strong>{' '}
                {item.sources.map((source) => source.label).join(', ') || 'a removed source'}
                {item.firstSeenAt && ` · first seen ${age(item.firstSeenAt)}`}
              </div>
              {!!features.length && (
                <ul>
                  {features.map(([key, value]) => (
                    <li key={key}>
                      {featureLabels[key] ?? key}: {Math.round(value * 100)}%
                    </li>
                  ))}
                </ul>
              )}
              {item.triage && (
                <div className="news-prov-triage">
                  Rated {item.triage.score}/5 by {item.triage.agent.name || 'your assistant'}
                  {item.triage.agent.model ? ` · ${item.triage.agent.model}` : ''} ·{' '}
                  {timeLabel(item.triage.createdAt)}
                  {!!item.triage.citations.length && (
                    <ul>
                      {item.triage.citations.map((citation) => (
                        <li key={citation.chunkId}>
                          <strong>{citation.title}</strong>
                          {citation.quote && <> — “{citation.quote}”</>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="news-actions">
          {isPaper && !inLibrary && item.state !== 'dismissed' && (
            <button
              className={`news-btn primary${busy === 'zotero' ? ' busy' : ''}`}
              aria-haspopup="dialog"
              data-popover-trigger
              aria-expanded={popover === 'zotero'}
              disabled={!!busy}
              onClick={() => onPopover(popover === 'zotero' ? null : 'zotero')}
            >
              {busy === 'zotero' ? <LoaderCircle size={13} className="spin" /> : <Plus size={13} />}
              {busy === 'zotero' ? 'Adding…' : 'Add to Zotero'}
              <kbd>z</kbd>
            </button>
          )}
          {inLibrary && (
            <>
              <button className="news-btn primary" onClick={() => onOpenPaper(item.paperId!)}>
                <FileText size={13} /> Open in library
              </button>
              <button
                className="news-btn"
                aria-haspopup="dialog"
                data-popover-trigger
                aria-expanded={popover === 'project'}
                disabled={!!busy || !projects.length}
                onClick={() => onPopover(popover === 'project' ? null : 'project')}
              >
                {busy === 'project' ? (
                  <LoaderCircle size={13} className="spin" />
                ) : (
                  <Link2 size={13} />
                )}
                Link to project
              </button>
            </>
          )}
          {item.state !== 'added' && item.state !== 'dismissed' && (
            <button
              className={`news-btn${!isPaper && !inLibrary ? ' primary' : ''}`}
              aria-pressed={saved}
              disabled={!!busy}
              onClick={onSave}
            >
              {saved ? <BookmarkCheck size={13} /> : <Bookmark size={13} />}
              {saved ? 'Saved' : 'Save'}
              <kbd>s</kbd>
            </button>
          )}
          {url && !isPaper && (
            <a
              className="news-btn"
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={onOpen}
            >
              <ExternalLink size={13} /> Open
            </a>
          )}
          <span className="news-spacer" />
          <span className="news-feedback" role="group" aria-label="Feedback">
            <button
              className="news-btn icon"
              aria-pressed={item.feedback === 'more'}
              aria-label="More like this"
              title="More like this"
              disabled={!!busy}
              onClick={() => onFeedback('more')}
            >
              <ThumbsUp size={13} />
            </button>
            <button
              className="news-btn icon"
              aria-pressed={item.feedback === 'less'}
              aria-label="Less like this"
              title="Less like this"
              disabled={!!busy}
              onClick={() => onFeedback('less')}
            >
              <ThumbsDown size={13} />
            </button>
          </span>
          {item.state === 'dismissed' ? (
            <button className="news-btn" disabled={!!busy} onClick={onRestore}>
              <RotateCcw size={13} /> Restore<kbd>d</kbd>
            </button>
          ) : (
            item.state !== 'added' && (
              <button className="news-btn" disabled={!!busy} onClick={onDismiss}>
                <X size={13} /> Dismiss<kbd>d</kbd>
              </button>
            )
          )}
          {popover === 'zotero' && (
            <ZoteroPopover
              item={item}
              collections={collections}
              projects={projects}
              onCancel={() => onPopover(null)}
              onSubmit={onAddToZotero}
            />
          )}
          {popover === 'project' && (
            <ProjectPopover
              item={item}
              projects={projects}
              onCancel={() => onPopover(null)}
              onSubmit={onLinkProject}
            />
          )}
        </div>
        {item.state === 'dismissed' && item.dismissReason && (
          <p className="news-note">
            Dismissed: {dismissReasons.find((reason) => reason.id === item.dismissReason)?.label}
          </p>
        )}
        {note && (
          <p className="news-note news-note-ok" role="status">
            <Check size={13} /> {note.text}
          </p>
        )}
        {note?.warn && (
          <p className="news-note news-note-warn">
            <AlertCircle size={13} /> {note.warn}
          </p>
        )}
        {problem && (
          <div className="assistant-inline-error news-inline-error" role="alert">
            <AlertCircle size={15} />
            <span>{problem.message}</span>
            {problem.authorize && (
              <button className="news-btn" onClick={onAuthorize}>
                <Check size={13} /> Enable Zotero writes
              </button>
            )}
            {problem.retry && (
              <button className="news-btn" onClick={problem.retry}>
                <RotateCcw size={13} /> Retry
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

function usePopoverDismiss(onCancel: () => void) {
  const ref = useRef<HTMLFormElement>(null);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest?.('[data-popover-trigger]')) return; // The trigger toggles itself.
      if (ref.current && !ref.current.contains(target as Node)) cancel.current();
    };
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  return ref;
}

function collectionTree(collections: Collection[]) {
  const children = new Map<string | null, Collection[]>();
  const ids = new Set(collections.map((collection) => collection.id));
  for (const collection of collections) {
    const parent = collection.parentId && ids.has(collection.parentId) ? collection.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), collection]);
  }
  const rows: { collection: Collection; depth: number; path: string }[] = [];
  const walk = (parent: string | null, depth: number, prefix: string) => {
    const list = [...(children.get(parent) ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    for (const collection of list) {
      const path = prefix ? `${prefix} / ${collection.name}` : collection.name;
      rows.push({ collection, depth, path });
      walk(collection.id, depth + 1, path);
    }
  };
  walk(null, 0, '');
  return rows;
}

function ZoteroPopover({
  item,
  collections,
  projects,
  onCancel,
  onSubmit,
}: {
  item: NewsItem;
  collections: Collection[];
  projects: Project[];
  onCancel: () => void;
  onSubmit: (input: NewsAddToZoteroInput) => void;
}) {
  const ref = usePopoverDismiss(onCancel);
  const rows = useMemo(() => collectionTree(collections), [collections]);
  const remembered = readStorage(LAST_COLLECTION_KEY);
  const [search, setSearch] = useState('');
  const [collectionId, setCollectionId] = useState<string>(
    remembered && rows.some((row) => row.collection.id === remembered) ? remembered : '',
  );
  const suggestedProject = item.triage?.projectIds.find((id) =>
    projects.some((project) => project.id === id),
  );
  const [attachPdf, setAttachPdf] = useState(!!item.arxivId);
  const [linkProject, setLinkProject] = useState(!!suggestedProject);
  const [projectId, setProjectId] = useState(suggestedProject ?? projects[0]?.id ?? '');
  const term = search.trim().toLocaleLowerCase();
  const shown = term ? rows.filter((row) => row.path.toLocaleLowerCase().includes(term)) : rows;
  const zotero = useZoteroWriteAccess();
  const canAdd = !!zotero.status?.reachable && zotero.status.authorized;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canAdd) return;
    writeStorage(LAST_COLLECTION_KEY, collectionId);
    onSubmit({
      collectionId: collectionId || null,
      projectId: linkProject && projectId ? projectId : null,
      attachPdf: attachPdf && !!item.arxivId,
    });
  };

  return (
    <form
      ref={ref}
      className="news-popover"
      role="dialog"
      aria-label="Add to Zotero"
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="news-pop-title">
        <span>ADD TO ZOTERO</span>
        <span>
          <kbd>↵</kbd> add · <kbd>esc</kbd>
        </span>
      </div>
      <input
        className="news-pop-search"
        placeholder="Find collection…"
        aria-label="Find collection"
        value={search}
        autoFocus
        onChange={(event) => setSearch(event.target.value)}
      />
      <div className="news-coll" role="radiogroup" aria-label="Collection">
        {!term && (
          <label>
            <input
              type="radio"
              name={`coll-${item.id}`}
              checked={collectionId === ''}
              onChange={() => setCollectionId('')}
            />
            My Library (no collection)
          </label>
        )}
        {shown.map((row) => (
          <label
            key={row.collection.id}
            style={term ? undefined : { paddingLeft: 7 + row.depth * 15 }}
          >
            <input
              type="radio"
              name={`coll-${item.id}`}
              checked={collectionId === row.collection.id}
              onChange={() => setCollectionId(row.collection.id)}
            />
            <span className="truncate">{term ? row.path : row.collection.name}</span>
            {row.collection.id === remembered && <small>last used</small>}
          </label>
        ))}
        {term && !shown.length && <p className="news-pop-empty">No matching collection.</p>}
      </div>
      <div className="news-opts">
        {item.arxivId && (
          <label>
            <input
              type="checkbox"
              checked={attachPdf}
              onChange={(event) => setAttachPdf(event.target.checked)}
            />
            Attach arXiv PDF
          </label>
        )}
        <label>
          <input
            type="checkbox"
            checked={linkProject}
            disabled={!projects.length}
            onChange={(event) => setLinkProject(event.target.checked)}
          />
          Link to project
        </label>
        {linkProject && (
          <select
            aria-label="Project"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <ZoteroAccess access={zotero} wantsPdf={attachPdf && !!item.arxivId} />
      <div className="news-pop-actions">
        <button type="button" className="news-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="news-btn primary" disabled={!canAdd}>
          <Plus size={13} /> Add
        </button>
      </div>
    </form>
  );
}

/** Zotero local-write permission, checked when the Add popover opens. */
function useZoteroWriteAccess() {
  const [status, setStatus] = useState<ZoteroStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [authorizing, setAuthorizing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = useCallback(async () => {
    setChecking(true);
    try {
      setStatus(await request<ZoteroStatus>('/api/zotero/status'));
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught, 'Could not check Zotero.'));
    } finally {
      setChecking(false);
    }
  }, []);
  useEffect(() => {
    void check();
  }, [check]);
  const authorize = async () => {
    setAuthorizing(true);
    setError(null);
    try {
      await send<unknown>('/api/zotero/authorize', 'POST');
    } catch (caught) {
      setError(errorMessage(caught, 'Zotero did not grant write access.'));
    } finally {
      setAuthorizing(false);
    }
    await check();
  };
  return { status, checking, authorizing, error, check, authorize };
}

function ZoteroAccess({
  access,
  wantsPdf,
}: {
  access: ReturnType<typeof useZoteroWriteAccess>;
  wantsPdf: boolean;
}) {
  const { status, checking, authorizing, error } = access;
  if (checking && !status)
    return (
      <p className="news-pop-status" role="status">
        <LoaderCircle size={13} className="spin" /> Checking Zotero…
      </p>
    );
  const alwaysAllow = 'Choose “Always Allow” in Zotero so the PDF can be attached too.';
  return (
    <div className="news-pop-status" role="status" aria-live="polite">
      {error && (
        <p className="news-pop-error">
          <AlertCircle size={13} /> {error}
        </p>
      )}
      {status && !status.reachable ? (
        <>
          <p className="news-pop-error">
            <AlertCircle size={13} /> Zotero isn’t reachable. Open Zotero desktop (version 10 or
            newer), then check again.
          </p>
          <button
            type="button"
            className="news-btn"
            disabled={checking}
            onClick={() => void access.check()}
          >
            <RotateCcw size={13} className={checking ? 'spin' : ''} /> Check again
          </button>
        </>
      ) : status && !status.authorized ? (
        <>
          <p>Atlas needs permission to write to Zotero. {alwaysAllow}</p>
          <button
            type="button"
            className="news-btn primary"
            disabled={authorizing}
            onClick={() => void access.authorize()}
          >
            {authorizing ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}
            {authorizing ? 'Waiting for Zotero…' : 'Enable Zotero writes'}
          </button>
        </>
      ) : status && wantsPdf && !status.automaticPdfWrites ? (
        <>
          <p>Writes are allowed once. {alwaysAllow}</p>
          <button
            type="button"
            className="news-btn"
            disabled={authorizing}
            onClick={() => void access.authorize()}
          >
            {authorizing ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}
            {authorizing ? 'Waiting for Zotero…' : 'Update permission'}
          </button>
        </>
      ) : null}
    </div>
  );
}

function ProjectPopover({
  item,
  projects,
  onCancel,
  onSubmit,
}: {
  item: NewsItem;
  projects: Project[];
  onCancel: () => void;
  onSubmit: (projectId: string) => void;
}) {
  const ref = usePopoverDismiss(onCancel);
  const suggested = item.triage?.projectIds.find((id) =>
    projects.some((project) => project.id === id),
  );
  const [projectId, setProjectId] = useState(suggested ?? projects[0]?.id ?? '');
  return (
    <form
      ref={ref}
      className="news-popover"
      role="dialog"
      aria-label="Link to project"
      onSubmit={(event) => {
        event.preventDefault();
        if (projectId) onSubmit(projectId);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="news-pop-title">
        <span>LINK TO PROJECT</span>
      </div>
      <select
        className="news-pop-select"
        aria-label="Project"
        value={projectId}
        autoFocus
        onChange={(event) => setProjectId(event.target.value)}
      >
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
      <div className="news-pop-actions">
        <button type="button" className="news-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="news-btn primary" disabled={!projectId}>
          <Link2 size={13} /> Link
        </button>
      </div>
    </form>
  );
}
