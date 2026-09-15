import { randomBytes, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, ProfileSchema, ServerEventSchema, safeText, type ClientEvent, type Peer, type Profile, type ServerEvent, type Stats } from '../shared/protocol.js';

export interface ChatMessage { id: string; text: string; from: 'you' | 'peer' | 'system'; at: number }
export interface ClientSnapshot {
  connection: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';
  status: 'idle' | 'queued' | 'chatting' | 'paused';
  alias: string;
  stats: Stats;
  profile: Profile;
  available: boolean;
  keepChat: boolean;
  roomId?: string;
  peer?: Peer;
  sharedInterests: string[];
  icebreaker?: string;
  queuedAt?: number;
  matchedAt?: number;
  typing: boolean;
  messages: ChatMessage[];
  error?: string;
  notice?: string;
}

export interface ClientOptions { url: string; token: string; profile: Profile; available?: boolean; onProfileChange?: (profile: Profile) => void }

export function websocketUrl(raw: string): string {
  const url = new URL(raw);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) throw new Error('Server URL must use http, https, ws, or wss.');
  if (url.username || url.password || url.search || url.hash) throw new Error('Server URL cannot contain credentials, a query, or a fragment.');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol === 'ws:' || url.protocol === 'http:') && !local) throw new Error('Remote servers require HTTPS/WSS. Use an SSH tunnel for local development.');
  url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '').replace(/\/ws$/, '')}/ws`;
  return url.toString();
}

export class RouletteClient {
  protected snapshot: ClientSnapshot;
  private listeners = new Set<() => void>();
  private socket?: WebSocket;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private typingTimer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private stopped = true;
  private attempt = 0;
  private reconnectAllowed = true;
  private wantsQueue = true;
  private serverAvailable = false;
  private lastPong = 0;
  private lastTypingSent = 0;

  constructor(protected readonly options: ClientOptions) {
    this.snapshot = {
      connection: 'disconnected', status: 'idle', alias: 'You',
      stats: { online: 0, waiting: 0, chatting: 0 },
      profile: ProfileSchema.parse(options.profile), available: options.available ?? true,
      keepChat: false, sharedInterests: [], typing: false, messages: [],
    };
  }

  getSnapshot = (): ClientSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  protected patch(update: Partial<ClientSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }
  addNotice(text: string): void {
    const clean = safeText(text);
    this.patch({ notice: clean, messages: [...this.snapshot.messages, { id: randomUUID(), text: clean, from: 'system' as const, at: Date.now() }].slice(-200) });
  }

  connect(): void {
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) return;
    this.stopped = false;
    this.reconnectAllowed = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.typingTimer);
    clearInterval(this.heartbeat);
    let url: string;
    try { url = websocketUrl(this.options.url); }
    catch (error) { this.patch({ connection: 'error', error: (error as Error).message }); return; }
    this.patch({ connection: this.attempt ? 'reconnecting' : 'connecting', error: undefined });
    const socket = new WebSocket(url, { maxPayload: 16 * 1024, handshakeTimeout: 10_000, perMessageDeflate: false });
    this.socket = socket;
    socket.on('open', () => {
      if (this.stopped || this.socket !== socket) return;
      this.lastPong = Date.now();
      this.serverAvailable = this.snapshot.available && this.wantsQueue;
      this.sendRaw({ type: 'hello', protocol: PROTOCOL_VERSION, token: this.options.token, profile: this.snapshot.profile, available: this.serverAvailable });
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastPong > 45_000) socket.terminate();
        else this.sendRaw({ type: 'ping' });
      }, 15_000);
      this.heartbeat.unref();
    });
    socket.on('message', (buffer) => {
      if (this.socket !== socket || this.stopped) return;
      try {
        const parsed = ServerEventSchema.safeParse(JSON.parse(buffer.toString()));
        if (parsed.success) this.receive(parsed.data);
        else { this.reconnectAllowed = false; this.patch({ error: 'Server sent an incompatible response. Check server and client versions.' }); socket.close(1002); }
      } catch { this.reconnectAllowed = false; this.patch({ error: 'Server sent invalid JSON.' }); socket.close(1002); }
    });
    socket.on('error', () => {
      if (this.socket === socket && !this.stopped) this.patch({ error: 'Cannot reach the lounge. Check the server URL and connection.' });
    });
    socket.on('close', (code) => {
      if (this.socket !== socket) return;
      clearInterval(this.heartbeat);
      clearTimeout(this.typingTimer);
      this.socket = undefined;
      this.patch({ connection: this.stopped ? 'disconnected' : 'reconnecting', status: 'paused', peer: undefined, roomId: undefined, typing: false });
      if (this.stopped) return;
      if (!this.reconnectAllowed || [1008, 4001, 4003, 4009, 4401, 4403, 4409].includes(code)) {
        this.patch({ connection: 'error', error: this.snapshot.error ?? 'Session ended. Close duplicate clients or contact the server operator.' });
        return;
      }
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempt++, 5)) + Math.floor(Math.random() * 300);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
      this.reconnectTimer.unref();
    });
  }

  disconnect(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.typingTimer);
    clearInterval(this.heartbeat);
    this.sendRaw({ type: 'leave' });
    this.socket?.close(1000, 'Leaving the lounge');
    this.patch({ connection: 'disconnected', status: 'paused', peer: undefined, roomId: undefined, typing: false });
  }

  private sendRaw(event: ClientEvent): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(event));
    return true;
  }
  send(event: ClientEvent): boolean {
    if (['message', 'typing', 'block', 'report'].includes(event.type) && this.snapshot.roomId) event = { ...event, roomId: this.snapshot.roomId } as ClientEvent;
    if (event.type === 'next' || event.type === 'join') event = { ...event, profile: event.profile ?? this.snapshot.profile };
    if (event.type === 'leave') { this.wantsQueue = false; this.patch({ status: 'paused', peer: undefined, roomId: undefined, typing: false }); }
    if (event.type === 'join' || event.type === 'next') {
      this.wantsQueue = true;
      if (event.profile) this.patch({ profile: event.profile });
      if (this.socket?.readyState !== WebSocket.OPEN) { this.connect(); return true; }
    }
    if (event.type === 'typing') {
      if (event.active && Date.now() - this.lastTypingSent < 1000) return true;
      this.lastTypingSent = Date.now();
    }
    if (!this.sendRaw(event)) { if (event.type !== 'typing') this.addNotice('You are offline. Reconnect before sending.'); return false; }
    if (event.type === 'availability') this.serverAvailable = event.available;
    // A reconnect while paused authenticates as unavailable to avoid automatic matching.
    // Apply the requested profile first, then resume availability once the user rejoins.
    if ((event.type === 'join' || event.type === 'next') && this.snapshot.available && !this.serverAvailable) {
      this.serverAvailable = this.sendRaw({ type: 'availability', available: true, keepChat: this.snapshot.keepChat });
    }
    return true;
  }
  setProfile(profile: Profile): void {
    const parsed = ProfileSchema.safeParse(profile);
    if (!parsed.success) { this.addNotice('Use up to 8 interests (24 characters each) and a two-letter language code.'); return; }
    this.patch({ profile: parsed.data });
    this.options.onProfileChange?.(parsed.data);
    if (this.snapshot.status === 'queued') this.send({ type: 'join', profile: parsed.data });
    else this.addNotice('Preferences saved for your next match.');
  }
  setAvailability(available: boolean, keepChat = false): void {
    if (available && (!this.snapshot.available || !this.serverAvailable)) this.wantsQueue = true;
    this.patch({ available, keepChat });
    this.send({ type: 'availability', available, keepChat });
  }

  protected receive(event: ServerEvent): void {
    switch (event.type) {
      case 'welcome':
        this.attempt = 0;
        this.patch({ connection: 'connected', alias: safeText(event.alias, 64), stats: event.stats, error: undefined });
        break;
      case 'queued':
        this.patch({ status: 'queued', queuedAt: event.since, peer: undefined, roomId: undefined, typing: false, sharedInterests: [], icebreaker: undefined });
        break;
      case 'matched':
        this.patch({ status: 'chatting', roomId: event.roomId, peer: { alias: safeText(event.peer.alias, 64), interests: event.peer.interests.map(x => safeText(x, 24)) }, sharedInterests: event.sharedInterests.map(x => safeText(x, 24)), icebreaker: safeText(event.icebreaker, 300), matchedAt: event.startedAt, typing: false, messages: [], notice: undefined, error: undefined });
        break;
      case 'message':
        if (!this.snapshot.messages.some(x => x.id === event.id)) this.patch({ messages: [...this.snapshot.messages, { ...event, text: safeText(event.text) }].slice(-200), typing: event.from === 'peer' ? false : this.snapshot.typing });
        break;
      case 'typing':
        clearTimeout(this.typingTimer);
        this.patch({ typing: event.active });
        if (event.active) this.typingTimer = setTimeout(() => this.patch({ typing: false }), 4000);
        break;
      case 'peer_left':
        this.wantsQueue = false;
        this.patch({ status: 'paused', peer: undefined, roomId: undefined, typing: false });
        this.addNotice(event.reason === 'task_done' ? 'Their Claude task finished. Say hello to someone new with /next.' : 'Your partner left. Find someone new with /next.');
        break;
      case 'paused':
        this.patch({ status: 'paused', peer: undefined, roomId: undefined, typing: false });
        this.addNotice(safeText(event.reason));
        break;
      case 'task_status': this.addNotice(event.done ? 'Your partner’s Claude task finished.' : 'Your partner is waiting for Claude.'); break;
      case 'reported': this.wantsQueue = false; this.addNotice('Report received. This person is blocked from future matches.'); break;
      case 'blocked': this.wantsQueue = false; this.addNotice('Blocked. You will not be matched with this person again on this identity.'); break;
      case 'stats': this.patch({ stats: event.stats }); break;
      case 'error':
        if (event.code === 'operator_disconnected' || event.code === 'maintenance') {
          const guidance = event.code === 'maintenance'
            ? 'When the lounge reopens, use /join or /next to reconnect.'
            : 'Use /join or /next to reconnect when you are ready.';
          this.stopRetrying(`${safeText(event.message, 240)} ${guidance}`);
          break;
        }
        if (['banned', 'duplicate_session', 'protocol_mismatch', 'unauthorized'].includes(event.code)) this.reconnectAllowed = false;
        this.patch({ error: safeText(event.message, 300) }); break;
      case 'pong': this.lastPong = Date.now(); break;
    }
  }

  private stopRetrying(message: string): void {
    this.stopped = true;
    this.reconnectAllowed = false;
    this.wantsQueue = false;
    this.serverAvailable = false;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.typingTimer);
    clearInterval(this.heartbeat);
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(1000, 'Waiting for manual reconnect');
    this.patch({ connection: 'error', status: 'paused', peer: undefined, roomId: undefined, typing: false, error: message });
  }
}

export class DemoClient extends RouletteClient {
  private timers: ReturnType<typeof setTimeout>[] = [];
  constructor() { super({ url: 'http://localhost:8787', token: randomBytes(32).toString('hex'), profile: { interests: ['typescript', 'side projects', 'coffee'], language: 'en', mode: 'interests' } }); }
  override connect(): void {
    if (this.snapshot.connection === 'connected') return;
    this.patch({ connection: 'connected', alias: 'Cosmic Otter', stats: { online: 128, waiting: 16, chatting: 112 } });
    this.queue();
  }
  private queue(): void {
    this.timers.forEach(clearTimeout); this.timers = [];
    this.receive({ type: 'queued', since: Date.now(), position: 1 });
    this.timers.push(setTimeout(() => {
      this.receive({ type: 'matched', roomId: randomUUID(), peer: { alias: 'Velvet Badger', interests: ['typescript', 'music', 'side projects'] }, sharedInterests: this.snapshot.profile.interests.filter(interest => ['typescript', 'music', 'side projects'].includes(interest)), icebreaker: 'What tiny project turned into your biggest rabbit hole?', startedAt: Date.now() });
      this.receive({ type: 'message', id: randomUUID(), text: 'hey! what are you building while your robot does the hard part?', from: 'peer', at: Date.now() });
    }, 1300));
  }
  override send(event: ClientEvent): boolean {
    if (event.type === 'next' || event.type === 'join') {
      if (!this.snapshot.available) { this.addNotice('Use /working when Claude starts another task.'); return true; }
      this.queue(); return true;
    }
    if (event.type === 'availability') {
      if (!event.available && (!event.keepChat || this.snapshot.status !== 'chatting')) {
        this.timers.forEach(clearTimeout);
        this.receive({ type: 'paused', reason: 'Claude finished. Your task is ready.' });
      } else if (event.available && this.snapshot.status !== 'chatting' && this.snapshot.status !== 'queued') this.queue();
      return true;
    }
    if (event.type === 'leave') { this.timers.forEach(clearTimeout); this.timers = []; this.receive({ type: 'paused', reason: 'You left the lounge. Join again whenever you like.' }); return true; }
    if (event.type === 'message' && this.snapshot.status === 'chatting') {
      this.receive({ ...event, from: 'you', at: Date.now() });
      this.receive({ type: 'typing', active: true });
      this.timers.push(setTimeout(() => this.receive({ type: 'message', id: randomUUID(), text: 'This is a scripted demo reply. Connect to a server to meet a real person. ☕', from: 'peer', at: Date.now() }), 1100));
    }
    if (event.type === 'report' || event.type === 'block') { this.receive({ type: event.type === 'report' ? 'reported' : 'blocked' }); this.send({ type: 'leave' }); }
    return true;
  }
  override disconnect(): void { this.timers.forEach(clearTimeout); super.disconnect(); }
}
