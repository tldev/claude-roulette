import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { randomUUID } from 'node:crypto';
import { useApp, useInput, useStdout } from 'ink';
import type { RouletteClient } from '../client/client.js';
import { MAX_MESSAGE_LENGTH, ProfileSchema, ReportReasonSchema, safeText } from '../shared/protocol.js';
import { COMMANDS, parseInterests } from './helpers.js';
import { ThemeProvider } from './theme-context.js';
import { parseThemeMode, type ThemeMode, type TerminalTheme } from './theme.js';
import { ConsentView, RouletteView } from './view.js';

export type TuiClient = Pick<RouletteClient, 'connect' | 'disconnect' | 'send' | 'getSnapshot' | 'subscribe' | 'setProfile' | 'setAvailability' | 'addNotice'>;
export type AppProps = { client: TuiClient; onExit?: () => void; demo?: boolean; initialConsent?: boolean; initialTheme?: ThemeMode; detectedTheme?: TerminalTheme; onThemeChange?: (mode: ThemeMode) => void };

type CommandActions = { exit: () => void; toggleHelp: () => void; setTheme?: (mode: ThemeMode) => void };

export function executeCommand(client: TuiClient, input: string, actions: CommandActions): void {
  const [name = '', ...parts] = input.trim().split(/\s+/);
  const value = parts.join(' ');
  const snapshot = client.getSnapshot();
  const profile = { ...snapshot.profile };
  switch (name.toLowerCase()) {
    case '/next': client.send({ type: 'next' }); return;
    case '/leave': client.send({ type: 'leave' }); return;
    case '/join': client.send({ type: 'join' }); return;
    case '/block':
      if (snapshot.status !== 'chatting') { client.addNotice('You can block someone while you are in a conversation.'); return; }
      client.send({ type: 'block' }); return;
    case '/report': {
      if (snapshot.status !== 'chatting') { client.addNotice('You can report someone while you are in a conversation.'); return; }
      const reason = ReportReasonSchema.safeParse(value.toLowerCase());
      if (!reason.success) { client.addNotice('Use /report spam, harassment, sexual, hate, or other.'); return; }
      client.send({ type: 'report', reason: reason.data }); return;
    }
    case '/interests':
      profile.interests = parseInterests(value);
      break;
    case '/mode':
      if (value !== 'random' && value !== 'interests') { client.addNotice('Use /mode random or /mode interests.'); return; }
      profile.mode = value;
      break;
    case '/language':
      profile.language = value.toLowerCase();
      break;
    case '/done': client.setAvailability(false, snapshot.keepChat); return;
    case '/working': client.setAvailability(true, false); return;
    case '/stay':
      client.setAvailability(snapshot.available, true);
      client.addNotice(snapshot.status === 'chatting' ? 'Stay mode is on. This conversation can continue when Claude finishes.' : 'Stay mode is on. Use /working to meet someone while Claude works.');
      return;
    case '/theme': {
      const mode = parseThemeMode(value);
      if (!mode) { client.addNotice('Use /theme light, /theme dark, or /theme auto.'); return; }
      actions.setTheme?.(mode);
      client.addNotice(`Terminal theme: ${mode}.`);
      return;
    }
    case '/help': actions.toggleHelp(); return;
    case '/quit': actions.exit(); return;
    default: client.addNotice(`Unknown command: ${safeText(name, 40)}. Type /help for the guide.`); return;
  }
  const valid = ProfileSchema.safeParse(profile);
  if (!valid.success) {
    client.addNotice(name === '/language' ? 'Use a two-letter language code, like en, es, or fr.' : 'Choose up to 8 interests, each 1 to 24 characters. Use letters, numbers, spaces, +, #, . or -.');
    return;
  }
  client.setProfile(valid.data);
  client.addNotice(snapshot.status === 'chatting' ? 'Preferences saved for your next match.' : 'Preferences saved. Finding your kind of conversation.');
}

function previousCharacter(value: string, position: number): number {
  return Math.max(0, position - (Array.from(value.slice(0, position)).at(-1)?.length ?? 1));
}
function nextCharacter(value: string, position: number): number {
  return Math.min(value.length, position + (Array.from(value.slice(position))[0]?.length ?? 1));
}

