import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AlbumImage } from '../content/config';
import type { ImageMetaEntry } from '../lib/image-meta';
import { derivativeUrl, originalUrl, type ImageFormat } from '../lib/asset-urls';
import { buildImagePath, isNativeImageId, parsePathname } from '../lib/url-state';

interface Props {
  albumPath: string;
  albumName: string;
  images: AlbumImage[];
  imageMetas: Record<string, ImageMetaEntry>;
  legacyKeys: Record<string, string>;
}

const DEFAULT_WIDTHS = [480, 960, 1600, 2400];
const DEFAULT_FORMATS: ImageFormat[] = ['avif', 'webp', 'jpg'];
const SWIPE_THRESHOLD = 50;

export default function Lightbox({
  albumPath,
  albumName,
  images,
  imageMetas,
  legacyKeys,
}: Props) {
  const [index, setIndex] = useState<number | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');
  const touchStartX = useRef<number | null>(null);

  const idToIndex = useMemo(() => {
    const m = new Map<string, number>();
    images.forEach((img, i) => m.set(img.image_id, i));
    return m;
  }, [images]);

  const filenameToIndex = useMemo(() => {
    const m = new Map<string, number>();
    images.forEach((img, i) => m.set(img.filename, i));
    return m;
  }, [images]);

  const resolveKey = useCallback(
    (key: string): number | null => {
      if (isNativeImageId(key)) {
        const native = idToIndex.get(key);
        if (native !== undefined) return native;
      }
      const filename = legacyKeys[key];
      if (filename) {
        const legacy = filenameToIndex.get(filename);
        if (legacy !== undefined) return legacy;
      }
      return null;
    },
    [idToIndex, filenameToIndex, legacyKeys],
  );

  const openAt = useCallback(
    (i: number, opts: { pushHistory?: boolean } = { pushHistory: true }) => {
      if (i < 0 || i >= images.length) return;
      setIndex(i);
      if (opts.pushHistory) {
        const url = buildImagePath(albumPath, images[i].image_id);
        if (window.location.pathname !== url) {
          window.history.pushState(null, '', url);
        }
      }
    },
    [albumPath, images],
  );

  const close = useCallback(
    (opts: { pushHistory?: boolean } = { pushHistory: true }) => {
      setIndex(null);
      setShowInfo(false);
      if (opts.pushHistory && window.location.pathname !== albumPath) {
        window.history.pushState(null, '', albumPath);
      }
    },
    [albumPath],
  );

  const next = useCallback(() => {
    if (index === null) return;
    openAt(Math.min(images.length - 1, index + 1));
  }, [index, images.length, openAt]);

  const prev = useCallback(() => {
    if (index === null) return;
    openAt(Math.max(0, index - 1));
  }, [index, openAt]);

  useEffect(() => {
    const parsed = parsePathname(window.location.pathname);
    if (parsed.albumPath === albumPath && parsed.key) {
      const i = resolveKey(parsed.key);
      if (i !== null) {
        openAt(i, { pushHistory: false });
        if (parsed.key !== images[i].image_id) {
          window.history.replaceState(null, '', buildImagePath(albumPath, images[i].image_id));
        }
      } else {
        window.history.replaceState(null, '', albumPath);
      }
    }
  }, []);

  useEffect(() => {
    const triggers = document.querySelectorAll<HTMLElement>('#album-thumbs .thumb-trigger');
    const handlers: Array<[HTMLElement, (e: Event) => void]> = [];
    triggers.forEach((el) => {
      const h = (e: Event) => {
        e.preventDefault();
        const i = Number(el.dataset.index);
        if (!Number.isNaN(i)) openAt(i);
      };
      el.addEventListener('click', h);
      handlers.push([el, h]);
    });
    return () => {
      handlers.forEach(([el, h]) => el.removeEventListener('click', h));
    };
  }, [openAt]);

  useEffect(() => {
    const onPop = () => {
      const parsed = parsePathname(window.location.pathname);
      if (parsed.albumPath !== albumPath) return;
      if (parsed.key) {
        const i = resolveKey(parsed.key);
        if (i !== null) openAt(i, { pushHistory: false });
        else close({ pushHistory: false });
      } else {
        close({ pushHistory: false });
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [albumPath, resolveKey, openAt, close]);

  useEffect(() => {
    if (index === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowLeft') prev();
      else if (e.key === 'i' || e.key === 'I') setShowInfo((s) => !s);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, close, next, prev]);

  useEffect(() => {
    if (index === null) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [index]);

  const onTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null) return;
    const delta = e.changedTouches[0].clientX - touchStartX.current;
    touchStartX.current = null;
    if (Math.abs(delta) < SWIPE_THRESHOLD) return;
    if (delta < 0) next();
    else prev();
  };

  const share = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 1500);
    } catch {
      setCopyState('idle');
    }
  };

  if (index === null) return null;
  const current = images[index];
  const meta = imageMetas[current.image_id];
  const widths = meta?.widths?.length ? meta.widths : DEFAULT_WIDTHS;
  const formats: ImageFormat[] = meta?.formats?.length ? meta.formats : DEFAULT_FORMATS;
  const srcsetFor = (fmt: ImageFormat) =>
    widths.map((w) => `${derivativeUrl(current.image_id, w, fmt)} ${w}w`).join(', ');
  const fallbackWidth = widths.includes(1600) ? 1600 : widths[widths.length - 1];
  const fallback = derivativeUrl(current.image_id, fallbackWidth, 'jpg');
  const mimeFor = (fmt: ImageFormat) => (fmt === 'jpg' ? 'image/jpeg' : `image/${fmt}`);

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`${albumName}, photo ${index + 1} of ${images.length}`}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <div className="lightbox-backdrop" onClick={() => close()} />
      <div className="lightbox-stage">
        <picture>
          {formats
            .filter((f) => f !== 'jpg')
            .map((fmt) => (
              <source key={fmt} type={mimeFor(fmt)} srcSet={srcsetFor(fmt)} sizes="100vw" />
            ))}
          <img
            src={fallback}
            srcSet={formats.includes('jpg') ? srcsetFor('jpg') : undefined}
            sizes="100vw"
            alt={current.caption || current.filename}
            width={meta?.width}
            height={meta?.height}
            decoding="async"
            fetchPriority="high"
          />
        </picture>
        {current.caption && <p className="lightbox-caption">{current.caption}</p>}
      </div>

      <div className="lightbox-controls">
        <div className="lightbox-controls-left">
          <span className="counter">{index + 1} / {images.length}</span>
        </div>
        <div className="lightbox-controls-right">
          <button type="button" onClick={share} title="Copy share link">
            {copyState === 'copied' ? 'Copied' : 'Share'}
          </button>
          <button
            type="button"
            onClick={() => setShowInfo((s) => !s)}
            title="Toggle info"
            aria-pressed={showInfo}
          >
            Info
          </button>
          <a
            href={originalUrl(current.image_id, current.filename)}
            download={current.filename}
            title="Download original"
          >
            Download
          </a>
          <button type="button" onClick={() => close()} aria-label="Close">
            ✕
          </button>
        </div>
      </div>

      {index > 0 && (
        <button type="button" className="lightbox-nav lightbox-prev" onClick={prev} aria-label="Previous photo">
          ‹
        </button>
      )}
      {index < images.length - 1 && (
        <button type="button" className="lightbox-nav lightbox-next" onClick={next} aria-label="Next photo">
          ›
        </button>
      )}

      {showInfo && meta?.exif && (
        <aside className="lightbox-info">
          <h3>Info</h3>
          <dl>
            {(meta.exif.make || meta.exif.model) && (
              <>
                <dt>Camera</dt>
                <dd>{[meta.exif.make, meta.exif.model].filter(Boolean).join(' ')}</dd>
              </>
            )}
            {meta.exif.lens && (
              <>
                <dt>Lens</dt>
                <dd>{meta.exif.lens}</dd>
              </>
            )}
            {meta.exif.aperture && (
              <>
                <dt>Aperture</dt>
                <dd>{meta.exif.aperture}</dd>
              </>
            )}
            {meta.exif.shutter && (
              <>
                <dt>Shutter</dt>
                <dd>{meta.exif.shutter}</dd>
              </>
            )}
            {typeof meta.exif.iso === 'number' && (
              <>
                <dt>ISO</dt>
                <dd>{meta.exif.iso}</dd>
              </>
            )}
            {meta.exif.focal_length && (
              <>
                <dt>Focal length</dt>
                <dd>{meta.exif.focal_length}</dd>
              </>
            )}
            {meta.exif.date_taken && (
              <>
                <dt>Taken</dt>
                <dd>{meta.exif.date_taken}</dd>
              </>
            )}
            <dt>Filename</dt>
            <dd>{current.filename}</dd>
          </dl>
        </aside>
      )}

      <style>{`
        .lightbox {
          position: fixed;
          inset: 0;
          z-index: 1000;
          background: rgba(0, 0, 0, 0.96);
          color: #f5f5f5;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .lightbox-backdrop {
          position: absolute;
          inset: 0;
        }
        .lightbox-stage {
          position: relative;
          max-width: 100vw;
          max-height: 100vh;
          padding: 4rem 1rem 5rem;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 0.75rem;
          pointer-events: none;
        }
        .lightbox-stage picture, .lightbox-stage img {
          max-width: 100%;
          max-height: calc(100vh - 9rem);
          width: auto;
          height: auto;
          object-fit: contain;
          pointer-events: auto;
        }
        .lightbox-caption {
          color: #ddd;
          font-size: 0.875rem;
          text-align: center;
          margin: 0;
          max-width: 60ch;
          pointer-events: auto;
        }
        .lightbox-controls {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          padding: 0.75rem 1rem;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 0.5rem;
          background: linear-gradient(to bottom, rgba(0,0,0,0.6), transparent);
        }
        .lightbox-controls-left, .lightbox-controls-right {
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }
        .lightbox-controls button,
        .lightbox-controls a {
          color: #f5f5f5;
          background: transparent;
          border: 1px solid rgba(255,255,255,0.3);
          padding: 0.4rem 0.75rem;
          border-radius: 4px;
          font-size: 0.875rem;
          font-family: inherit;
          cursor: pointer;
          text-decoration: none;
          min-height: 44px;
          display: inline-flex;
          align-items: center;
        }
        .lightbox-controls button:hover,
        .lightbox-controls a:hover {
          background: rgba(255,255,255,0.1);
        }
        .counter {
          color: #ddd;
          font-size: 0.875rem;
          font-variant-numeric: tabular-nums;
        }
        .lightbox-nav {
          position: absolute;
          top: 50%;
          transform: translateY(-50%);
          width: 56px;
          height: 56px;
          background: rgba(0,0,0,0.4);
          color: #fff;
          border: 0;
          font-size: 2.5rem;
          line-height: 1;
          cursor: pointer;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .lightbox-nav:hover {
          background: rgba(0,0,0,0.7);
        }
        .lightbox-prev { left: 1rem; }
        .lightbox-next { right: 1rem; }
        @media (max-width: 640px) {
          .lightbox-nav { display: none; }
          .lightbox-stage { padding: 3.5rem 0.5rem 4rem; }
        }
        .lightbox-info {
          position: absolute;
          right: 1rem;
          top: 4rem;
          background: rgba(0,0,0,0.85);
          padding: 1rem 1.25rem;
          border-radius: 4px;
          max-width: 320px;
          font-size: 0.8125rem;
        }
        .lightbox-info h3 {
          margin: 0 0 0.5rem;
          font-size: 0.75rem;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: #aaa;
        }
        .lightbox-info dl {
          margin: 0;
          display: grid;
          grid-template-columns: auto 1fr;
          gap: 0.25rem 0.75rem;
        }
        .lightbox-info dt {
          color: #aaa;
        }
        .lightbox-info dd {
          margin: 0;
        }
        @media (max-width: 640px) {
          .lightbox-info {
            top: auto;
            bottom: 5rem;
            right: 0.5rem;
            left: 0.5rem;
            max-width: none;
          }
        }
      `}</style>
    </div>
  );
}
