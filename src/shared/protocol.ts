import { z } from 'zod';

export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_LENGTH = 2000;
export const ProfileSchema = z.object({
  interests: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9+#. -]{1,24}$/)).max(8).default([]),
  language: z.string().regex(/^[a-z]{2}$/).default('en'),
  mode: z.enum(['interests', 'random']).default('interests'),
});
export type Profile = z.infer<typeof ProfileSchema>;
export const ReportReasonSchema = z.enum(['spam', 'harassment', 'sexual', 'hate', 'other']);
export type ReportReason = z.infer<typeof ReportReasonSchema>;

export const ClientEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), protocol: z.literal(PROTOCOL_VERSION), token: z.string().regex(/^[a-f0-9]{64}$/), profile: ProfileSchema, available: z.boolean() }),
  z.object({ type: z.literal('join'), profile: ProfileSchema.optional() }),
  z.object({ type: z.literal('leave') }),
  z.object({ type: z.literal('next'), profile: ProfileSchema.optional() }),
  z.object({ type: z.literal('message'), id: z.string().uuid(), text: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH), roomId: z.string().uuid().optional() }),
  z.object({ type: z.literal('typing'), active: z.boolean(), roomId: z.string().uuid().optional() }),
  z.object({ type: z.literal('availability'), available: z.boolean(), keepChat: z.boolean().default(false) }),
  z.object({ type: z.literal('block'), roomId: z.string().uuid().optional() }),
  z.object({ type: z.literal('report'), reason: ReportReasonSchema, roomId: z.string().uuid().optional() }),
  z.object({ type: z.literal('ping') }),
]);
export type ClientEvent = z.infer<typeof ClientEventSchema>;
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

const StatsSchema = z.object({ online: z.number().nonnegative(), waiting: z.number().nonnegative(), chatting: z.number().nonnegative() });
export const ServerEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('welcome'), sessionId: z.string(), alias: z.string(), stats: StatsSchema }),
  z.object({ type: z.literal('queued'), since: z.number(), position: z.number() }),
  z.object({ type: z.literal('matched'), roomId: z.string(), peer: z.object({ alias: z.string(), interests: z.array(z.string()).max(8) }), sharedInterests: z.array(z.string()).max(8), icebreaker: z.string(), startedAt: z.number() }),
  z.object({ type: z.literal('message'), id: z.string(), text: z.string().max(MAX_MESSAGE_LENGTH), from: z.enum(['you', 'peer']), at: z.number() }),
  z.object({ type: z.literal('typing'), active: z.boolean() }),
  z.object({ type: z.literal('peer_left'), reason: z.enum(['next', 'left', 'disconnected', 'task_done', 'blocked']) }),
  z.object({ type: z.literal('paused'), reason: z.string() }),
  z.object({ type: z.literal('task_status'), done: z.boolean() }),
  z.object({ type: z.literal('reported') }),
  z.object({ type: z.literal('blocked') }),
  z.object({ type: z.literal('stats'), stats: StatsSchema }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string(), retryAfterMs: z.number().optional() }),
  z.object({ type: z.literal('pong') }),
]);

// Strip terminal controls, bidirectional overrides, and other invisible format controls.
// Untrusted text must never become terminal escape sequences or Claude input.
export function safeText(value: string, max = MAX_MESSAGE_LENGTH): string {
  return value.replace(/\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
    .replace(/\r/g, '').slice(0, max);
}