export function App({ client, onExit, demo = false, initialConsent = false, initialTheme = 'auto', detectedTheme = 'dark', onThemeChange }: AppProps) {
  const { exit: inkExit } = useApp();
  const { stdout } = useStdout();
  const [themeMode, setThemeMode] = useState<ThemeMode>(initialTheme);
  const theme = themeMode === 'auto' ? detectedTheme : themeMode;
  const [accepted, setAccepted] = useState(initialConsent);
  const [draft, setDraft] = useState('');
  const [cursor, setCursor] = useState(0);
  const [help, setHelp] = useState(false);
  const [helpScroll, setHelpScroll] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [dimensions, setDimensions] = useState({ width: stdout.columns || 100, height: stdout.rows || 32 });
  const history = useRef<string[]>([]);
  const historyPosition = useRef(-1);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const typing = useRef(false);
  const subscribe = useCallback((listener: () => void) => client.subscribe(listener), [client]);
  const readSnapshot = useCallback(() => client.getSnapshot(), [client]);
  const snapshot = useSyncExternalStore(subscribe, readSnapshot, readSnapshot);
  const exit = useCallback(() => { client.disconnect(); if (onExit) onExit(); else inkExit(); }, [client, inkExit, onExit]);

  useEffect(() => {
    const resize = () => setDimensions({ width: stdout.columns || 100, height: stdout.rows || 32 });
    stdout.on('resize', resize);
    return () => { stdout.off('resize', resize); };
  }, [stdout]);

  useEffect(() => {
    if (!accepted) return;
    client.connect();
    return () => { client.disconnect(); };
  }, [accepted, client]);

  useEffect(() => {
    if (!accepted) return;
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => { clearInterval(timer); };
  }, [accepted]);

  useEffect(() => {
    setScroll(0);
    setDraft('');
    setCursor(0);
    typing.current = false;
    clearTimeout(typingTimer.current);
  }, [snapshot.roomId]);

  useEffect(() => () => { clearTimeout(typingTimer.current); }, []);

  const stopTyping = () => {
    clearTimeout(typingTimer.current);
    if (typing.current) client.send({ type: 'typing', active: false });
    typing.current = false;
  };

  const updateDraft = (value: string, position = value.length) => {
    const limited = value.slice(0, MAX_MESSAGE_LENGTH);
    setDraft(limited);
    setCursor(Math.min(position, limited.length));
    if (snapshot.status !== 'chatting' || limited.startsWith('/') || !limited) { stopTyping(); return; }
    if (!typing.current) { client.send({ type: 'typing', active: true }); typing.current = true; }
    clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(stopTyping, 1800);
  };

  useInput((input, key) => {
    if (key.ctrl && input === 'c') { exit(); return; }
    if (!accepted) {
      if (key.return) setAccepted(true);
      else if (key.escape) exit();
      return;
    }
    if (key.escape) {
      if (help) setHelp(false);
      else updateDraft('');
      return;
    }
    if (key.ctrl && input === 'n') { stopTyping(); client.send({ type: 'next' }); return; }
    if (key.ctrl && input === 'l') { stopTyping(); client.send({ type: 'leave' }); return; }
    if (key.pageUp) { if (help) setHelpScroll(value => Math.max(0, value - 5)); else setScroll(value => value + Math.max(4, dimensions.height - 20)); return; }
    if (key.pageDown) { if (help) setHelpScroll(value => Math.min(14, value + 5)); else setScroll(value => Math.max(0, value - Math.max(4, dimensions.height - 20))); return; }
    if (key.ctrl && input === 'a') { setCursor(0); return; }
    if (key.ctrl && input === 'e') { setCursor(draft.length); return; }
    if (key.ctrl && input === 'u') { updateDraft(draft.slice(cursor), 0); return; }
    if (key.ctrl && input === 'k') { updateDraft(draft.slice(0, cursor)); return; }
    if (key.ctrl && input === 'w') {
      const remaining = draft.slice(0, cursor).replace(/\s*\S+\s*$/, '');
      updateDraft(remaining + draft.slice(cursor), remaining.length);
      return;
    }
    if (key.leftArrow) { setCursor(previousCharacter(draft, cursor)); return; }
    if (key.rightArrow) { setCursor(nextCharacter(draft, cursor)); return; }
    if (key.upArrow || key.downArrow) {
      if (!history.current.length) return;
      historyPosition.current = Math.max(-1, Math.min(history.current.length - 1, historyPosition.current + (key.upArrow ? 1 : -1)));
      updateDraft(historyPosition.current >= 0 ? history.current[historyPosition.current] ?? '' : '');
      return;
    }
    if (key.tab && draft.startsWith('/')) {
      const matches = COMMANDS.filter(command => command.startsWith(draft));
      if (matches.length === 1) updateDraft(`${matches[0]} `);
      else if (matches.length > 1) client.addNotice(matches.join('  '));
      return;
    }
    if (key.backspace || key.delete) {
      if (cursor > 0) {
        const previous = previousCharacter(draft, cursor);
        updateDraft(draft.slice(0, previous) + draft.slice(cursor), previous);
      }
      return;
    }
    if (key.return) {
      const text = draft.trim();
      if (!text) return;
      stopTyping();
      history.current = [text, ...history.current.filter(entry => entry !== text)].slice(0, 30);
      historyPosition.current = -1;
      if (text.startsWith('/')) {
        executeCommand(client, text, { exit, setTheme: mode => { setThemeMode(mode); onThemeChange?.(mode); }, toggleHelp: () => { setHelp(value => !value); setHelpScroll(0); } });
        updateDraft('');
      } else if (snapshot.status !== 'chatting') {
        client.addNotice('Find a conversation first. Type /join to enter the queue.');
      } else if (client.send({ type: 'message', id: randomUUID(), text })) {
        updateDraft('');
        setScroll(0);
      }
      return;
    }
    if (!key.ctrl && !key.meta && input) {
      const clean = safeText(input).replace(/\n/g, ' ');
      updateDraft(draft.slice(0, cursor) + clean + draft.slice(cursor), cursor + clean.length);
    }
  });

  return <ThemeProvider theme={theme}>{!accepted
    ? <ConsentView width={dimensions.width} height={dimensions.height} demo={demo} />
    : <RouletteView snapshot={snapshot} {...dimensions} draft={draft} cursor={cursor} help={help} helpScroll={helpScroll} scroll={scroll} now={now} demo={demo} />
  }</ThemeProvider>;
}

export { RouletteView, ConsentView } from './view.js';
export default App;
