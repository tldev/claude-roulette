import { describe, expect, it, vi } from 'vitest';
import { register } from '../hooks/register';
import type { On } from 'claude-code';

type Handler = (host: unknown, event: Record<string, unknown>, next: (event: unknown) => unknown) => unknown;

function hooks() {
  const callbacks = new Map<string, Handler>();
  const on = ((event: string, ...args: unknown[]) => { callbacks.set(event, args.at(-1) as Handler); }) as On;
  register(on);
  const element = (type: string) => (props: Record<string, unknown>) => ({ type, props, children: props.children });
  const fetch = vi.fn(async () => ({ ok: true, status: 200, text: '{"token":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","sessionId":"session"}' }));
  const host = {
    env: { get: async () => 'http://127.0.0.1:8787' },
    http: { fetch }, store: { get: async () => undefined, set: async () => {} },
    clock: { now: async () => 0, every: () => ({ cancel: () => {} }) },
    ui: {
      invalidate: vi.fn(), status: vi.fn(), toast: vi.fn(), log: vi.fn(), open: vi.fn(async () => {}), close: vi.fn(async () => {}),
      resolve: () => ({ Box: element('Box'), Text: element('Text'), Input: element('Input'), Button: element('Button') }),
    },
    command: { register: vi.fn(async () => {}) },
  };
  return { callbacks, host, fetch };
}

function acceptIn(tree: unknown): (() => void) | undefined {
  if (!tree || typeof tree !== 'object') return;
  const t = tree as { props?: { key?: string; onPress?: () => void }; children?: unknown };
  if (t.props?.key === 'accept') return t.props.onPress;
  for (const child of Array.isArray(t.children) ? t.children : [t.children]) {
    const accept = acceptIn(child);
    if (accept) return accept;
  }
}

describe('actual register adapter', () => {
  it('registers an immediate command and leaves lifecycle payloads untouched', async () => {
    const f = hooks();
    const next = vi.fn((event: unknown) => event);
    await f.callbacks.get('session.start')!(f.host, { surface: 'terminal', isInteractive: true }, next);
    expect(f.host.command.register).toHaveBeenCalledWith(expect.objectContaining({ name: 'roulette', immediate: true }));
    const pane = f.callbacks.get('ui.render')!(f.host, { component: 'Pane', requestId: 'claude-roulette', surface: 'terminal', props: { bodyColumns: 120, scroll: { bodyRows: 40 } } }, next);
    expect(acceptIn(pane)).toBeTypeOf('function');
    acceptIn(pane)!();
    const event = { turnId: 'task', text: 'PRIVATE PROMPT NEVER SENT TO CHAT' };
    const result = f.callbacks.get('turn.start')!(f.host, event, next);
    expect(result).toBe(event);
    expect(next).toHaveBeenLastCalledWith(event);
    await Promise.resolve();
    const serialized = JSON.stringify(f.fetch.mock.calls);
    expect(serialized).not.toContain('PRIVATE PROMPT');
    expect(serialized).not.toContain('task');
  });

  it('never exposes model or tool capabilities and ignores unrelated panes', async () => {
    const f = hooks();
    const next = vi.fn(() => 'core');
    await f.callbacks.get('session.start')!(f.host, { surface: 'terminal', isInteractive: true }, next);
    expect(f.callbacks.has('prompt.submit')).toBe(false);
    expect(f.callbacks.has('tool.call')).toBe(false);
    expect(f.callbacks.get('ui.render')!(f.host, { requestId: 'other-pane' }, next)).toBe('core');
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('does not initialize the interactive chat in headless sessions', async () => {
    const f = hooks();
    const next = vi.fn(() => 'ok');
    expect(await f.callbacks.get('session.start')!(f.host, { surface: 'terminal', isInteractive: false }, next)).toBe('ok');
    expect(f.host.command.register).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });
});
