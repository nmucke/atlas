import { FormEvent, useState } from 'react';
import { ArrowRight, Check, LoaderCircle, Plus, Tags } from 'lucide-react';
import type { Tag, TagCategory } from '../shared/types';

export type TagSection = TagCategory | 'all' | 'zotero';
const categories: TagCategory[] = ['method', 'data', 'domain', 'model', 'task'];

async function tagRequest(path: string, init: RequestInit): Promise<Tag> {
  const response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json' } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body as Tag;
}

function TagRow({
  tag,
  onOpen,
  onChanged,
}: {
  tag: Tag;
  onOpen: (tag: Tag) => void;
  onChanged: () => Promise<void> | void;
}) {
  const [description, setDescription] = useState(tag.description);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = description !== tag.description;
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = await tagRequest(`/api/tags/${encodeURIComponent(tag.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ description: description.trim() }),
      });
      setDescription(saved.description);
      await onChanged();
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'Could not save this explanation.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <article className="tag-card" title={description || 'No explanation yet'}>
      <div className="tag-card-top">
        <button
          className="tag-card-name"
          onClick={() => onOpen(tag)}
          title={description || 'Open tagged papers'}
        >
          <span className="tag-dot" />
          <strong>{tag.name}</strong>
          <ArrowRight size={15} />
        </button>
        <span className="tag-paper-count">
          {tag.paperCount} {tag.paperCount === 1 ? 'paper' : 'papers'}
        </span>
      </div>
      <label className="tag-description-label" htmlFor={`tag-description-${tag.id}`}>
        Short explanation
      </label>
      <div className="tag-description-edit">
        <input
          id={`tag-description-${tag.id}`}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={280}
          placeholder="What does this tag mean?"
          disabled={saving}
        />
        <button
          onClick={() => void save()}
          disabled={!dirty || saving}
          aria-label={`Save explanation for ${tag.name}`}
        >
          {saving ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}
          Save
        </button>
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}

interface Props {
  section: TagSection;
  tags: Tag[];
  loading: boolean;
  onOpen: (tag: Tag) => void;
  onChanged: () => Promise<void> | void;
}

export function TagManager({ section, tags, loading, onOpen, onChanged }: Props) {
  const [category, setCategory] = useState<TagCategory | 'none'>('method');
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const visible = tags
    .filter((tag) =>
      section === 'zotero'
        ? tag.origin === 'zotero'
        : tag.origin === 'atlas' && (section === 'all' || tag.category === section),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  const currentCategory = section === 'all' || section === 'zotero' ? category : section;
  const title = section === 'all' ? 'All tags' : section === 'zotero' ? 'Zotero tags' : section;

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    const fullName =
      trimmed.includes('/') || currentCategory === 'none'
        ? trimmed
        : `${currentCategory}/${trimmed}`;
    if (!trimmed || fullName.length > 120) {
      setError('Enter a tag name of at most 120 characters.');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      await tagRequest('/api/tags', { method: 'POST', body: JSON.stringify({ name: fullName }) });
      setName('');
      await onChanged();
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'Could not create this tag.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            {section === 'zotero' ? 'SOURCE METADATA' : 'YOUR ATLAS VOCABULARY'}
          </div>
          <h1>{title}</h1>
          <p>
            {loading
              ? 'Loading tags…'
              : `${visible.length} ${visible.length === 1 ? 'tag' : 'tags'}${section === 'zotero' ? ' imported from Zotero' : ''}`}
          </p>
        </div>
      </div>
      {section !== 'zotero' && (
        <form className="tag-create" onSubmit={(event) => void create(event)}>
          <div className="tag-create-heading">
            <Plus size={16} /> Create Atlas tag
          </div>
          <div className="tag-create-fields">
            {section === 'all' && (
              <select
                value={category}
                onChange={(event) => setCategory(event.target.value as TagCategory | 'none')}
                aria-label="Tag category"
              >
                <option value="none">No category</option>
                {categories.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            )}
            {currentCategory !== 'none' && (
              <span className="tag-create-prefix">{currentCategory}/</span>
            )}
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Tag name"
              aria-label="New Atlas tag name"
              maxLength={120}
            />
            <button type="submit" disabled={creating || !name.trim()}>
              {creating ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />} Add tag
            </button>
          </div>
          <p>
            Choose a category or enter a full name such as method/flow. Atlas tags remain separate
            from Zotero tags.
          </p>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
      {loading ? (
        <div className="loading-view">
          <LoaderCircle className="spin" size={26} /> Loading tags…
        </div>
      ) : visible.length ? (
        <div className="tag-list">
          {visible.map((tag) => (
            <TagRow key={tag.id} tag={tag} onOpen={onOpen} onChanged={onChanged} />
          ))}
        </div>
      ) : (
        <div className="empty-state filtered-empty">
          <div className="empty-icon">
            <Tags size={23} />
          </div>
          <h2>No tags here yet</h2>
          <p>
            {section === 'zotero'
              ? 'Tags from Zotero will appear after your library syncs.'
              : 'Create an Atlas tag above to start organizing your papers.'}
          </p>
        </div>
      )}
    </>
  );
}
