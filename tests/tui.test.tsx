import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import type { ClientSnapshot } from '../src/client/client.js';
import type { ClientEvent, Profile } from '../src/shared/protocol.js';
import { App, executeCommand, type TuiClient } from '../src/tui/app.js';
import { ConsentView, RouletteView, transcriptLines } from '../src/tui/view.js';
import { displayWidth, parseInterests, wrap } from '../src/tui/helpers.js';

const now = new Date('2026-09-15T12:05:00Z').getTime();
function snapshot(overrides: Partial<ClientSnapshot> = {}): ClientSnapshot {
  return {
    connection: 'connected', status: 'chatting', alias: 'Cosmic Otter',
    stats: { online: 128, waiting: 16, chatting: 112 },
    profile: { interests: ['typescript', 'side projects', 'coffee'], language: 'en', mode: 'interests' },
    available: true, keepChat: false, roomId: 'test-room',
    peer: { alias: 'Velvet Badger', interests: ['typescript', 'music'] },
    sharedInterests: ['typescript'], icebreaker: 'What tiny project became your biggest rabbit hole?',
    matchedAt: now - 72000, typing: false,
    messages: [
      { id: '1', text: 'hey! what are you building while your robot does the hard part?', from: 'peer', at: now - 60000 },
      { id: '2', text: 'a little place for serendipity. you?', from: 'you', at: now - 40000 },
      { id: '3', text: 'A music app. It has been almost done for about six months.', from: 'peer', at: now - 10000 },
    ], ...overrides,
  };
}

class FakeClient implements TuiClient {
  state = snapshot();
  listeners = new Set<() => void>();
  events: ClientEvent[] = [];
  connect = vi.fn();
  disconnect = vi.fn();
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  send = vi.fn((event: ClientEvent) => { this.events.push(event); return true; });
  patch = (change: Partial<ClientSnapshot>) => { this.state = { ...this.state, ...change }; this.listeners.forEach(listener => listener()); };
  setProfile = vi.fn((profile: Profile) => this.patch({ profile }));
  setAvailability = vi.fn((available: boolean, keepChat = false) => this.patch({ available, keepChat }));
  addNotice = vi.fn((notice: string) => this.patch({ notice }));
}

const tick = () => new Promise(resolve => setTimeout(resolve, 35));
afterEach(cleanup);

