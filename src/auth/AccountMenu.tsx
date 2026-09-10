// Account popover contents. Uses Clerk hooks, so it must only be rendered when
// auth is enabled (inside the ClerkProvider) — guard callers with AUTH_ENABLED.
import type { CSSProperties } from 'react';
import { useUser, useClerk } from '@clerk/clerk-react';
import { theme } from '../app/theme';

export function AccountMenu() {
  const { user } = useUser();
  const { signOut } = useClerk();
  const email = user?.primaryEmailAddress?.emailAddress || user?.username || 'Signed in';

  return (
    <div style={s.wrap}>
      <div style={s.label}>Account</div>
      <div style={s.email}>{email}</div>
      <button style={s.signOut} onClick={() => void signOut()}>Sign out</button>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 180 },
  label: { fontSize: 12, color: theme.color.textFaint },
  email: { fontSize: 13, color: theme.color.text, wordBreak: 'break-all' },
  signOut: {
    marginTop: 4,
    background: 'transparent',
    border: `1px solid ${theme.color.border}`,
    color: theme.color.danger,
    borderRadius: theme.radius.sm,
    padding: '7px 12px',
    fontSize: 13,
    cursor: 'pointer',
  },
};
