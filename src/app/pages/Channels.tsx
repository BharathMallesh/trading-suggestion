// Channels: connect the assistant to messaging surfaces. Left list picks a
// channel; the right panel walks its setup. Wiring to real bots/tokens is a
// later, connector-specific pass — this is the UI + local step state.
import { useState } from 'react';
import type { CSSProperties } from 'react';
import { theme } from '../theme';
import { usePersistentState } from '../store';
import type { Store } from '../store';
import type { Bridge } from '../bridge';

interface Channel {
  id: string;
  name: string;
  icon: string;
}
const CHANNELS: Channel[] = [
  { id: 'slack', name: 'Slack', icon: '#' },
  { id: 'telegram', name: 'Telegram', icon: '➤' },
  { id: 'discord', name: 'Discord', icon: '🎮' },
  { id: 'email', name: 'Email', icon: '✉' },
  { id: 'phone', name: 'Phone', icon: '📞' },
];
const STEPS = ['Name', 'Open', 'Create', 'Connect'] as const;

interface ChannelSetup {
  appName: string;
  description: string;
}

export function Channels({
  name = 'Luna',
  store,
  bridge,
  onOpenMessages,
}: {
  name?: string;
  store: Store;
  bridge?: Bridge;
  onOpenMessages?: () => void;
}) {
  const isConnected = (id: string) => !!bridge?.channels.find((c) => c.id === id && c.connected);
  const [selected, setSelected] = useState('slack');
  const [step, setStep] = useState(0);
  const [copied, setCopied] = useState(false);
  const [setup, setSetup] = usePersistentState<Record<string, ChannelSetup>>(store, 'channels', {});

  const channel = CHANNELS.find((c) => c.id === selected)!;
  const current = setup[selected] ?? { appName: name, description: '' };
  const appName = current.appName;
  const description = current.description;
  const patch = (p: Partial<ChannelSetup>) =>
    setSetup((prev) => ({ ...prev, [selected]: { ...current, ...p } }));

  return (
    <div style={s.wrap}>
      <div style={s.head}>
        <h2 style={s.title}>‹ Channels</h2>
        <div style={s.bridgeStatus}>
          <span style={s.statusDot(!!bridge?.connected)} />
          {bridge?.connected ? 'Bridge connected' : 'Bridge offline'}
          {bridge?.connected && onOpenMessages && (
            <button style={s.openMsgs} onClick={onOpenMessages}>Open Messages →</button>
          )}
        </div>
      </div>
      <div style={s.body}>
        <div style={s.list}>
          {CHANNELS.map((c) => (
            <button
              key={c.id}
              style={{ ...s.chan, ...(selected === c.id ? s.chanActive : {}) }}
              onClick={() => {
                setSelected(c.id);
                setStep(0);
              }}
            >
              <span style={s.chanIcon}>{c.icon}</span>
              <span style={{ flex: 1, textAlign: 'left' }}>{c.name}</span>
              {isConnected(c.id) ? (
                <span style={s.connected}>Connected</span>
              ) : (
                <span style={s.notConnected}>Not connected</span>
              )}
            </button>
          ))}
        </div>

        <div style={s.panel}>
          <div style={s.panelHead}>
            <span style={s.panelIcon}>{channel.icon}</span>
            <span style={s.panelTitle}>{channel.name} setup</span>
          </div>

          <div style={s.steps}>
            {STEPS.map((label, i) => (
              <button
                key={label}
                style={{ ...s.step, color: i === step ? theme.color.text : theme.color.textFaint }}
                onClick={() => setStep(i)}
              >
                {label}
              </button>
            ))}
          </div>

          {step === 0 && (
            <div style={s.form}>
              <p style={s.instruction}>Name your {channel.name} app and copy its manifest. Every permission and setting comes pre-configured.</p>
              <label style={s.field}>App Name
                <input style={s.input} value={appName} onChange={(e) => patch({ appName: e.target.value })} />
              </label>
              <label style={s.field}>Description (optional)
                <input style={s.input} value={description} onChange={(e) => patch({ description: e.target.value })} placeholder="What this assistant helps with" />
                <span style={s.hint}>Shown on the app’s {channel.name} profile.</span>
              </label>
              <div style={s.actions}>
                <button
                  style={s.ghost}
                  onClick={() => {
                    void navigator.clipboard?.writeText(JSON.stringify({ display_information: { name: appName, description } }, null, 2));
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                >
                  ⧉ {copied ? 'Copied' : 'Copy manifest'}
                </button>
                <button style={s.next} onClick={() => setStep(1)}>Next</button>
              </div>
            </div>
          )}
          {step === 1 && <StepNote text={`Open ${channel.name}'s app dashboard and paste the manifest you copied to create the app.`} onNext={() => setStep(2)} />}
          {step === 2 && <StepNote text="Create the app, then install it to your workspace to obtain its tokens." onNext={() => setStep(3)} />}
          {step === 3 && <StepNote text={`Paste the bot & app tokens here to connect ${channel.name}. (Token wiring lands in the connector pass.)`} />}
        </div>
      </div>
    </div>
  );
}

function StepNote({ text, onNext }: { text: string; onNext?: () => void }) {
  return (
    <div style={s.form}>
      <p style={s.instruction}>{text}</p>
      {onNext && (
        <div style={s.actions}>
          <button style={s.next} onClick={onNext}>Next</button>
        </div>
      )}
    </div>
  );
}

const s: Record<string, CSSProperties> & { statusDot: (c: boolean) => CSSProperties } = {
  wrap: { height: '100%', display: 'flex', flexDirection: 'column', padding: 20 },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  title: { fontFamily: theme.font.serif, fontWeight: 400, fontSize: 22, margin: 0, color: theme.color.text },
  bridgeStatus: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: theme.color.textDim },
  statusDot: (c: boolean): CSSProperties => ({ width: 8, height: 8, borderRadius: '50%', background: c ? theme.color.online : theme.color.offline }),
  openMsgs: { marginLeft: 6, background: 'transparent', border: `1px solid ${theme.color.border}`, color: theme.color.textDim, borderRadius: theme.radius.sm, padding: '4px 10px', fontSize: 12, cursor: 'pointer' },
  connected: { fontSize: 11, color: theme.color.online, background: theme.color.panel, border: `1px solid ${theme.color.borderSoft}`, borderRadius: 5, padding: '2px 7px' },
  body: { flex: 1, display: 'flex', gap: 16, minHeight: 0 },
  list: { width: 260, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 4 },
  chan: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '11px 12px', borderRadius: theme.radius.sm,
    background: theme.color.card, border: `1px solid ${theme.color.borderSoft}`, color: theme.color.text, fontSize: 14, cursor: 'pointer',
  },
  chanActive: { borderColor: theme.color.border, background: theme.color.panel },
  chanIcon: { width: 18, textAlign: 'center' },
  notConnected: {
    fontSize: 11, color: theme.color.textFaint, background: theme.color.bg,
    border: `1px solid ${theme.color.borderSoft}`, borderRadius: 5, padding: '2px 7px',
  },
  panel: {
    flex: 1, minWidth: 0, background: theme.color.card, border: `1px solid ${theme.color.borderSoft}`,
    borderRadius: theme.radius.md, padding: 20, display: 'flex', flexDirection: 'column', gap: 16,
  },
  panelHead: { display: 'flex', alignItems: 'center', gap: 10 },
  panelIcon: { fontSize: 18 },
  panelTitle: { fontSize: 17, color: theme.color.text },
  steps: { display: 'flex', gap: 18, borderBottom: `1px solid ${theme.color.borderSoft}`, paddingBottom: 10 },
  step: { background: 'transparent', border: 'none', fontSize: 14, cursor: 'pointer', padding: 0 },
  form: { display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 620 },
  instruction: { color: theme.color.textDim, fontSize: 14, margin: 0, lineHeight: 1.5 },
  field: { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: theme.color.textDim },
  input: {
    background: theme.color.panel, border: `1px solid ${theme.color.border}`, borderRadius: theme.radius.sm,
    padding: '10px 12px', color: theme.color.text, fontSize: 14, outline: 'none', fontFamily: theme.font.sans,
  },
  hint: { fontSize: 12, color: theme.color.textFaint },
  actions: { display: 'flex', gap: 10, marginTop: 4 },
  ghost: { background: theme.color.panel, border: `1px solid ${theme.color.border}`, color: theme.color.textDim, borderRadius: theme.radius.sm, padding: '9px 14px', fontSize: 13, cursor: 'pointer' },
  next: { background: theme.color.text, color: theme.color.bg, border: 'none', borderRadius: theme.radius.sm, padding: '9px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
};
