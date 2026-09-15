import type { ClientEvent, Peer, Profile, ReportReason, ServerEvent, Stats } from './protocol';
import { cleanText, decodeServerEvent, profileInterests } from './protocol';

export interface Host {
  fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ ok: boolean; status: number; text: string }>;
  storeGet(key: string): Promise<unknown>;
  storeSet(key: string, value: unknown): Promise<void>;
  now(): Promise<number>;
  every(ms: number, fn: () => void): { cancel(): void };
  invalidate(): void;
  status(text: string | undefined): void;
  toast(text: string): void;
  open(focus: boolean): Promise<void>;
  close(): Promise<void>;
}

export type Phase = 'off' | 'ready' | 'connecting' | 'queued' | 'chatting' | 'paused' | 'reconnecting';
export type ChatLine = { id: string; text: string; who: 'you' | 'peer' | 'system'; at: number };
export type Model = {
  enabled: boolean; busy: boolean; phase: Phase; alias: string; peer: Peer | null; roomId: string | null;
  stats: Stats; profile: Profile; lines: ChatLine[]; sharedInterests: string[];
  icebreaker: string; draft: string; notice: string; error: string; keepChat: boolean;
  peerTyping: boolean; showSettings: boolean; showReport: boolean; scroll: number;
  now: number; queuedAt: number; startedAt: number; frame: number; confirmedRules: boolean;
};

const INITIAL_PROFILE: Profile = { interests: [], language: 'en', mode: 'interests' };

export class RouletteController {
  readonly model: Model = {
    enabled: false, busy: false, phase: 'off', alias: 'You', peer: null, roomId: null,
    stats: { online: 0, waiting: 0, chatting: 0 }, profile: { ...INITIAL_PROFILE },
    lines: [], sharedInterests: [], icebreaker: '', draft: '', notice: '', error: '',
    keepChat: false, peerTyping: false, showSettings: false, showReport: false,
    scroll: 0, now: 0, queuedAt: 0, startedAt: 0, frame: 0, confirmedRules: false,
  };
  private token = '';
  private cursor = 0;
  private sessionId = '';
  private session = false;
  private fetching = false;
  private connecting = false;
  private timer: { cancel(): void } | undefined;
  private generation = 0;
  private retryAt = 0;
  private retryDelay = 1000;
  private typingAt = 0;
  private busyTurn: string | null = null;
  private pausedByUser = false;
  private paneOpen = false;
  private tokenKey: string;
  private sendChain: Promise<void> = Promise.resolve();

  constructor(private readonly host: Host, private readonly server: string) {
    this.tokenKey = `roulette.identity.${server}`;
  }

