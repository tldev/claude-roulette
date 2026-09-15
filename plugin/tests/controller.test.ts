import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { RouletteController, serverUrl } from '../hooks/controller';
import type { Host } from '../hooks/controller';
import { cleanText, decodeServerEvent } from '../hooks/protocol';
import type { ClientEvent, ServerEvent } from '../hooks/protocol';
import type { ClientEvent as SharedClientEvent, ServerEvent as SharedServerEvent } from '../../src/shared/protocol';

const TOKEN = 'a'.repeat(64);
const STATS = { online: 2, waiting: 1, chatting: 0 };
const flush = async () => { for (let i = 0; i < 40; i += 1) await Promise.resolve(); };

function fixture() {
  let events: unknown[] = [];
  let now = 10000;
  let cursor = 0;
  let tick = () => {};
  const requests: { path: string; method?: string; body?: unknown; headers?: Record<string, string> }[] = [];
  const cancel = vi.fn();
  const host: Host = {
    fetch: vi.fn(async (url, init) => {
      const path = new URL(url).pathname;
      requests.push({ path, method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined, headers: init?.headers });
      let body: unknown = {};
      if (path === '/api/session' && init?.method === 'POST') {
        body = { token: TOKEN, sessionId: 'session-id' };
        events.push({ type: 'welcome', alias: 'Amber Fox', sessionId: 'session-id', stats: STATS });
        if ((JSON.parse(init.body ?? '{}') as { available: boolean }).available) events.push({ type: 'queued', since: now, position: 1 });
      }
      if (path === '/api/events') { cursor += events.length; body = { cursor, events }; events = []; }
      return { ok: true, status: 200, text: JSON.stringify(body) };
    }),
    storeGet: vi.fn(async () => undefined), storeSet: vi.fn(async () => {}),
    now: async () => now, every: (_ms, callback) => { tick = callback; return { cancel }; },
    invalidate: vi.fn(), status: vi.fn(), toast: vi.fn(), open: vi.fn(async () => {}), close: vi.fn(async () => {}),
  };
  const controller = new RouletteController(host, 'http://127.0.0.1:8787');
  return { controller, host, requests, cancel,
    actions: () => requests.filter(r => r.path === '/api/action').map(r => r.body as ClientEvent),
    emit: (...values: unknown[]) => { events.push(...values); },
    tick: async () => { now += 1000; tick(); await flush(); },
  };
}

const match: ServerEvent = { type: 'matched', roomId: 'room', peer: { alias: 'Teal Owl', interests: ['typescript'] }, sharedInterests: ['typescript'], icebreaker: 'What are you building?', startedAt: 10000 };

async function connected() {
  const f = fixture();
  await f.controller.load();
  f.controller.setBusy('main-turn');
  f.controller.activate();
  await flush();
  f.emit(match);
  await f.tick();
  return f;
}

