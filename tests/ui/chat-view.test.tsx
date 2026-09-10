import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ChatView } from '../../src/ui/ChatView';
import type { AgentEvent } from '@core/events';

describe('ChatView', () => {
  it('renders streamed tokens into the assistant message', async () => {
    const sent: string[] = [];
    const emitters: Array<(e: AgentEvent) => void> = [];
    render(
      <ChatView
        send={async (t) => { sent.push(t); }}
        registerEmitter={(e) => emitters.push(e)}
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
    const emitters: Array<(e: AgentEvent) => void> = [];
    render(
      <ChatView
        send={async () => {}}
        registerEmitter={(e) => emitters.push(e)}
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
    const emitters: Array<(e: AgentEvent) => void> = [];
    const decisions: Array<{ id: string; ok: boolean }> = [];
    render(
      <ChatView
        send={async () => {}}
        registerEmitter={(e) => emitters.push(e)}
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
});