describe('terminal experience', () => {
  it('shows a polished two-column conversation with explicit demo labeling', () => {
    const app = render(<RouletteView snapshot={snapshot()} now={now} width={108} height={36} demo />);
    const frame = app.lastFrame() ?? '';
    expect(frame).toContain('SIMULATED CHAT');
    expect(frame).toContain('THE WAITING ROOM');
    expect(frame).toContain('Velvet Badger');
    expect(frame).toContain('What tiny project became your biggest rabbit hole?');
    expect(frame).toContain('You both like #typescript');
    expect(frame).toContain('a little place for serendipity');
    expect(frame).toContain('Your code stays yours.');
    expect(frame.split('\n').every(line => displayWidth(line) <= 108)).toBe(true);
  });

  it('adapts to narrow terminals and shows task completion', () => {
    const app = render(<RouletteView snapshot={snapshot({ available: false, keepChat: true })} now={now} width={64} height={32} />);
    const frame = app.lastFrame() ?? '';
    expect(frame).toContain('CLAUDE FINISHED');
    expect(frame).not.toContain('THE WAITING ROOM');
    expect(frame.split('\n').every(line => displayWidth(line) <= 64)).toBe(true);
  });

  it('fits the default 80 by 24 terminal and keeps consent compact', () => {
    const consent = render(<ConsentView width={80} height={24} />).lastFrame() ?? '';
    expect(consent.split('\n').length).toBeLessThanOrEqual(24);
    expect(consent).toContain('Enter: I am 18+ and agree');
    const frame = render(<RouletteView snapshot={snapshot()} now={now} width={80} height={24} />).lastFrame() ?? '';
    expect(frame.split('\n').length).toBeLessThanOrEqual(24);
    expect(frame).toContain('Enter send');
  });

  it('keeps the queue animation visible after notices or a prior room', () => {
    const app = render(<RouletteView snapshot={snapshot({ status: 'queued', queuedAt: now - 5000 })} now={now} width={108} height={36} />);
    expect(app.lastFrame()).toContain('Somewhere, someone else is waiting.');
    expect(app.lastFrame()).toContain('00:05 elapsed');
  });

  it('does not connect or send chat before an adult accepts the rules', async () => {
    const client = new FakeClient();
    const app = render(<App client={client} />);
    await tick();
    expect(app.lastFrame()).toContain('18 and older');
    app.stdin.write('hello');
    await tick();
    expect(client.connect).not.toHaveBeenCalled();
    expect(client.send).not.toHaveBeenCalled();
    app.stdin.write('\r');
    await tick();
    expect(client.connect).toHaveBeenCalledTimes(1);
    app.unmount();
    expect(client.disconnect).toHaveBeenCalled();
  });

  it('sends ordinary text only to the chat client and keeps slash commands local', async () => {
    const client = new FakeClient();
    const app = render(<App client={client} initialConsent />);
    await tick();
    app.stdin.write('hello stranger');
    await tick();
    app.stdin.write('\r');
    await tick();
    expect(client.events).toContainEqual(expect.objectContaining({ type: 'message', text: 'hello stranger' }));
    app.stdin.write('/done');
    await tick();
    app.stdin.write('\r');
    await tick();
    expect(client.setAvailability).toHaveBeenCalledWith(false, false);
    expect(client.events.filter(event => event.type === 'message')).toHaveLength(1);
  });

  it('changes terminal theme without interrupting the conversation or sending it to the peer', async () => {
    const client = new FakeClient();
    const onThemeChange = vi.fn();
    const app = render(<App client={client} initialConsent initialTheme="dark" onThemeChange={onThemeChange} />);
    await tick();
    app.stdin.write('/theme light');
    await tick();
    app.stdin.write('\r');
    await tick();
    expect(onThemeChange).toHaveBeenLastCalledWith('light');
    expect(app.lastFrame()).toContain('Terminal theme: light.');
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.disconnect).not.toHaveBeenCalled();
    expect(client.events).toHaveLength(0);
    expect(client.state.status).toBe('chatting');
    app.stdin.write('/theme neon');
    await tick();
    app.stdin.write('\r');
    await tick();
    expect(onThemeChange).toHaveBeenCalledTimes(1);
    expect(app.lastFrame()).toContain('Use /theme light');
  });

  it('strips terminal controls in stranger messages and bounds wrapped lines', () => {
    const lines = transcriptLines(snapshot({ messages: [{ id: 'x', text: '\u001b[2JDo not run \u202Eevil\u0007\n你好 there', from: 'peer', at: now }] }), 12);
    expect(lines.map(line => line.text).join('\n')).not.toMatch(/[\u001b\u202e\u0007]/);
    expect(lines.every(line => displayWidth(line.text) <= 12)).toBe(true);
    expect(wrap('界界界 hello', 5).every(line => displayWidth(line) <= 5)).toBe(true);
  });
});

describe('lounge commands', () => {
  const actions = () => ({ exit: vi.fn(), toggleHelp: vi.fn() });
  it('normalizes and validates interest preferences without changing chat content', () => {
    const client = new FakeClient();
    executeCommand(client, '/interests Rust, Coffee, rust', actions());
    expect(client.state.profile.interests).toEqual(['rust', 'coffee']);
    executeCommand(client, '/language english', actions());
    expect(client.state.profile.language).toBe('en');
    expect(client.addNotice).toHaveBeenLastCalledWith(expect.stringContaining('two-letter'));
    expect(parseInterests('a, a, , B')).toEqual(['a', 'b']);
  });

  it('offers actionable report reasons and sends only an allowed report', () => {
    const client = new FakeClient();
    executeCommand(client, '/report', actions());
    expect(client.events).toHaveLength(0);
    expect(client.addNotice).toHaveBeenLastCalledWith(expect.stringContaining('/report spam'));
    executeCommand(client, '/report harassment', actions());
    expect(client.events).toEqual([{ type: 'report', reason: 'harassment' }]);
  });

  it('preserves a working task when the user enables stay mode', () => {
    const client = new FakeClient();
    executeCommand(client, '/stay', actions());
    expect(client.setAvailability).toHaveBeenLastCalledWith(true, true);
    executeCommand(client, '/done', actions());
    expect(client.setAvailability).toHaveBeenLastCalledWith(false, true);
    executeCommand(client, '/working', actions());
    expect(client.setAvailability).toHaveBeenLastCalledWith(true, false);
  });
});
