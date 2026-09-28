import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import {
  Archive,
  Check,
  FileText,
  ImagePlus,
  LoaderCircle,
  Pin,
  Plus,
  Search,
  Undo2,
} from 'lucide-react';
import type { ProjectAsset, ProjectNote } from '../shared/types';
import { noteUrl } from './note-content';
import 'katex/dist/katex.min.css';
import './project-notes.css';

type Draft = Pick<ProjectNote, 'title' | 'body' | 'folder' | 'pinned'>;
interface Props {
  projectId: string;
  notes: ProjectNote[];
  onChanged: () => Promise<void> | void;
}
const toDraft = (note: ProjectNote): Draft => ({
  title: note.title,
  body: note.body,
  folder: note.folder,
  pinned: note.pinned,
});
const isAINote = (note: ProjectNote) => 'authorType' in note && note.authorType === 'ai';
const sameDraft = (left: Draft | undefined, right: Draft) =>
  !!left && JSON.stringify(left) === JSON.stringify(right);
const volatileDrafts = new Map<string, Record<string, Draft>>();
function guardVolatileDrafts(event: BeforeUnloadEvent) {
  if (![...volatileDrafts.values()].some((drafts) => Object.keys(drafts).length)) return;
  event.preventDefault();
  event.returnValue = '';
}
function storedDrafts(key: string): Record<string, Draft> {
  const volatile = volatileDrafts.get(key);
  if (volatile) return volatile;
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, Draft>)
      : {};
  } catch {
    return {};
  }
}
function writeDrafts(key: string, drafts: Record<string, Draft>): boolean {
  try {
    if (Object.keys(drafts).length) localStorage.setItem(key, JSON.stringify(drafts));
    else localStorage.removeItem(key);
    volatileDrafts.delete(key);
    if (!volatileDrafts.size) window.removeEventListener('beforeunload', guardVolatileDrafts);
    return true;
  } catch {
    volatileDrafts.set(key, drafts);
    window.addEventListener('beforeunload', guardVolatileDrafts);
    return false;
  }
}
async function request<T>(path: string, method: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Unable to save the note.');
  return result;
}

