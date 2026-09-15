// Narrow adapter declarations for the Claude Code Mods methods this plugin uses.
// Signatures checked against Anthropic's published 2.1.271 declarations.
// See docs/claude-integration.md for the exact source and compatibility check.
declare module 'claude-code' {
  export type RenderElement = { type: string; props: Record<string, unknown>; children?: unknown[] };
  type Styled = {
    children?: RenderElement | string | readonly RenderElement[];
    flexDirection?: 'row' | 'column'; gap?: number; paddingX?: number; marginTop?: number;
    borderStyle?: 'round'; borderColor?: string; width?: number;
    color?: string; bold?: boolean; dimColor?: boolean;
  };
  type ButtonProps = { key?: string; label?: string; onPress: () => void; autoFocus?: true };
  type InputProps = {
    key: string; label?: string; placeholder?: string; value?: string;
    submitLabel?: string; autoFocus?: true;
    onInput?: (value: string) => void; onSubmit: (value: string) => void;
  };
  export type Elements = { terminal: {
    Box(props: Styled): RenderElement;
    Text(props: Styled): RenderElement;
    Button(props: ButtonProps): RenderElement;
    Input(props: InputProps): RenderElement;
  } };
  interface Events {
    'session.start': { isInteractive: boolean; surface: string };
    'command.run': { command: string };
    'turn.start': { turnId: string };
    'turn.complete': { turnId: string; agentId?: string };
    'ui.render': { component: 'Pane'; requestId: string; surface: string; props: { bodyColumns: number; scroll: { bodyRows: number } } };
    'ui.close': { id: string };
    'classic.SessionEnd': Record<string, unknown>;
  }
  interface Engine {
    env: { get(key: string): Promise<string | undefined> };
    http: { fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; ok: boolean; text: string }> };
    store: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };
    clock: { now(): Promise<number>; every(ms: number, fn: () => void): { cancel(): void } };
    ui: {
      invalidate(event: 'ui.render'): void;
      status(text: string | undefined): void;
      toast(text: string): void;
      log(text: string): void;
      open(pane: { id: string; title: string; rows: number; focus?: true }): Promise<void>;
      close(pane: { id: string }): Promise<void>;
      resolve(event: Events['ui.render']): Elements['terminal'];
    };
    command: { register(spec: { name: string; description: string; immediate?: true }): Promise<unknown> };
  }
  type Hook<E extends keyof Events> = ($: Engine, event: Events[E], next: (event: Events[E]) => unknown) => unknown;
  global {
    var crypto: { randomUUID(): string };
    var URL: { new(input: string, base?: string): { searchParams: { get(key: string): string | null }; protocol: string; hostname: string; username: string; password: string; search: string; hash: string; pathname: string; toString(): string } };
  }
  export interface On {
    <E extends keyof Events>(event: E, hook: Hook<E>): void;
    <E extends keyof Events>(event: E, matcher: Partial<Events[E]>, hook: Hook<E>): void;
  }
}
