import { ArrowRight, FolderClosed, LoaderCircle } from 'lucide-react';
import type { Collection, Paper } from '../shared/types';

interface Props {
  collections: Collection[];
  papers: Paper[];
  loading: boolean;
  onOpen: (id: string) => void;
}

export function CollectionsPage({ collections, papers, loading, onOpen }: Props) {
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">ORGANIZE YOUR LIBRARY</div>
          <h1>Collections</h1>
          <p>
            {loading
              ? 'Loading collections…'
              : `${collections.length} ${collections.length === 1 ? 'collection' : 'collections'} from Zotero`}
          </p>
        </div>
      </div>
      {loading ? (
        <div className="loading-view">
          <LoaderCircle className="spin" size={26} /> Loading collections…
        </div>
      ) : collections.length ? (
        <div className="collection-grid">
          {collections.map((collection) => {
            const count = papers.filter(
              (paper) => !paper.archived && paper.collections.includes(collection.id),
            ).length;
            const parent = collections.find((item) => item.id === collection.parentId);
            return (
              <button
                className="collection-card"
                key={collection.id}
                onClick={() => onOpen(collection.id)}
              >
                <span className="collection-card-icon">
                  <FolderClosed size={22} strokeWidth={1.6} />
                </span>
                <span className="collection-card-copy">
                  {parent && <small>{parent.name}</small>}
                  <strong>{collection.name}</strong>
                  <span>
                    {count} {count === 1 ? 'paper' : 'papers'}
                  </span>
                </span>
                <ArrowRight size={17} className="collection-card-arrow" />
              </button>
            );
          })}
        </div>
      ) : (
        <div className="empty-state filtered-empty">
          <div className="empty-icon">
            <FolderClosed size={23} />
          </div>
          <h2>No collections yet</h2>
          <p>Collections from Zotero will appear here after your library syncs.</p>
        </div>
      )}
    </>
  );
}
