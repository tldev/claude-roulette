import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { RouletteController } from '../hooks/controller';
import type { Host } from '../hooks/controller';

function nativeHost(url: string) {
  let tick = () => {};
  const host: Host = {
    fetch: async (address, init) => {
      const response = await fetch(address, { ...init, signal: AbortSignal.timeout(3000) });
      return { ok: response.ok, status: response.status, text: await response.text() };
    },
    storeGet: async () => undefined, storeSet: async () => {},
    now: async () => Date.now(), every: (_ms, fn) => { tick = fn; return { cancel: () => { tick = () => {}; } }; },
    invalidate: () => {}, status: () => {}, toast: () => {}, open: async () => {}, close: async () => {},
  };
  return { controller: new RouletteController(host, url), tick: () => tick() };
}

async function until(predicate: () => boolean, clients: ReturnType<typeof nativeHost>[]) {
  for (let i = 0; i < 100; i += 1) {
    clients.forEach(client => client.tick());
    if (predicate()) return;
    await delay(20);
  }
  throw new Error('Native controller state did not converge.');
}

describe.skipIf(!process.env.ROULETTE_TEST_SERVER_URL)('native controller with the real HTTP bridge', () => {
  it('pairs, sends, keeps an opted-in conversation, and pauses when the main task finishes', async () => {
    const url = process.env.ROULETTE_TEST_SERVER_URL!;
    const a = nativeHost(url), b = nativeHost(url);
    const clients = [a, b];
    try {
      for (const client of clients) {
        await client.controller.load();
        client.controller.setInterests('client-integration-test');
        client.controller.setLanguage('zz');
        client.controller.setBusy('private-local-turn-id');
        client.controller.activate();
      }
      await until(() => clients.every(c => c.controller.model.phase === 'chatting'), clients);
      expect(a.controller.model.roomId).toBe(b.controller.model.roomId);
      a.controller.send('Hello from the real native adapter.');
      await until(() => b.controller.model.lines.some(line => line.text === 'Hello from the real native adapter.'), clients);
      expect(b.controller.model.lines.at(-1)?.who).toBe('peer');
      expect(a.controller.model.error).toBe('');
      a.controller.toggleKeepChat();
      a.controller.complete('private-local-turn-id');
      await delay(30);
      expect(a.controller.model.phase).toBe('chatting');
      a.controller.send('Claude finished, but we can keep talking.');
      await until(() => b.controller.model.lines.some(line => line.text.includes('keep talking')), clients);
      b.controller.complete('private-local-turn-id');
      await until(() => a.controller.model.lines.some(line => line.text.includes('Their Claude task finished')), clients);
      expect(a.controller.model.roomId).toBeNull();
      expect(b.controller.model.phase).toBe('ready');
    } finally {
      await Promise.all(clients.map(client => client.controller.stop()));
    }
  });
});
