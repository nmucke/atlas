import { FormEvent, useState } from 'react';
import { LoaderCircle, Plus, X } from 'lucide-react';
import type { Paper, Tag, TagCategory } from '../shared/types';

const categories: TagCategory[] = ['method', 'data', 'domain', 'model', 'task'];

interface Props {
  paper: Paper;
  tags: Tag[];
  onChange: (tags: string[]) => Promise<void>;
  onOpen: (tag: Tag) => void;
}

export function PaperTags({ paper, tags, onChange, onOpen }: Props) {
  const [category, setCategory] = useState<TagCategory | 'none'>('method');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const atlasTags = tags.filter((tag) => tag.origin === 'atlas');

  const change = async (next: string[]) => {
    setBusy(true);
    setError(null);
    try {
      await onChange(next);
      setName('');
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'Could not update paper tags.');
    } finally {
      setBusy(false);
    }
  };

  const add = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    const existing = atlasTags.find((tag) => tag.name === trimmed);
    const fullName = existing
      ? existing.name
      : trimmed.includes('/') || category === 'none'
        ? trimmed
        : `${category}/${trimmed}`;
    if (!trimmed || fullName.length > 120) {
      setError('Enter a tag name of at most 120 characters.');
      return;
    }
    if (paper.tags.includes(fullName)) {
      setError('This paper already has that tag.');
      return;
    }
    void change([...paper.tags, fullName]);
  };

  return (
    <>
      <div className="inspector-section">
        <div className="section-label">
          TAGS <span className="private-label">ATLAS · EDITABLE</span>
        </div>
        <div className="paper-tag-list">
          {paper.tags.length ? (
            paper.tags.map((item) => {
              const registered = atlasTags.find((tag) => tag.name === item);
              return (
                <span
                  className="paper-tag"
                  key={item}
                  title={registered?.description || 'No explanation yet'}
                >
                  <button
                    className="paper-tag-open"
                    onClick={() => registered && onOpen(registered)}
                    disabled={!registered}
                    title={registered?.description || item}
                  >
                    {item}
                  </button>
                  <button
                    className="paper-tag-remove"
                    onClick={() => void change(paper.tags.filter((name) => name !== item))}
                    disabled={busy}
                    aria-label={`Remove Atlas tag ${item}`}
                    title={`Remove ${item}`}
                  >
                    <X size={13} />
                  </button>
                </span>
              );
            })
          ) : (
            <p className="tag-empty-note">No Atlas tags assigned yet.</p>
          )}
        </div>
        <form className="paper-tag-form" onSubmit={add}>
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value as TagCategory | 'none')}
            aria-label="Atlas tag category"
            disabled={busy}
          >
            <option value="none">No category</option>
            {categories.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            list={`atlas-tag-options-${paper.id}`}
            placeholder="Add or create tag"
            aria-label="Add Atlas tag"
            disabled={busy}
            maxLength={120}
          />
          <datalist id={`atlas-tag-options-${paper.id}`}>
            {atlasTags
              .filter((tag) => !paper.tags.includes(tag.name))
              .map((tag) => (
                <option key={tag.id} value={tag.name}>
                  {tag.description}
                </option>
              ))}
          </datalist>
          <button type="submit" disabled={busy || !name.trim()} aria-label="Add Atlas tag">
            {busy ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}
          </button>
        </form>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="inspector-section">
        <div className="section-label">
          ZOTERO TAGS <span className="private-label">SOURCE · READ ONLY</span>
        </div>
        {paper.zoteroTags.length ? (
          <div className="inspector-tags">
            {paper.zoteroTags.map((item) => {
              const registered = tags.find((tag) => tag.origin === 'zotero' && tag.name === item);
              return (
                <button
                  key={item}
                  onClick={() => registered && onOpen(registered)}
                  disabled={!registered}
                  title={registered?.description || 'No explanation yet'}
                >
                  {item}
                </button>
              );
            })}
          </div>
        ) : (
          <p className="tag-empty-note">No Zotero tags on this paper.</p>
        )}
      </div>
    </>
  );
}
