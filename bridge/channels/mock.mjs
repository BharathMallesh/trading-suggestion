// Mock channel: needs no credentials. Emits one fake incoming message shortly
// after start, and echoes anything you send back as a new incoming — so the
// whole PWA↔bridge loop can be exercised without real accounts.
export function createMock({ onIncoming, setConnected }) {
  setTimeout(() => {
    setConnected('mock', true);
    onIncoming('mock', {
      chatId: 'demo',
      from: 'Test Contact',
      text: 'Hey! This is a mock incoming message. Reply and I’ll echo it back so you can see the round-trip.',
      id: 'mock-1',
      ts: Date.now(),
    });
  }, 500);

  return {
    connected: true,
    async send(chatId, text) {
      setTimeout(() => {
        onIncoming('mock', {
          chatId,
          from: 'Echo Bot',
          text: `echo: ${text}`,
          id: 'echo-' + Date.now(),
          ts: Date.now(),
        });
      }, 400);
    },
  };
}