export function ProjectNotes({ projectId, notes, onChanged }: Props) {
  const storageKey = `atlas:project-note-drafts:${projectId}`;
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => storedDrafts(storageKey));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [folder, setFolder] = useState('');
  const [archived, setArchived] = useState(false);
  const [mode, setMode] = useState<'edit' | 'split' | 'preview'>('split');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const upload = useRef<HTMLInputElement>(null);
  const current = notes.find((n) => n.id === selectedId) ?? null;
  const draft = current ? (drafts[current.id] ?? toDraft(current)) : null;
  const dirty = !!current && !!draft && JSON.stringify(draft) !== JSON.stringify(toDraft(current));
  const hasDrafts = notes.some(
    (note) => drafts[note.id] && JSON.stringify(drafts[note.id]) !== JSON.stringify(toDraft(note)),
  );
  const visible = notes
    .filter(
      (note) =>
        note.archived === archived &&
        (!folder || note.folder === folder) &&
        `${drafts[note.id]?.title ?? note.title} ${drafts[note.id]?.body ?? note.body}`
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase()),
    )
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  const folders = [
    ...new Set(notes.filter((n) => n.archived === archived).map((n) => n.folder)),
  ].sort();
  useEffect(() => {
    if (!visible.some((note) => note.id === selectedId)) setSelectedId(visible[0]?.id ?? null);
  }, [selectedId, visible]);
  useEffect(() => {
    if (!hasDrafts) return;
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [hasDrafts]);
  const persist = (next: Record<string, Draft>) => {
    setDrafts(next);
    if (!writeDrafts(storageKey, next)) {
      setError('Browser draft storage is full. Save this note before leaving the page.');
    }
  };
  const edit = (patch: Partial<Draft>) => {
    if (current && draft) {
      persist({ ...drafts, [current.id]: { ...draft, ...patch } });
      setSaved(false);
    }
  };
  const save = async () => {
    if (!current || !draft || saving || !dirty) return;
    if (!draft.title.trim() || !draft.folder.trim()) {
      setError('Give this note a title and folder before saving.');
      return;
    }
    setSaving(true);
    setError(null);
    const id = current.id;
    const captured = { ...draft };
    try {
      await request<ProjectNote>(
        `/api/projects/${encodeURIComponent(projectId)}/notes/${encodeURIComponent(id)}`,
        'PATCH',
        captured,
      );
      try {
        await onChanged();
      } catch {
        setError('Note saved, but the project view could not refresh. Reopen Notes to reload it.');
        return;
      }
      setDrafts((previous) => {
        if (!sameDraft(previous[id], captured)) return previous;
        const next = { ...previous };
        delete next[id];
        return next;
      });
      // A save may finish after this editor unmounts. Read storage again so a newer
      // draft written by the next editor instance is never erased by this response.
      const latest = storedDrafts(storageKey);
      if (sameDraft(latest[id], captured)) {
        delete latest[id];
        if (!writeDrafts(storageKey, latest)) {
          setError('The note was saved, but browser draft storage could not be updated.');
        }
      }
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save note.');
    } finally {
      setSaving(false);
    }
  };
  useEffect(() => {
    const shortcut = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  });
  const create = async () => {
    setSaving(true);
    setError(null);
    try {
      const note = await request<ProjectNote>(
        `/api/projects/${encodeURIComponent(projectId)}/notes`,
        'POST',
        { title: 'Untitled note', folder: folder || 'General', body: '' },
      );
      try {
        await onChanged();
      } catch {
        setError(
          'Note created, but the project view could not refresh. Reopen Notes to reload it.',
        );
        return;
      }
      setSelectedId(note.id);
      setArchived(false);
      setQuery('');
      setSaved(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create note.');
    } finally {
      setSaving(false);
    }
  };
  const archive = async () => {
    if (!current || saving) return;
    if (dirty) {
      setError('Save your changes before archiving or restoring this note.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await request(
        `/api/projects/${encodeURIComponent(projectId)}/notes/${encodeURIComponent(current.id)}`,
        'PATCH',
        { archived: !current.archived },
      );
      try {
        await onChanged();
      } catch {
        setError(
          'Note updated, but the project view could not refresh. Reopen Notes to reload it.',
        );
        return;
      }
      setSelectedId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update note.');
    } finally {
      setSaving(false);
    }
  };
  const addFigure = async (file: File) => {
    if (!current || !draft || uploading) return;
    if (
      file.size > 8 * 1024 * 1024 ||
      !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)
    ) {
      setError('Choose a PNG, JPEG, GIF, or WebP image of at most 8 MB.');
      return;
    }
    const selection = editor.current?.selectionStart ?? draft.body.length;
    const end = editor.current?.selectionEnd ?? selection;
    setUploading(true);
    setError(null);
    try {
      const encoded = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error('Could not read image.'));
        reader.readAsDataURL(file);
      });
      const asset = await request<ProjectAsset>(
        `/api/projects/${encodeURIComponent(projectId)}/assets`,
        'POST',
        { filename: file.name, contentType: file.type, data: encoded },
      );
      const alt = file.name.replace(/[\[\]\\\r\n]/g, ' ');
      const markdown = `\n\n![${alt}](/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(asset.id)})\n\n*Figure: add your caption here.*\n\n`;
      edit({ body: draft.body.slice(0, selection) + markdown + draft.body.slice(end) });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not upload figure.');
    } finally {
      setUploading(false);
      if (upload.current) upload.current.value = '';
    }
  };
  return (
    <section className="project-notebook" aria-label="Project notebook">
      <div className="notebook-heading">
        <div>
          <h2>Research notebook</h2>
          <p>Ideas, derivations, experiments, and decisions. Markdown with LaTeX mathematics.</p>
        </div>
        <button
          className="notebook-primary"
          onClick={() => void create()}
          disabled={saving || uploading}
        >
          <Plus size={15} />
          New note
        </button>
      </div>
      {error && (
        <div className="notebook-error" role="alert">
          {error}
        </div>
      )}
      <div className="notebook-workspace">
        <aside className="notebook-index">
          <label className="notebook-search">
            <Search size={15} />
            <input
              aria-label="Search project notes"
              placeholder="Search notes…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="notebook-filters">
            <select
              aria-label="Filter note folder"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
            >
              <option value="">All folders</option>
              {folders.map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
            <button
              onClick={() => {
                setArchived((v) => !v);
                setSelectedId(null);
                setFolder('');
              }}
              aria-pressed={archived}
              title={archived ? 'Show active notes' : 'Show archived notes'}
            >
              <Archive size={15} />
            </button>
          </div>
          {archived && <div className="notebook-archive-label">ARCHIVED NOTES</div>}
          <div className="notebook-note-list">
            {visible.map((note) => (
              <button
                key={note.id}
                className={selectedId === note.id ? 'selected' : ''}
                disabled={saving || uploading}
                onClick={() => {
                  setSelectedId(note.id);
                  setError(null);
                  setSaved(false);
                }}
              >
                <span className="notebook-note-title">
                  {note.pinned ? <Pin size={13} /> : <FileText size={13} />}
                  <strong>{drafts[note.id]?.title || note.title}</strong>
                  {isAINote(note) && <span className="notebook-ai-origin">AI</span>}
                  {drafts[note.id] &&
                    JSON.stringify(drafts[note.id]) !== JSON.stringify(toDraft(note)) && (
                      <span title="Unsaved draft">•</span>
                    )}
                </span>
                <small>
                  {note.folder} · {new Date(note.updatedAt).toLocaleDateString()}
                </small>
              </button>
            ))}
            {!visible.length && (
              <p className="notebook-empty-list">
                {query
                  ? 'No matching notes.'
                  : archived
                    ? 'No archived notes.'
                    : 'No notes in this folder yet.'}
              </p>
            )}
          </div>
        </aside>
        <div className="notebook-main">
          {current && draft ? (
            <>
              <div className="notebook-note-heading">
                <input
                  className="notebook-title"
                  aria-label="Note title"
                  value={draft.title}
                  maxLength={200}
                  onChange={(e) => edit({ title: e.target.value })}
                  disabled={saving || uploading}
                />
                <div className="notebook-note-actions">
                  <button
                    title={draft.pinned ? 'Unpin note' : 'Pin note'}
                    aria-label={draft.pinned ? 'Unpin note' : 'Pin note'}
                    aria-pressed={draft.pinned}
                    onClick={() => edit({ pinned: !draft.pinned })}
                    disabled={saving || uploading}
                  >
                    <Pin size={16} />
                  </button>
                  <button
                    onClick={() => void archive()}
                    disabled={saving || uploading}
                    title={current.archived ? 'Restore note' : 'Archive note'}
                    aria-label={current.archived ? 'Restore note' : 'Archive note'}
                  >
                    {current.archived ? <Undo2 size={16} /> : <Archive size={16} />}
                  </button>
                  <button
                    className="notebook-primary"
                    onClick={() => void save()}
                    disabled={saving || uploading || !dirty || !draft.title.trim()}
                  >
                    {saving ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}Save
                  </button>
                </div>
              </div>
              <div className="notebook-meta">
                {isAINote(current) && <span className="notebook-ai-origin">Approved AI draft</span>}
                <label>
                  Folder
                  <input
                    value={draft.folder}
                    list="project-note-folders"
                    aria-label="Note folder"
                    maxLength={80}
                    onChange={(e) => edit({ folder: e.target.value })}
                    disabled={saving || uploading}
                  />
                  <datalist id="project-note-folders">
                    {folders.map((f) => (
                      <option key={f}>{f}</option>
                    ))}
                  </datalist>
                </label>
                <span role="status">
                  {dirty
                    ? 'Unsaved draft · kept in this browser'
                    : saved
                      ? 'Saved locally'
                      : current.archived
                        ? 'Archived note'
                        : 'Saved locally'}
                </span>
              </div>
              <div className="notebook-toolbar">
                <div className="notebook-modes">
                  {(['edit', 'split', 'preview'] as const).map((value) => (
                    <button
                      key={value}
                      aria-pressed={mode === value}
                      className={mode === value ? 'active' : ''}
                      onClick={() => setMode(value)}
                    >
                      {value[0].toUpperCase() + value.slice(1)}
                    </button>
                  ))}
                </div>
                <button onClick={() => upload.current?.click()} disabled={saving || uploading}>
                  <ImagePlus size={15} />
                  {uploading ? 'Adding…' : 'Add figure'}
                </button>
                <input
                  ref={upload}
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  hidden
                  onChange={(e) => {
                    if (e.target.files?.[0]) void addFigure(e.target.files[0]);
                  }}
                />
              </div>
              <div className={`notebook-content mode-${mode}`}>
                {mode !== 'preview' && (
                  <textarea
                    ref={editor}
                    className="notebook-editor"
                    aria-label="Note Markdown"
                    spellCheck={false}
                    value={draft.body}
                    maxLength={1000000}
                    onChange={(e) => edit({ body: e.target.value })}
                    disabled={saving || uploading}
                    placeholder={
                      '# An idea worth keeping\n\nInline math: $p(x \\mid y)$\n\n$$\n\\nabla \\cdot u = 0\n$$'
                    }
                  />
                )}
                {mode !== 'edit' && (
                  <div className="notebook-preview" aria-label="Rendered note">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm, remarkMath]}
                      rehypePlugins={[[rehypeKatex, { trust: false, throwOnError: false }]]}
                      skipHtml
                      urlTransform={(url, key) => noteUrl(url, projectId, key === 'src')}
                      components={{
                        img: ({ src, alt }) =>
                          src ? (
                            <figure>
                              <img src={src} alt={alt || 'Project figure'} loading="lazy" />
                            </figure>
                          ) : (
                            <span className="notebook-blocked-image">
                              External image omitted. Use Add figure to store it locally.
                            </span>
                          ),
                        a: ({ href, children }) =>
                          href ? (
                            <a href={href} target="_blank" rel="noreferrer">
                              {children}
                            </a>
                          ) : (
                            <span>{children}</span>
                          ),
                      }}
                    >
                      {draft.body || '*Your rendered note will appear here.*'}
                    </ReactMarkdown>
                  </div>
                )}
              </div>
              <details className="notebook-help">
                <summary>Writing mathematics and adding figures</summary>
                <p>
                  Use <code>$x^2$</code> for inline mathematics and <code>$$…$$</code> for display
                  equations. Multiline derivations support{' '}
                  <code>{'\\begin{aligned}…\\end{aligned}'}</code>. Use headings to structure long
                  notes, and folders to organize experiments or topics. Pin key notes for quick
                  access.
                </p>
                <pre>
                  {
                    '$$\n\\begin{aligned}\np(x \\mid y) &\\propto p(y \\mid x)p(x) \\\\\n\\mathcal{L} &= \\sum_{i=1}^{n} (y_i - f(x_i))^2\n\\end{aligned}\n$$'
                  }
                </pre>
                <p>
                  Add figure uploads a local image and inserts it at the cursor. Write captions
                  below it. Equations render with KaTeX (a subset of LaTeX); compile complete
                  manuscripts in Overleaf. Save notes to include them in database backups. Unsaved
                  drafts are retained in this browser.
                </p>
              </details>
            </>
          ) : (
            <div className="notebook-welcome">
              <FileText size={32} />
              <h3>A place for your working ideas</h3>
              <p>
                Create a note for a derivation, experiment, or question. Keep related notes together
                with folders.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
