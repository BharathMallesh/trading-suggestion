// Hybrid auth: Clerk signs the user in ONLINE, then the app runs OFFLINE.
// - No Clerk key configured  -> auth disabled, app runs as before (graceful).
// - Online + signed out       -> Clerk sign-in screen.
// - Online + signed in        -> render the app; cache a "signed in" marker.
// - Offline + recent marker   -> render the app (offline grace window).
// - Offline + no/expired marker -> ask the user to go online once to sign in.
import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { ClerkProvider, SignedIn, SignedOut, SignIn, useUser } from '@clerk/clerk-react';

const KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;
/** True when a Clerk key is configured, so callers can safely use Clerk hooks. */
export const AUTH_ENABLED = !!KEY;
const CACHE = 'luna-auth';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30-day offline grace after a sign-in

function cachedValid(): boolean {
  try {
    const raw = localStorage.getItem(CACHE);
    if (!raw) return false;
    const { at } = JSON.parse(raw) as { at?: number };
    return typeof at === 'number' && Date.now() - at < MAX_AGE_MS;
  } catch {
    return false;
  }
}

// Records a fresh marker whenever a signed-in user is present, extending the
// offline grace window on every online visit.
function PersistAuth(): null {
  const { user } = useUser();
  useEffect(() => {
    if (!user) return;
    try {
      localStorage.setItem(CACHE, JSON.stringify({ userId: user.id, at: Date.now() }));
    } catch {
      /* storage unavailable — offline grace just won't apply */
    }
  }, [user]);
  return null;
}

// Clears the marker when signed out online, so a later offline visit can't
// bypass the gate after an explicit sign-out.
function ClearAuth(): null {
  useEffect(() => {
    try {
      localStorage.removeItem(CACHE);
    } catch {
      /* ignore */
    }
  }, []);
  return null;
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [online] = useState(() => (typeof navigator !== 'undefined' ? navigator.onLine : true));

  if (!KEY) return <>{children}</>; // auth not configured → run as before

  if (!online) {
    return cachedValid() ? (
      <>{children}</>
    ) : (
      <Notice
        title="Sign-in needed"
        body="Connect to the internet once to sign in. After that, Buddy opens offline for 30 days."
      />
    );
  }

  return (
    <ClerkProvider publishableKey={KEY} afterSignOutUrl="/">
      <SignedIn>
        <PersistAuth />
        {children}
      </SignedIn>
      <SignedOut>
        <ClearAuth />
        <div style={s.page}>
          <div style={s.head}>
            <h1 style={s.title}>Welcome to Buddy</h1>
            <p style={s.sub}>Sign in to continue. Your data stays on this device.</p>
          </div>
          <SignIn routing="hash" />
        </div>
      </SignedOut>
    </ClerkProvider>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div style={s.page}>
      <div style={s.card}>
        <h1 style={s.title}>{title}</h1>
        <p style={s.sub}>{body}</p>
        <button style={s.button} onClick={() => location.reload()}>Retry</button>
      </div>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  page: {
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 20,
    background: '#0d0d0f',
    fontFamily: "'Inter', system-ui, sans-serif",
  },
  head: { textAlign: 'center' },
  title: { fontFamily: "'Newsreader', Georgia, serif", fontWeight: 400, color: '#ededed', margin: 0 },
  sub: { color: '#a0a0a6', fontSize: 14, marginTop: 8 },
  card: { background: '#161618', border: '1px solid #262629', borderRadius: 18, padding: 32, maxWidth: 420, textAlign: 'center' },
  button: {
    marginTop: 16,
    background: '#e4c013',
    color: '#151206',
    border: 'none',
    borderRadius: 8,
    padding: '10px 20px',
    fontWeight: 600,
    cursor: 'pointer',
  },
};
