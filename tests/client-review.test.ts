import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import { DemoClient, RouletteClient } from '../src/client/client.js';
import { identityFor, type LocalConfig } from '../src/client/config.js';
import type { ClientEvent, ServerEvent } from '../src/shared/protocol.js';

const disposals: Array<() => void> = [];
afterEach(() => { disposals.splice(0).reverse().forEach(dispose => dispose()); vi.useRealTimers(); });
async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Expected client state was not reached');
}

async function lounge() {
  const server = new WebSocketServer({ port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  const sessions: Array<{ socket: WebSocket; available: boolean; events: ClientEvent[] }> = [];
  server.on('connection', socket => {
    const session = { socket, available: false, events: [] as ClientEvent[] };
    sessions.push(session);
    const emit = (event: ServerEvent) => socket.send(JSON.stringify(event));
    const queue = () => emit(session.available ? { type: 'queued', since: Date.now(), position: 1 } : { type: 'paused', reason: 'Waiting for availability.' });
    socket.on('message', bytes => {
      const event = JSON.parse(bytes.toString()) as ClientEvent;
      session.events.push(event);
      if (event.type === 'hello') {
        session.available = event.available;
        emit({ type: 'welcome', alias: 'Test Otter', sessionId: String(sessions.length), stats: { online: 1, waiting: 0, chatting: 0 } });
        queue();
      } else if (event.type === 'join' || event.type === 'next') queue();
      else if (event.type === 'availability') { session.available = event.available; queue(); }
    });
  });
  const client = new RouletteClient({ url: `http://localhost:${address.port}`, token: 'a'.repeat(64), profile: { interests: [], language: 'en', mode: 'random' } });
  disposals.push(() => { client.disconnect(); server.clients.forEach(socket => socket.terminate()); server.close(); });
  client.connect();
  await eventually(() => client.getSnapshot().status === 'queued');
  return { client, sessions };
}

describe('client reconnect review regressions', () => {
  it('restores availability when joining after a paused reconnect', async () => {
    const { client, sessions } = await lounge();
    sessions[0]!.socket.terminate();
    await eventually(() => client.getSnapshot().connection === 'reconnecting');
    client.send({ type: 'leave' });
    client.connect();
    await eventually(() => sessions.length === 2 && client.getSnapshot().connection === 'connected');
    expect(sessions[1]!.events[0]).toMatchObject({ type: 'hello', available: false });
    client.setProfile({ interests: ['rust'], language: 'en', mode: 'interests' });
    client.send({ type: 'join' });
    await eventually(() => client.getSnapshot().status === 'queued');
    expect(sessions[1]!.events.slice(1)).toEqual([
      { type: 'join', profile: { interests: ['rust'], language: 'en', mode: 'interests' } },
      { type: 'availability', available: true, keepChat: false },
    ]);
    expect(sessions[1]!.available).toBe(true);
  });

  it('preserves pause after a partner leaves across reconnects', async () => {
    const { client, sessions } = await lounge();
    sessions[0]!.socket.send(JSON.stringify({ type: 'peer_left', reason: 'left' }));
    await eventually(() => client.getSnapshot().status === 'paused');
    sessions[0]!.socket.terminate();
    await eventually(() => client.getSnapshot().connection === 'reconnecting');
    client.connect();
    await eventually(() => sessions.length === 2 && client.getSnapshot().connection === 'connected');
    expect(sessions[1]!.events[0]).toMatchObject({ type: 'hello', available: false });
  });

  it('does not reconnect and evict the newer session after a duplicate identity error', async () => {
    const { client, sessions } = await lounge();
    sessions[0]!.socket.send(JSON.stringify({ type: 'error', code: 'duplicate_session', message: 'Connected elsewhere.' }));
    sessions[0]!.socket.close(1000);
    await eventually(() => client.getSnapshot().connection === 'error');
    await new Promise(resolve => setTimeout(resolve, 1350));
    expect(sessions).toHaveLength(1);
    expect(client.getSnapshot().error).toBe('Connected elsewhere.');
  });

  it.each([
    ['operator_disconnected', 'join'],
    ['operator_disconnected', 'next'],
    ['maintenance', 'join'],
    ['maintenance', 'next'],
  ] as const)('waits for manual %s recovery through /%s', async (code, action) => {
    const { client, sessions } = await lounge();
    sessions[0]!.socket.send(JSON.stringify({ type: 'error', code, message: 'The operator ended this session.' }));
    sessions[0]!.socket.send(JSON.stringify({ type: 'queued', since: Date.now(), position: 1 }));
    await eventually(() => client.getSnapshot().connection === 'error');
    expect(client.getSnapshot()).toMatchObject({ status: 'paused', roomId: undefined, typing: false });
    expect(client.getSnapshot().error).toContain('/join or /next');
    if (code === 'maintenance') expect(client.getSnapshot().error).toContain('When the lounge reopens');
    client.setAvailability(false);
    client.setAvailability(true);
    await new Promise(resolve => setTimeout(resolve, 1350));
    expect(sessions).toHaveLength(1);
    expect(client.send({ type: action, profile: { interests: ['rust'], language: 'en', mode: 'interests' } })).toBe(true);
    client.send({ type: action });
    await eventually(() => client.getSnapshot().status === 'queued');
    expect(sessions).toHaveLength(2);
    expect(sessions[1]!.events).toEqual([
      { type: 'hello', protocol: 1, token: 'a'.repeat(64), available: true, profile: { interests: ['rust'], language: 'en', mode: 'interests' } },
    ]);
  });

  it.each(['join', 'next'] as const)('reconnects an explicitly disconnected client with /%s', async action => {
    const { client, sessions } = await lounge();
    client.disconnect();
    await eventually(() => sessions[0]!.socket.readyState === 3);
    expect(client.send({ type: action })).toBe(true);
    await eventually(() => client.getSnapshot().status === 'queued');
    expect(sessions).toHaveLength(2);
    expect(sessions[1]!.events[0]).toMatchObject({ type: 'hello', available: true });
  });

  it('clears demo room state and pending replies when leaving or disconnecting', () => {
    vi.useFakeTimers();
    const client = new DemoClient();
    disposals.push(() => client.disconnect());
    client.connect();
    vi.advanceTimersByTime(1300);
    expect(client.getSnapshot().roomId).toBeTruthy();
    client.send({ type: 'message', id: 'a', text: 'Hello' });
    client.send({ type: 'leave' });
    const messageCount = client.getSnapshot().messages.length;
    vi.advanceTimersByTime(5000);
    expect(client.getSnapshot()).toMatchObject({ status: 'paused', peer: undefined, roomId: undefined, typing: false });
    expect(client.getSnapshot().messages).toHaveLength(messageCount);
    client.send({ type: 'join' });
    vi.advanceTimersByTime(1300);
    client.disconnect();
    expect(client.getSnapshot()).toMatchObject({ connection: 'disconnected', roomId: undefined, peer: undefined });
  });

  it('uses one durable identity for HTTP and WebSocket forms of the same server', () => {
    const config: LocalConfig = { identities: { 'wss://chat.example': 'f'.repeat(64) }, profile: { interests: [], language: 'en', mode: 'random' }, consent: false };
    expect(identityFor(config, 'https://chat.example')).toBe('f'.repeat(64));
    expect(identityFor(config, 'wss://chat.example/ws')).toBe('f'.repeat(64));
    expect(identityFor(config, 'http://localhost:8787')).toBe(identityFor(config, 'ws://localhost:8787/ws'));
    expect(identityFor(config, 'https://other.example')).not.toBe('f'.repeat(64));
  });
});
