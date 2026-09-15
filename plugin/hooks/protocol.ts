// Dependency-free wire types for the isolated Claude Mods runtime.
// A compile-time test checks these against src/shared/protocol.ts.
export type Profile = {
  interests: string[];
  language: string;
  mode: 'interests' | 'random';
};
export type ReportReason = 'spam' | 'harassment' | 'sexual' | 'hate' | 'other';
export type ClientEvent =
  | { type: 'hello'; protocol: 1; token: string; profile: Profile; available: boolean }
  | { type: 'join'; profile?: Profile }
  | { type: 'leave' }
  | { type: 'next'; profile?: Profile }
  | { type: 'message'; id: string; text: string; roomId?: string }
  | { type: 'typing'; active: boolean; roomId?: string }
  | { type: 'availability'; available: boolean; keepChat: boolean }
  | { type: 'block'; roomId?: string }
  | { type: 'report'; reason: ReportReason; roomId?: string }
  | { type: 'ping' };
export type Stats = { online: number; waiting: number; chatting: number };
export type Peer = { alias: string; interests: string[] };
export type ServerEvent =
  | { type: 'welcome'; sessionId: string; alias: string; stats: Stats }
  | { type: 'queued'; since: number; position: number }
  | { type: 'matched'; roomId: string; peer: Peer; sharedInterests: string[]; icebreaker: string; startedAt: number }
  | { type: 'message'; id: string; text: string; from: 'you' | 'peer'; at: number }
  | { type: 'typing'; active: boolean }
  | { type: 'peer_left'; reason: 'next' | 'left' | 'disconnected' | 'task_done' | 'blocked' }
  | { type: 'paused'; reason: string }
  | { type: 'task_status'; done: boolean }
  | { type: 'reported' }
  | { type: 'blocked' }
  | { type: 'stats'; stats: Stats }
  | { type: 'error'; code: string; message: string; retryAfterMs?: number }
  | { type: 'pong' };

export function cleanText(value: string, max = 2000): string {
  return value.replace(/\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
    .replace(/\r/g, '').slice(0, max);
}

export function profileInterests(value: string): string[] {
  return [...new Set(value.toLowerCase().split(',').map(tag => tag.trim())
    .filter(tag => /^[a-z0-9+#. -]{1,24}$/.test(tag)))].slice(0, 8);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid server event.');
  return value as Record<string, unknown>;
}
function string(value: unknown, limit = 2000): string {
  if (typeof value !== 'string' || value.length > limit) throw new Error('Invalid server text.');
  return cleanText(value, limit);
}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw new Error('Invalid server number.');
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Invalid server flag.');
  return value;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 8) throw new Error('Invalid server interests.');
  return value.map(v => string(v, 24));
}
function stats(value: unknown): Stats {
  const v = record(value);
  return { online: number(v.online), waiting: number(v.waiting), chatting: number(v.chatting) };
}
function oneOf<T extends string>(value: unknown, options: readonly T[]): T {
  if (typeof value !== 'string' || !options.includes(value as T)) throw new Error('Invalid server event value.');
  return value as T;
}

export function decodeServerEvent(value: unknown): ServerEvent {
  const e = record(value);
  switch (e.type) {
    case 'welcome': return { type: e.type, sessionId: string(e.sessionId, 128), alias: string(e.alias, 40), stats: stats(e.stats) };
    case 'stats': return { type: e.type, stats: stats(e.stats) };
    case 'queued': return { type: e.type, since: number(e.since), position: number(e.position) };
    case 'matched': {
      const peer = record(e.peer);
      return { type: e.type, roomId: string(e.roomId, 128), peer: { alias: string(peer.alias, 40), interests: strings(peer.interests) }, sharedInterests: strings(e.sharedInterests), icebreaker: string(e.icebreaker, 2000), startedAt: number(e.startedAt) };
    }
    case 'message': return { type: e.type, id: string(e.id, 128), text: string(e.text), from: oneOf(e.from, ['you', 'peer']), at: number(e.at) };
    case 'typing': return { type: e.type, active: boolean(e.active) };
    case 'peer_left': return { type: e.type, reason: oneOf(e.reason, ['next', 'left', 'disconnected', 'task_done', 'blocked']) };
    case 'paused': return { type: e.type, reason: string(e.reason, 1000) };
    case 'task_status': return { type: e.type, done: boolean(e.done) };
    case 'error': return { type: e.type, code: string(e.code, 100), message: string(e.message, 2000), ...(e.retryAfterMs === undefined ? {} : { retryAfterMs: number(e.retryAfterMs) }) };
    case 'reported': case 'blocked': case 'pong': return { type: e.type };
    default: throw new Error('Unsupported server event. Check that the client and server versions match.');
  }
}
