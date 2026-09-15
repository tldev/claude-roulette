import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { once } from 'node:events';
import { RouletteClient, websocketUrl } from '../src/client/client.js';
import { identityFor, loadConfig, saveConfig } from '../src/client/config.js';
import { safeText, type ServerEvent } from '../src/shared/protocol.js';

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(fn => fn()); });
async function eventually(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Condition did not become true');
}
describe('client boundaries', () => {
  it('accepts localhost and TLS endpoints, rejects remote plaintext and credentials', () => {
    expect(websocketUrl('http://localhost:8787')).toBe('ws://localhost:8787/ws');
    expect(websocketUrl('https://chat.example/lounge')).toBe('wss://chat.example/lounge/ws');
    expect(() => websocketUrl('http://chat.example')).toThrow('HTTPS');
    expect(() => websocketUrl('https://secret@chat.example')).toThrow('credentials');
    expect(() => websocketUrl('file:///etc/passwd')).toThrow('Server URL');
  });
  it('keeps a private persistent identity per server and does not replace unreadable config', () => {
    const directory = mkdtempSync(join(tmpdir(), 'roulette-config-')); cleanups.push(() => rmSync(directory, { recursive: true }));
    const config = loadConfig(directory);
    const token = identityFor(config, 'https://one.example');
    expect(identityFor(config, 'https://two.example')).not.toBe(token);
    saveConfig(config, directory);
    expect(identityFor(loadConfig(directory), 'https://one.example')).toBe(token);
    expect(statSync(join(directory, 'config.json')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(directory, 'config.json'), 'utf8')).toContain(token);
    writeFileSync(join(directory, 'config.json'), '{bad');
    expect(() => loadConfig(directory)).toThrow('has not been replaced');
  });
  it('strips terminal injection and invisible direction overrides', () => {
    expect(safeText('\u001b[31mhello\u001b[0m\u0007\u202eevil')).toBe('helloevil');
    expect(safeText('\u001b]52;c;dGVzdA==\u0007visible')).toBe('visible');
  });
  it('authenticates, deduplicates messages, and sends current preferences on next', async () => {
    const server = new WebSocketServer({ port: 0 }); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Unexpected address');
    const received: Record<string, unknown>[] = [];
    server.on('connection', ws => {
      ws.on('message', raw => {
        const event = JSON.parse(raw.toString()); received.push(event);
        if (event.type === 'hello') {
          const events: ServerEvent[] = [
            { type: 'welcome', sessionId: 'test', alias: 'Bright Owl', stats: { online: 2, waiting: 0, chatting: 2 } },
            { type: 'matched', roomId: 'room', peer: { alias: 'Velvet Fox', interests: [] }, sharedInterests: [], icebreaker: 'Hello?', startedAt: Date.now() },
            { type: 'message', id: 'same', text: '\u001b[31mHello', from: 'peer', at: Date.now() },
            { type: 'message', id: 'same', text: 'Hello', from: 'peer', at: Date.now() },
          ];
          events.forEach(e => ws.send(JSON.stringify(e)));
        }
      });
    });
    const client = new RouletteClient({ url: `http://localhost:${address.port}`, token: 'a'.repeat(64), profile: { interests: [], mode: 'random', language: 'en' } });
    cleanups.push(() => { client.disconnect(); server.clients.forEach(ws => ws.terminate()); server.close(); });
    client.connect();
    await eventually(() => client.getSnapshot().messages.length === 1);
    expect(client.getSnapshot().messages[0]?.text).toBe('Hello');
    expect(received[0]).toMatchObject({ type: 'hello', token: 'a'.repeat(64) });
    client.setProfile({ interests: ['rust'], mode: 'interests', language: 'en' });
    client.send({ type: 'next' });
    await eventually(() => received.some(e => e.type === 'next'));
    expect(received.find(e => e.type === 'next')).toMatchObject({ profile: { interests: ['rust'] } });
  });
});