  async load(): Promise<void> {
    const [token, profile] = await Promise.all([
      this.host.storeGet(this.tokenKey).catch(() => undefined),
      this.host.storeGet('roulette.profile').catch(() => undefined),
    ]);
    if (typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)) this.token = token;
    if (profile && typeof profile === 'object') {
      const p = profile as Partial<Profile>;
      this.model.profile = {
        interests: Array.isArray(p.interests) ? profileInterests(p.interests.filter(v => typeof v === 'string').join(',')) : [],
        language: typeof p.language === 'string' && /^[a-z]{2}$/.test(p.language) ? p.language : 'en',
        mode: p.mode === 'random' ? 'random' : 'interests',
      };
    }
  }

  async open(): Promise<void> {
    this.paneOpen = true;
    await this.host.open(true);
    this.redraw();
  }

  closed(): void { this.paneOpen = false; }

  activate(): void {
    this.model.enabled = true;
    this.model.confirmedRules = true;
    this.pausedByUser = false;
    this.model.error = '';
    this.model.phase = this.model.busy ? 'connecting' : 'ready';
    this.model.notice = this.model.busy ? 'Finding another human...' : 'Ready for your next Claude task.';
    this.startTimer();
    if (this.model.busy) void this.connect();
    this.redraw();
  }

  setBusy(turnId: string): void {
    this.busyTurn = turnId;
    this.model.busy = true;
    this.model.notice = '';
    if (!this.model.enabled || this.pausedByUser) { this.redraw(); return; }
    if (this.session) this.enqueue({ type: 'availability', available: true, keepChat: this.model.keepChat });
    else void this.connect();
    if (!this.paneOpen) {
      this.paneOpen = true;
      void this.host.open(false).catch(() => { this.paneOpen = false; });
    }
    this.redraw();
  }

  complete(turnId: string, agentId?: string): void {
    if (agentId || this.busyTurn !== turnId) return;
    this.busyTurn = null;
    this.model.busy = false;
    if (this.session) this.enqueue({ type: 'availability', available: false, keepChat: this.model.keepChat });
    if (!this.model.keepChat || this.model.phase !== 'chatting') {
      this.model.phase = this.model.enabled ? 'ready' : 'off';
      this.model.peerTyping = false;
      this.model.roomId = null;
    }
    this.model.notice = this.model.keepChat && this.model.peer ? 'Claude finished. Your conversation can continue.' : 'Claude finished. Matching resumes with your next task.';
    if (this.model.enabled) this.host.toast('Claude finished. Your task is ready.');
    this.redraw();
  }

  next(): void {
    if (!this.model.busy) { this.model.error = 'Start another Claude task to find a new person.'; this.redraw(); return; }
    this.model.showReport = false;
    this.model.roomId = null;
    this.model.draft = '';
    this.model.scroll = 0;
    this.pausedByUser = false;
    if (this.session) this.enqueue({ type: 'next', profile: this.model.profile });
    else { this.model.enabled = true; void this.connect(); }
    this.redraw();
  }

  pause(): void {
    this.pausedByUser = true;
    this.model.roomId = null;
    this.model.phase = 'paused';
    this.model.peerTyping = false;
    if (this.session) this.enqueue({ type: 'leave' });
    this.model.notice = 'Taking a breather. Join when you are ready.';
    this.redraw();
  }

  join(): void {
    if (!this.model.enabled) { this.activate(); return; }
    if (!this.model.busy) { this.model.notice = 'Matching starts when Claude starts your next task.'; this.redraw(); return; }
    this.pausedByUser = false;
    if (this.session) this.enqueue({ type: 'join', profile: this.model.profile });
    else void this.connect();
  }

  send(value: string): void {
    const text = cleanText(value).trim();
    if (!text || this.model.phase !== 'chatting') return;
    this.model.draft = '';
    this.model.scroll = 0;
    this.enqueue({ type: 'message', id: crypto.randomUUID(), text });
    this.enqueue({ type: 'typing', active: false });
    this.redraw();
  }

  draft(value: string): void {
    this.model.draft = cleanText(value);
    if (this.model.now - this.typingAt > 2000 && this.model.phase === 'chatting') {
      this.typingAt = this.model.now;
      this.enqueue({ type: 'typing', active: true });
    }
  }

  report(reason: ReportReason): void {
    this.model.showReport = false;
    this.enqueue({ type: 'report', reason });
    this.redraw();
  }

  block(): void {
    this.model.showReport = false;
    this.enqueue({ type: 'block' });
    this.redraw();
  }

  toggleKeepChat(): void {
    this.model.keepChat = !this.model.keepChat;
    if (!this.model.busy && !this.model.keepChat && this.session) {
      this.enqueue({ type: 'availability', available: false, keepChat: false });
    }
    this.redraw();
  }

  settings(): void { this.model.showSettings = !this.model.showSettings; this.redraw(); }
  reports(): void { this.model.showReport = !this.model.showReport; this.redraw(); }
  scroll(by: number): void { this.model.scroll = Math.max(0, Math.min(this.model.lines.length - 1, this.model.scroll + by)); this.redraw(); }

  setInterests(value: string): void {
    this.model.profile = { ...this.model.profile, interests: profileInterests(value) };
    this.profileChanged();
  }

  setLanguage(value: string): void {
    const language = value.trim().toLowerCase();
    if (!/^[a-z]{2}$/.test(language)) { this.model.error = 'Use a two-letter language code, such as en, es, or fr.'; this.redraw(); return; }
    this.model.profile = { ...this.model.profile, language };
    this.profileChanged();
  }

  toggleMode(): void {
    this.model.profile = { ...this.model.profile, mode: this.model.profile.mode === 'random' ? 'interests' : 'random' };
    this.profileChanged();
  }

  private profileChanged(): void {
    this.model.error = '';
    this.model.notice = 'Preferences saved. They apply to your next match.';
    void this.host.storeSet('roulette.profile', this.model.profile).catch(() => undefined);
    if (this.model.phase === 'queued') this.enqueue({ type: 'join', profile: this.model.profile });
    this.redraw();
  }

  async stop(): Promise<void> {
    this.generation += 1;
    this.timer?.cancel();
    this.timer = undefined;
    this.model.enabled = false;
    this.model.phase = 'off';
    this.model.roomId = null;
    this.session = false;
    this.host.status(undefined);
    if (this.token) await this.request('/api/session', 'DELETE').catch(() => undefined);
    this.redraw();
  }

  async hide(): Promise<void> { this.paneOpen = false; await this.host.close(); }

  private startTimer(): void {
    this.timer ??= this.host.every(1000, () => { void this.tick(); });
  }

  private async tick(): Promise<void> {
    if (!this.model.enabled) return;
    this.model.now = await this.host.now();
    this.model.frame += 1;
    if (!this.session && !this.connecting && this.model.now >= this.retryAt && this.model.busy && !this.pausedByUser) void this.connect();
    if (this.session) void this.poll();
    this.redraw();
  }

  private async connect(): Promise<void> {
    if (this.connecting || this.session || !this.model.enabled) return;
    this.connecting = true;
    const generation = this.generation;
    this.model.phase = this.retryAt ? 'reconnecting' : 'connecting';
    this.redraw();
    try {
      const value = await this.request('/api/session', 'POST', {
        ...(this.token ? { token: this.token } : {}), profile: this.model.profile,
        available: this.model.busy && !this.pausedByUser,
      }) as { token?: unknown; sessionId?: unknown };
      if (generation !== this.generation) {
        if (typeof value.token === 'string' && /^[a-f0-9]{64}$/.test(value.token)) {
          await this.host.fetch(`${this.server}/api/session`, { method: 'DELETE', headers: { Authorization: `Bearer ${value.token}`, ...(typeof value.sessionId === 'string' ? { 'X-Roulette-Session': value.sessionId } : {}) } }).catch(() => undefined);
        }
        return;
      }
      if (typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token)) throw new Error('Server returned an invalid session.');
      if (typeof value.sessionId !== 'string' || value.sessionId.length > 128) throw new Error('Server returned an invalid session ID.');
      this.sessionId = value.sessionId;
      this.token = value.token;
      this.session = true;
      this.cursor = 0;
      this.retryAt = 0;
      this.retryDelay = 1000;
      this.model.error = '';
      await this.host.storeSet(this.tokenKey, this.token).catch(() => undefined);
      await this.poll();
      if (!this.model.busy || this.pausedByUser) this.enqueue({ type: 'availability', available: false, keepChat: this.model.keepChat });
    } catch (error) {
      if (generation === this.generation) this.connectionFailed(error);
    } finally { this.connecting = false; }
  }

  private connectionFailed(error: unknown): void {
    this.session = false;
    this.model.roomId = null;
    if (!this.model.enabled) return;
    this.model.phase = 'reconnecting';
    this.model.error = `${cleanText(error instanceof Error ? error.message : 'Connection failed.', 180)} Retrying...`;
    this.retryAt = this.model.now + this.retryDelay;
    this.retryDelay = Math.min(30000, this.retryDelay * 2);
    this.redraw();
  }

  private async request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    const response = await this.host.fetch(`${this.server}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...(this.sessionId && !(path === '/api/session' && method === 'POST') ? { 'X-Roulette-Session': this.sessionId } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.text.length > 2_000_000) throw new Error('Server response exceeded the size limit.');
    let value: unknown;
    try { value = response.text ? JSON.parse(response.text) : {}; } catch { throw new Error('Server did not return JSON. Check ROULETTE_URL.'); }
    if (!response.ok) {
      if ([401, 404, 409].includes(response.status)) this.session = false;
      const detail = value as { error?: { code?: string; message?: string } };
      if (detail.error?.code === 'duplicate_session') this.replaced();
      if (detail.error?.code === 'banned') this.suspended();
      throw new Error(typeof detail.error?.message === 'string' ? detail.error.message : `Server returned HTTP ${response.status}.`);
    }
    return value;
  }

  private enqueue(event: ClientEvent): void {
    if (event.type === 'message' || event.type === 'typing' || event.type === 'block' || event.type === 'report') {
      if (!this.model.roomId) return;
      event = { ...event, roomId: this.model.roomId };
    }
    const generation = this.generation;
    const sessionId = this.sessionId;
    this.sendChain = this.sendChain.then(async () => {
      if (!this.session || generation !== this.generation || sessionId !== this.sessionId) return;
      try { await this.request('/api/action', 'POST', event); await this.poll(); }
      catch (error) {
        this.model.error = cleanText(error instanceof Error ? error.message : 'Unable to send.', 180);
        if (!this.session) this.connectionFailed(error);
        this.redraw();
      }
    });
  }

  private async poll(): Promise<void> {
    if (this.fetching || !this.session) return;
    this.fetching = true;
    const generation = this.generation;
    const sessionId = this.sessionId;
    try {
      const reply = await this.request(`/api/events?after=${this.cursor}`) as { events?: unknown; cursor?: unknown };
      if (generation !== this.generation || sessionId !== this.sessionId) return;
      if (!Array.isArray(reply.events) || reply.events.length > 1024 || typeof reply.cursor !== 'number' || !Number.isSafeInteger(reply.cursor) || reply.cursor < this.cursor) throw new Error('Invalid event response.');
      for (const event of reply.events) this.receive(decodeServerEvent(event));
      this.cursor = reply.cursor;
      this.redraw();
    } catch (error) { if (generation === this.generation && sessionId === this.sessionId) this.connectionFailed(error); }
    finally { this.fetching = false; }
  }

  private line(text: string): void {
    this.model.lines.push({ id: crypto.randomUUID(), text: cleanText(text), who: 'system', at: this.model.now });
    this.model.lines = this.model.lines.slice(-120);
  }

  private receive(event: ServerEvent): void {
    if (!event || typeof event !== 'object') return;
    switch (event.type) {
      case 'welcome': this.model.alias = cleanText(event.alias, 40); this.model.stats = event.stats; break;
      case 'stats': this.model.stats = event.stats; break;
      case 'queued':
        this.model.phase = 'queued'; this.model.queuedAt = event.since; this.model.peer = null; this.model.roomId = null;
        this.model.peerTyping = false; this.model.notice = ''; this.model.error = ''; break;
      case 'matched':
        this.model.phase = 'chatting'; this.model.peer = event.peer; this.model.roomId = event.roomId; this.model.sharedInterests = event.sharedInterests;
        this.model.icebreaker = cleanText(event.icebreaker, 180); this.model.startedAt = event.startedAt;
        this.model.peerTyping = false; this.model.lines = []; this.model.scroll = 0;
        this.model.notice = 'Connected. Say hello!'; this.model.error = ''; break;
      case 'message':
        if (!this.model.lines.some(line => line.id === event.id)) {
          this.model.lines.push({ id: event.id, text: cleanText(event.text), who: event.from, at: event.at });
          this.model.lines = this.model.lines.slice(-120);
        }
        if (event.from === 'peer') this.model.peerTyping = false;
        break;
      case 'typing': this.model.peerTyping = event.active; break;
      case 'peer_left':
        this.pausedByUser = true;
        this.model.peerTyping = false; this.model.roomId = null; this.model.phase = this.model.busy ? 'paused' : 'ready';
        this.line(event.reason === 'task_done' ? 'Their Claude task finished. Time well spent.' : 'Your partner left the room. Next finds someone new.');
        break;
      case 'paused': this.model.roomId = null; this.model.phase = this.model.busy ? 'paused' : 'ready'; this.model.peerTyping = false; break;
      case 'task_status': break;
      case 'reported': this.pausedByUser = true; this.model.notice = 'Report received. This person is blocked from future matches.'; break;
      case 'blocked': this.pausedByUser = true; this.model.notice = 'Blocked. You will not be matched with this person again.'; break;
      case 'error':
        if (event.code === 'duplicate_session') this.replaced();
        else if (event.code === 'banned') this.suspended();
        else this.model.error = cleanText(event.message, 180);
        break;
      case 'pong': break;
    }
  }

  private suspended(): void {
    this.stopRetrying('This identity is suspended. Contact the server operator.');
  }

  private replaced(): void {
    this.stopRetrying('This identity connected in another Claude session. Automatic reconnect is stopped.');
  }

  private stopRetrying(message: string): void {
    this.session = false;
    this.model.enabled = false;
    this.model.phase = 'off';
    this.model.roomId = null;
    this.timer?.cancel();
    this.timer = undefined;
    this.model.error = message;
    this.host.status(undefined);
    this.host.toast(this.model.error);
  }

  private redraw(): void {
    this.host.invalidate();
    if (!this.model.enabled) return;
    this.host.status(this.model.phase === 'chatting'
      ? `Roulette: ${this.model.peer ? cleanText(this.model.peer.alias, 32) : 'connected'}${this.model.busy ? ' | Claude working' : ' | task finished'}`
      : this.model.phase === 'queued' ? 'Roulette: finding another human | /roulette'
        : this.model.busy ? 'Roulette: /roulette to open chat' : 'Roulette ready for your next task | /roulette');
  }
}

export function serverUrl(value: unknown): string {
  const url = new URL(typeof value === 'string' && value ? value : 'https://clauderoulette.thelazydeveloper.com');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('ROULETTE_URL must be an http(s) server URL without credentials, query, or fragment.');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Remote roulette servers must use HTTPS.');
  return url.toString().replace(/\/$/, '');
}
