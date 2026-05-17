import { useEffect, useRef, useState } from 'react';
import { verifyPassword } from '../lib/password';

interface Props {
  albumId: string;
  albumName: string;
  passwordHash: string;
  passwordSalt: string;
  passwordHint?: string | null;
  contentSelector: string;
}

const STORAGE_PREFIX = 'pw:';

export default function PasswordGate({
  albumId,
  albumName,
  passwordHash,
  passwordSalt,
  passwordHint,
  contentSelector,
}: Props) {
  const [unlocked, setUnlocked] = useState(false);
  const [attempt, setAttempt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const reveal = () => {
    const el = document.querySelector(contentSelector);
    if (el) el.classList.remove('gated-initially-hidden');
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      if (sessionStorage.getItem(STORAGE_PREFIX + albumId) === 'unlocked') {
        setUnlocked(true);
        reveal();
        return;
      }
    } catch {
      // sessionStorage may be unavailable; fall through to gate
    }
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [albumId]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const ok = await verifyPassword(attempt, passwordSalt, passwordHash);
      if (ok) {
        try {
          sessionStorage.setItem(STORAGE_PREFIX + albumId, 'unlocked');
        } catch {
          // ignore
        }
        setUnlocked(true);
        reveal();
      } else {
        setError('Incorrect password.');
      }
    } finally {
      setBusy(false);
    }
  };

  if (unlocked) return null;

  return (
    <div className="password-gate" role="dialog" aria-modal="true" aria-labelledby="pw-gate-title">
      <div className="password-card">
        <h2 id="pw-gate-title">{albumName}</h2>
        <p>This album is password-protected.</p>
        {passwordHint && <p className="hint">Hint: {passwordHint}</p>}
        <form onSubmit={onSubmit}>
          <label>
            <span>Password</span>
            <input
              ref={inputRef}
              type="password"
              value={attempt}
              onChange={(e) => setAttempt(e.target.value)}
              autoComplete="off"
              disabled={busy}
              required
            />
          </label>
          {error && <p className="error" role="alert">{error}</p>}
          <button type="submit" disabled={busy || attempt.length === 0}>
            {busy ? 'Checking…' : 'Unlock'}
          </button>
        </form>
      </div>

      <style>{`
        .password-gate {
          position: fixed;
          inset: 0;
          z-index: 900;
          background: rgba(0, 0, 0, 0.85);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 1rem;
        }
        .password-card {
          background: #fff;
          color: #1a1a1a;
          padding: 2rem;
          border-radius: 6px;
          width: 100%;
          max-width: 380px;
          box-shadow: 0 10px 40px rgba(0,0,0,0.3);
        }
        .password-card h2 {
          margin: 0 0 0.5rem;
          font-family: var(--font-serif), serif;
          font-weight: 500;
          font-size: 1.5rem;
        }
        .password-card p {
          margin: 0 0 0.75rem;
          color: #555;
          font-size: 0.9375rem;
        }
        .password-card .hint {
          background: #f5f5f0;
          padding: 0.5rem 0.75rem;
          border-radius: 4px;
          font-size: 0.875rem;
          color: #444;
        }
        .password-card label {
          display: block;
          margin-bottom: 0.75rem;
        }
        .password-card label span {
          display: block;
          font-size: 0.875rem;
          color: #333;
          margin-bottom: 0.25rem;
        }
        .password-card input {
          width: 100%;
          padding: 0.625rem 0.75rem;
          font-size: 1rem;
          border: 1px solid #ccc;
          border-radius: 4px;
          font-family: inherit;
          box-sizing: border-box;
        }
        .password-card input:focus {
          outline: none;
          border-color: #444;
        }
        .password-card button {
          width: 100%;
          padding: 0.625rem;
          background: #1a1a1a;
          color: #fff;
          border: 0;
          border-radius: 4px;
          font-size: 1rem;
          font-family: inherit;
          cursor: pointer;
          min-height: 44px;
        }
        .password-card button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .password-card .error {
          color: #b00020;
          font-size: 0.875rem;
          margin: 0 0 0.5rem;
        }
      `}</style>
    </div>
  );
}
