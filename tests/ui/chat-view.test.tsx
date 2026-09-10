import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { StrictMode } from 'react';
import { ChatView } from '../../src/ui/ChatView';
import type { AgentEvent } from '@core/events';
import type { ChatViewProps } from '../../src/ui/ChatView';

// vitest runs without globals, so RTL's automatic cleanup never registers.
afterEach(cleanup);

function captureEmitters() {
  const emitters: Array<(e: AgentEvent) => void> = [];
  const registerEmitter = (fn: (e: AgentEvent) => void) => {
    emitters.push(fn);
    return () => {};
  };
  return { emitters, registerEmitter };
}

/** Emulates App's fan-out registry: register returns an unregister cleanup. */
function makeRegistry() {
  const emitters: Array<(e: AgentEvent) => void> = [];
  const props = {
    send: async () => {},
    registerEmitter: (fn: (e: AgentEvent) => void) => {
      emitters.push(fn);
      return () => {
        const i = emitters.indexOf(fn);
        if (i >= 0) emitters.splice(i, 1);
      };
    },
    resolveConfirm: () => {},
  } satisfies ChatViewProps;
  return { emitters, props };
}

describe('ChatView', () => {
  it('renders streamed tokens into the assistant message', async () => {
    const sent: string[] = [];
    const { emitters, registerEmitter } = captureEmitters();
    render(
      <ChatView
        send={async (t) => { sent.push(t); }}
        registerEmitter={registerEmitter}
        resolveConfirm={() => {}}
      />,
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    act(() => {
      emitters[0]({ event: 'token', text: 'Hi ' });
      emitters[0]({ event: 'token', text: 'there' });
    });
    expect(await screen.findByText('Hi there')).toBeTruthy();
    expect(sent).toEqual(['hello']);
  });

  it('shows tool calls in the trace panel', async () => {
    const { emitters, registerEmitter } = captureEmitters();
    render(
      <ChatView
        send={async () => {}}
        registerEmitter={registerEmitter}
        resolveConfirm={() => {}}
      />,
    );
    act(() => {
      emitters[0]({ event: 'tool_call', step: 1, tool: 'read_file', args: { path: 'a.txt' } });
      emitters[0]({
        event: 'tool_result',
        step: 1,
        tool: 'read_file',
        truncated: false,
        bytes: 12,
      });
    });
    expect(await screen.findByText(/read_file/)).toBeTruthy();
  });

  it('opens a confirm dialog and reports the user decision', async () => {
    const { emitters, registerEmitter } = captureEmitters();
    const decisions: Array<{ id: string; ok: boolean }> = [];
    render(
      <ChatView
        send={async () => {}}
        registerEmitter={registerEmitter}
        resolveConfirm={(id, ok) => decisions.push({ id, ok })}
      />,
    );
    act(() => {
      emitters[0]({
        event: 'confirm_request',
        id: 'confirm-1',
        tool: 'write_file',
        args: { path: 'a.txt' },
        reason: 'tool write_file modifies the workspace',
      });
    });
    expect((await screen.findAllByText(/write_file/)).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    expect(decisions).toEqual([{ id: 'confirm-1', ok: true }]);
    expect(screen.queryByText(/approve/i)).toBeNull();
  });

  it('unregisters its emitter on unmount (StrictMode-safe)', () => {
    const { emitters, props } = makeRegistry();
    const first = render(
      <StrictMode>
        <ChatView {...props} />
      </StrictMode>,
    );
    // StrictMode mounts, unmounts, and remounts effects; exactly one live
    // handler must remain.
    expect(emitters.length).toBe(1);
    first.unmount();
    expect(emitters.length).toBe(0);
    render(
      <StrictMode>
        <ChatView {...props} />
      </StrictMode>,
    );
    expect(emitters.length).toBe(1);
    act(() => emitters[0]({ event: 'token', text: 'once' }));
    expect(screen.getAllByText('once')).toHaveLength(1);
  });

  it('finalizes the assistant message and shows status on run_end', async () => {
    const { emitters, registerEmitter } = captureEmitters();
    render(
      <ChatView
        send={async () => {}}
        registerEmitter={registerEmitter}
        resolveConfirm={() => {}}
      />,
    );
    act(() => {
      emitters[0]({ event: 'token', text: 'Hi there' });
      emitters[0]({ event: 'run_end', status: 'completed', steps: 2, message: 'Hi there' });
    });
    expect((await screen.findAllByText('Hi there')).length).toBeGreaterThan(0);
    expect(screen.getByText('run completed · 2 steps')).toBeTruthy();
  });

  it('queues a second confirm_request while one is open', async () => {
    const { emitters, registerEmitter } = captureEmitters();
    const decisions: Array<{ id: string; ok: boolean }> = [];
    render(
      <ChatView
        send={async () => {}}
        registerEmitter={registerEmitter}
        resolveConfirm={(id, ok) => decisions.push({ id, ok })}
      />,
    );
    act(() => {
      emitters[0]({
        event: 'confirm_request',
        id: 'confirm-1',
        tool: 'write_file',
        args: { path: 'a.txt' },
        reason: 'r1',
      });
      emitters[0]({
        event: 'confirm_request',
        id: 'confirm-2',
        tool: 'read_file',
        args: { path: 'b.txt' },
        reason: 'r2',
      });
    });
    expect((await screen.findAllByText(/write_file/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/read_file/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    expect((await screen.findAllByText(/read_file/)).length).toBeGreaterThan(0);
    expect(decisions).toEqual([{ id: 'confirm-1', ok: true }]);
    fireEvent.click(screen.getByRole('button', { name: /deny/i }));
    expect(decisions).toEqual([
      { id: 'confirm-1', ok: true },
      { id: 'confirm-2', ok: false },
    ]);
    expect(screen.queryByText(/approve/i)).toBeNull();
  });
});