describe('native Claude Mods lifecycle', () => {
  it('does not connect until consent and a real main turn', async () => {
    const f = fixture();
    await f.controller.load();
    await f.controller.open();
    f.controller.activate();
    await flush();
    expect(f.requests).toEqual([]);
    expect(f.controller.model.phase).toBe('ready');
    f.controller.setBusy('turn-1');
    await flush();
    expect(f.requests[0]?.body).toEqual({ profile: { interests: [], mode: 'interests', language: 'en' }, available: true });
    expect(f.controller.model.phase).toBe('queued');
    expect(f.requests.find(r => r.path === '/api/events')?.headers?.['X-Roulette-Session']).toBe('session-id');
  });

  it('ignores subagent and stale turn completions, then withdraws on the active completion', async () => {
    const f = await connected();
    f.controller.complete('main-turn', 'subagent-1');
    f.controller.complete('old-turn');
    await flush();
    expect(f.controller.model.busy).toBe(true);
    expect(f.actions()).toEqual([]);
    f.controller.complete('main-turn');
    await flush();
    expect(f.controller.model.busy).toBe(false);
    expect(f.actions()).toContainEqual({ type: 'availability', available: false, keepChat: false });
    expect(f.controller.model.phase).toBe('ready');
    expect(f.host.toast).toHaveBeenCalledWith('Claude finished. Your task is ready.');
  });

  it('keeps the current room only after the user enables it', async () => {
    const f = await connected();
    f.controller.toggleKeepChat();
    f.controller.complete('main-turn');
    await flush();
    expect(f.controller.model.phase).toBe('chatting');
    expect(f.actions()).toContainEqual({ type: 'availability', available: false, keepChat: true });
    f.controller.next();
    await flush();
    expect(f.actions().some(e => e.type === 'next')).toBe(false);
  });

  it('sends text only through the chat transport, sanitizes controls, and deduplicates echoed events', async () => {
    const f = await connected();
    f.controller.send('hello\u001b[31m\u202esecret');
    await flush();
    expect(f.actions()).toContainEqual({ type: 'message', id: expect.any(String), text: 'hellosecret', roomId: 'room' });
    const message: ServerEvent = { type: 'message', id: 'message-id', text: 'peer\u001b[2J\u202ereply', from: 'peer', at: 10000 };
    f.emit(message, message);
    await f.tick();
    expect(f.controller.model.lines).toHaveLength(1);
    expect(f.controller.model.lines[0]?.text).toBe('peerreply');
    expect(f.host.toast).not.toHaveBeenCalled();
  });

  it('applies edited interests to Next and starts a fresh conversation', async () => {
    const f = await connected();
    f.controller.setInterests('Rust, music, rust, bad!, very-long-interest-name-is-invalid');
    f.controller.next();
    await flush();
    expect(f.actions()).toContainEqual({ type: 'next', profile: { language: 'en', mode: 'interests', interests: ['rust', 'music'] } });
    f.emit({ type: 'message', id: 'old', text: 'old room', from: 'peer', at: 1000 }, match);
    await f.tick();
    expect(f.controller.model.lines).toEqual([]);
  });

  it('stops automatic reconnection when another session owns the identity', async () => {
    const f = await connected();
    f.emit({ type: 'error', code: 'duplicate_session', message: 'Another session connected.' });
    await f.tick();
    const count = f.requests.length;
    await f.tick();
    expect(f.controller.model.enabled).toBe(false);
    expect(f.controller.model.error).toContain('Automatic reconnect is stopped');
    expect(f.cancel).toHaveBeenCalled();
    expect(f.requests).toHaveLength(count);
  });

  it('pauses matching and closes the remote session on stop', async () => {
    const f = await connected();
    f.controller.pause();
    await flush();
    expect(f.actions()).toContainEqual({ type: 'leave' });
    f.controller.setBusy('new-turn');
    await flush();
    expect(f.actions().filter(e => e.type === 'availability')).toEqual([]);
    await f.controller.stop();
    expect(f.cancel).toHaveBeenCalled();
    expect(f.requests.at(-1)?.method).toBe('DELETE');
    expect(f.controller.model.enabled).toBe(false);
  });

  it('binds a delayed report to the room visible when the user clicked', async () => {
    const f = await connected();
    f.controller.report('spam');
    f.controller.model.roomId = 'new-room';
    await flush();
    expect(f.actions()).toContainEqual({ type: 'report', reason: 'spam', roomId: 'room' });
  });

  it('stops after a duplicate-session HTTP response without evicting the other client', async () => {
    const f = await connected();
    f.host.fetch = vi.fn(async () => ({ ok: false, status: 409, text: JSON.stringify({ error: { code: 'duplicate_session', message: 'This identity connected elsewhere.' } }) }));
    await f.tick();
    expect(f.controller.model.enabled).toBe(false);
    expect(f.controller.model.phase).toBe('off');
    const count = vi.mocked(f.host.fetch).mock.calls.length;
    await f.tick();
    expect(vi.mocked(f.host.fetch).mock.calls).toHaveLength(count);
  });

  it.each(['operator_disconnected', 'maintenance'])('waits for Turn on after an %s event', async code => {
    const f = await connected();
    f.emit({ type: 'error', code, message: 'The operator ended this session.' }, match);
    await f.tick();
    expect(f.controller.model).toMatchObject({ enabled: false, phase: 'off', roomId: null, peer: null, peerTyping: false });
    expect(f.controller.model.error).toContain('Turn on again');
    expect(f.cancel).toHaveBeenCalled();
    const count = f.requests.length;
    await f.tick();
    f.controller.setBusy('new-turn');
    await flush();
    expect(f.requests).toHaveLength(count);
    f.controller.activate();
    await flush();
    expect(f.controller.model).toMatchObject({ enabled: true, phase: 'queued', error: '' });
    expect(f.requests.filter(r => r.path === '/api/session' && r.method === 'POST')).toHaveLength(2);
    const afterReconnect = f.requests.length;
    await f.tick();
    expect(f.requests.length).toBeGreaterThan(afterReconnect);
  });

  it.each([
    ['operator_disconnected', '/api/events'],
    ['operator_disconnected', '/api/action'],
    ['maintenance', '/api/events'],
    ['maintenance', '/api/action'],
  ])('waits for manual recovery after %s from %s', async (code, path) => {
    const f = await connected();
    const previousFetch = f.host.fetch;
    f.host.fetch = vi.fn(async (url, init) => new URL(url).pathname === path
      ? { ok: false, status: code === 'maintenance' ? 503 : 410, text: JSON.stringify({ error: { code, message: 'The operator ended this session.' } }) }
      : previousFetch(url, init));
    if (path === '/api/action') { f.controller.send('hello'); await flush(); }
    else await f.tick();
    expect(f.controller.model).toMatchObject({ enabled: false, phase: 'off', roomId: null, peer: null });
    expect(f.controller.model.error).toContain('Turn on again');
    expect(f.controller.model.error).not.toContain('Retrying');
    const count = vi.mocked(f.host.fetch).mock.calls.length;
    await f.tick();
    expect(vi.mocked(f.host.fetch).mock.calls).toHaveLength(count);
    f.host.fetch = previousFetch;
    f.controller.activate();
    await flush();
    expect(f.controller.model).toMatchObject({ enabled: true, phase: 'queued' });
  });

  it('stops connection retries during maintenance and restarts on manual activation', async () => {
    const f = fixture();
    const previousFetch = f.host.fetch;
    f.host.fetch = vi.fn(async () => ({ ok: false, status: 503, text: JSON.stringify({ error: { code: 'maintenance', message: 'Back soon.' } }) }));
    f.controller.setBusy('turn');
    f.controller.activate();
    await flush();
    expect(f.controller.model).toMatchObject({ enabled: false, phase: 'off', error: 'Back soon. Turn on again after the lounge reopens.' });
    await f.tick();
    expect(f.host.fetch).toHaveBeenCalledTimes(1);
    f.host.fetch = previousFetch;
    f.controller.activate();
    await flush();
    expect(f.controller.model).toMatchObject({ enabled: true, phase: 'queued' });
  });

  it('ignores a delayed operator error from an action sent before manual reconnection', async () => {
    const f = await connected();
    const previousFetch = f.host.fetch;
    let resolveAction!: (reply: { ok: boolean; status: number; text: string }) => void;
    f.host.fetch = vi.fn((url, init) => new URL(url).pathname === '/api/action'
      ? new Promise<{ ok: boolean; status: number; text: string }>(resolve => { resolveAction = resolve; })
      : previousFetch(url, init));
    f.controller.send('before disconnect');
    await flush();
    f.emit({ type: 'error', code: 'operator_disconnected', message: 'Session ended.' });
    await f.tick();
    f.controller.activate();
    await flush();
    resolveAction({ ok: false, status: 410, text: JSON.stringify({ error: { code: 'operator_disconnected', message: 'Old session ended.' } }) });
    await flush();
    expect(f.controller.model).toMatchObject({ enabled: true, phase: 'queued', error: '' });
    expect(f.host.toast).toHaveBeenCalledTimes(1);
  });

  it('cleans up a late session creation after the user has turned the mod off', async () => {
    const f = fixture();
    const previousFetch = f.host.fetch;
    let resolveSession!: (reply: { ok: boolean; status: number; text: string }) => void;
    f.host.fetch = vi.fn((url, init) => init?.method === 'POST' && url.endsWith('/api/session')
      ? new Promise<{ ok: boolean; status: number; text: string }>(resolve => { resolveSession = resolve; })
      : previousFetch(url, init));
    f.controller.setBusy('turn');
    f.controller.activate();
    await f.controller.stop();
    resolveSession({ ok: true, status: 200, text: JSON.stringify({ token: TOKEN, sessionId: 'late-session' }) });
    await flush();
    expect(f.requests).toContainEqual(expect.objectContaining({ method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}`, 'X-Roulette-Session': 'late-session' } }));
    expect(f.controller.model.enabled).toBe(false);
  });

  it('handles corrupted server data without rendering unsafe values', async () => {
    const f = await connected();
    f.emit({ type: 'matched', peer: null });
    await f.tick();
    expect(f.controller.model.phase).toBe('reconnecting');
    expect(f.controller.model.error).toContain('Invalid server event');
  });
});

describe('wire boundary', () => {
  it('keeps dependency-free protocol types aligned with the shared contract', () => {
    expectTypeOf<ClientEvent>().toEqualTypeOf<SharedClientEvent>();
    expectTypeOf<ServerEvent>().toEqualTypeOf<SharedServerEvent>();
  });
  it('requires encrypted remote transport and rejects credentials', () => {
    expect(serverUrl('http://127.0.0.1:8787/')).toBe('http://127.0.0.1:8787');
    expect(serverUrl('https://roulette.example.com')).toBe('https://roulette.example.com');
    expect(() => serverUrl('http://remote.example')).toThrow('HTTPS');
    expect(() => serverUrl('https://user:pass@example.com')).toThrow('without credentials');
  });
  it('rejects invalid payloads and strips terminal escapes and invisible controls', () => {
    expect(() => decodeServerEvent({ type: 'stats', stats: { online: -1 } })).toThrow();
    expect(() => decodeServerEvent({ type: 'message', text: 'a'.repeat(2001) })).toThrow();
    expect(() => decodeServerEvent({ type: 'prompt.submit', text: 'execute this' })).toThrow();
    expect(cleanText('ok\u001b]0;window title\u0007\u0000\u202ebad')).toBe('okbad');
  });
});
