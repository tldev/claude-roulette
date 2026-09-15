import { PassThrough, Writable } from 'node:stream';
import { Chalk } from 'chalk';
import { describe, expect, it, vi } from 'vitest';
import { detectTerminalTheme, palettes, parseOscBackground, parseThemeMode, queryTerminalBackground, themeFromColorFgBg, type ThemeDetectionOptions } from '../src/tui/theme.js';

function contrast(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const [red, green, blue] = hex.slice(1).match(/../g)!.map(value => parseInt(value, 16) / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
  };
  const values = [luminance(foreground), luminance(background)].sort((left, right) => left - right);
  return (values[1]! + 0.05) / (values[0]! + 0.05);
}

function ansi256Color(color: string): string {
  const emitted = new Chalk({ level: 2 }).hex(color)('sample');
  const index = Number(emitted.match(/\u001b\[38;5;(\d+)m/)?.[1]);
  expect(index).toBeGreaterThanOrEqual(16);
  expect(index).toBeLessThanOrEqual(255);
  const levels = [0, 95, 135, 175, 215, 255];
  const rgb = index >= 232
    ? Array<number>(3).fill(8 + (index - 232) * 10)
    : [Math.floor((index - 16) / 36), Math.floor((index - 16) % 36 / 6), (index - 16) % 6].map(channel => levels[channel]!);
  return `#${rgb.map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
}

function terminal(reply?: (input: NodeJS.ReadStream) => void) {
  const input = new PassThrough() as unknown as NodeJS.ReadStream;
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = vi.fn((mode: boolean) => { input.isRaw = mode; return input; });
  const requests: string[] = [];
  const output = new Writable({ write(chunk, _encoding, done) {
    requests.push(String(chunk));
    done();
    reply?.(input);
  } }) as unknown as NodeJS.WriteStream;
  output.isTTY = true;
  return { input, output, requests, env: {}, timeoutMs: 10 } satisfies ThemeDetectionOptions & { requests: string[] };
}

describe('terminal palettes', () => {
  it.each(['light', 'dark'] as const)('keeps text and borders readable in the %s theme', theme => {
    const background = theme === 'light' ? '#FFFFFF' : '#181A16';
    for (const [role, color] of Object.entries(palettes[theme])) {
      expect(contrast(color, background), `${theme} ${role}`).toBeGreaterThanOrEqual(role === 'border' ? 3 : 4.5);
    }
  });

  it.each(['light', 'dark'] as const)('keeps the rendered %s palette readable in ANSI256 terminals', theme => {
    const background = theme === 'light' ? '#FFFFFF' : '#181A16';
    for (const [role, color] of Object.entries(palettes[theme])) {
      const rendered = ansi256Color(color);
      expect(contrast(rendered, background), `${theme} ${role} rendered as ${rendered}`).toBeGreaterThanOrEqual(role === 'border' ? 3 : 4.5);
    }
  });

  it('accepts only supported theme preferences', () => {
    expect(['auto', 'light', 'dark'].map(parseThemeMode)).toEqual(['auto', 'light', 'dark']);
    expect(parseThemeMode('blue')).toBeUndefined();
    expect(parseThemeMode({ light: true })).toBeUndefined();
  });
});

describe('terminal background detection', () => {
  it('recognizes neutral COLORFGBG backgrounds and ignores ambiguous colors', () => {
    expect(themeFromColorFgBg('0;15')).toBe('light');
    expect(themeFromColorFgBg('0;default;7')).toBe('light');
    expect(themeFromColorFgBg('15;0')).toBe('dark');
    expect(themeFromColorFgBg('15;8')).toBe('dark');
    expect(themeFromColorFgBg('0;255')).toBe('light');
    expect(themeFromColorFgBg('15;232')).toBe('dark');
    expect(themeFromColorFgBg('0;3')).toBeUndefined();
    expect(themeFromColorFgBg('black;white')).toBeUndefined();
    expect(themeFromColorFgBg('15')).toBeUndefined();
  });

  it('parses OSC 11 RGB replies with both terminal terminators and channel precisions', () => {
    expect(parseOscBackground('\u001b]11;rgb:ffff/ffff/ffff\u0007')).toBe('light');
    expect(parseOscBackground('\u001b]11;rgb:18/1a/16\u001b\\')).toBe('dark');
    expect(parseOscBackground('\u001b]11;rgb:f/f/f\u0007')).toBe('light');
    expect(parseOscBackground('\u001b]10;rgb:ffff/ffff/ffff\u0007')).toBeUndefined();
    expect(parseOscBackground('\u001b]11;rgb:gg/ff/ff\u0007')).toBeUndefined();
    expect(parseOscBackground('\u001b]11;rgb:ff/ff/ff')).toBeUndefined();
  });

  it('restores raw mode and preserves typed input around a fragmented reply', async () => {
    const io = terminal(input => {
      input.emit('data', Buffer.from('hé\u001b]11;rgb:ffff/'));
      input.emit('data', Buffer.from('ffff/ffff\u001b\\llo'));
    });
    expect(await queryTerminalBackground(io)).toBe('light');
    expect(io.requests).toEqual(['\u001b]11;?\u0007']);
    expect(io.input.isRaw).toBe(false);
    expect(io.input.readableFlowing).toBe(false);
    expect(io.input.listenerCount('data')).toBe(0);
    expect(io.input.listenerCount('error')).toBe(0);
    expect(io.input.listenerCount('end')).toBe(0);
    expect(io.input.read()?.toString()).toBe('héllo');
  });

  it('preserves a terminal that was already raw and flowing', async () => {
    const io = terminal(input => input.emit('data', Buffer.from('\u001b]11;rgb:00/00/00\u0007')));
    io.input.isRaw = true;
    io.input.resume();
    expect(await queryTerminalBackground(io)).toBe('dark');
    expect(io.input.isRaw).toBe(true);
    expect(io.input.readableFlowing).toBe(true);
    io.input.pause();
  });

  it('times out without losing input or keeping the terminal raw', async () => {
    const io = terminal(input => input.emit('data', Buffer.from('hello')));
    expect(await queryTerminalBackground(io)).toBeUndefined();
    expect(io.input.isRaw).toBe(false);
    expect(io.input.listenerCount('data')).toBe(0);
    expect(io.input.read()?.toString()).toBe('hello');
  });

  it('does not query redirected input, output, or a dumb terminal', async () => {
    for (const direction of ['input', 'output'] as const) {
      const io = terminal();
      io[direction].isTTY = false;
      expect(await queryTerminalBackground(io)).toBeUndefined();
      expect(io.requests).toEqual([]);
    }
    const io = terminal();
    expect(await queryTerminalBackground({ ...io, env: { TERM: 'dumb' } })).toBeUndefined();
    expect(io.requests).toEqual([]);
  });

  it('leaves existing input consumers and raw mode untouched', async () => {
    for (const event of ['data', 'readable']) {
      const io = terminal();
      const consumer = vi.fn();
      io.input.on(event, consumer);
      expect(await queryTerminalBackground(io)).toBeUndefined();
      expect(io.requests).toEqual([]);
      expect(io.input.setRawMode).not.toHaveBeenCalled();
      expect(io.input.listeners(event)).toContain(consumer);
      io.input.removeListener(event, consumer);
    }
  });

  it('cleans up unsupported replies and restores the terminal after an error', async () => {
    const unsupported = terminal(input => input.emit('data', Buffer.from('\u001b]11;unknown\u0007')));
    expect(await queryTerminalBackground(unsupported)).toBeUndefined();
    expect(unsupported.input.read()).toBeNull();
    const failed = terminal(input => input.emit('error', new Error('terminal closed')));
    expect(await queryTerminalBackground(failed)).toBeUndefined();
    expect(failed.input.isRaw).toBe(false);
    expect(failed.input.listenerCount('error')).toBe(0);
  });

  it('restores the terminal when the background query cannot be written', async () => {
    const io = terminal();
    const output = new Writable({ write(_chunk, _encoding, done) { done(new Error('output closed')); } }) as unknown as NodeJS.WriteStream;
    output.isTTY = true;
    expect(await queryTerminalBackground({ ...io, output })).toBeUndefined();
    expect(io.input.isRaw).toBe(false);
    expect(io.input.listenerCount('data')).toBe(0);
    expect(output.listenerCount('error')).toBe(0);
  });

  it('prefers the actual background, then environment hints, then a dark fallback', async () => {
    const io = terminal(input => input.emit('data', Buffer.from('\u001b]11;rgb:ffff/ffff/ffff\u0007')));
    expect(await detectTerminalTheme({ ...io, env: { COLORFGBG: '15;0' } })).toBe('light');
    expect(await detectTerminalTheme({ ...terminal(), env: { COLORFGBG: '0;15' } })).toBe('light');
    expect(await detectTerminalTheme(terminal())).toBe('dark');
  });
});
