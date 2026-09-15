import React from 'react';
import { Box, Text } from 'ink';
import type { ClientSnapshot } from '../client/client.js';
import { safeText } from '../shared/protocol.js';
import { usePalette } from './theme-context.js';
import { clip, displayWidth, elapsed, profileSummary, tail, timeLabel, wrap } from './helpers.js';

export type RouletteViewProps = {
  snapshot: ClientSnapshot;
  width?: number;
  height?: number;
  draft?: string;
  cursor?: number;
  scroll?: number;
  now?: number;
  demo?: boolean;
  help?: boolean;
  helpScroll?: number;
};

const FRAMES = ['◜', '◠', '◝', '◞', '◡', '◟'];

function Label({ children, color }: { children: React.ReactNode; color?: string }) {
  const c = usePalette();
  return <Text color={color ?? c.muted} bold>{children}</Text>;
}

function Status({ snapshot, now }: { snapshot: ClientSnapshot; now: number }) {
  const c = usePalette();
  if (snapshot.connection !== 'connected') return <Text color={c.yellow}>○ {snapshot.connection}</Text>;
  if (snapshot.status === 'chatting') return <Text color={c.mint}>● connected · {elapsed(snapshot.matchedAt, now)}</Text>;
  if (snapshot.status === 'queued') return <Text color={c.lavender}>{FRAMES[Math.floor(now / 180) % FRAMES.length]} finding your person</Text>;
  return <Text color={c.muted}>○ {snapshot.available ? 'taking a breather' : 'task complete'}</Text>;
}

function Header({ snapshot, width, now, demo, short = false }: { snapshot: ClientSnapshot; width: number; now: number; demo?: boolean; short?: boolean }) {
  const c = usePalette();
  if (short) return <Box flexDirection="column" marginBottom={1}>
    <Box justifyContent="space-between"><Text color={c.coral} bold>◈ CLAUDE ROULETTE</Text><Status snapshot={snapshot} now={now} /></Box>
    <Text color={c.muted}>{demo ? 'SIMULATED CHAT · interactive demo' : 'A little company while Claude thinks.'}</Text>
  </Box>;
  const compact = width < 65;
  return <Box flexDirection="column" marginBottom={1}>
    <Box justifyContent="space-between">
      <Box gap={2}>
        {!compact && <Box flexDirection="column"><Text color={c.coral}>╭───╮ ╭───╮</Text><Text color={c.coral}>│ • │ │ • │</Text><Text color={c.coral}>╰───╯ ╰───╯</Text></Box>}
        <Box flexDirection="column">
          <Text bold color={c.coral}>{compact ? '◈ CLAUDE ROULETTE' : 'C L A U D E   R O U L E T T E'}</Text>
          <Text color={c.text}>{compact ? 'A human in the loop.' : 'A little company while Claude thinks.'}</Text>
          <Text color={c.muted}>{demo ? 'SIMULATED CHAT · interactive demo' : 'Strangers, small talk, serendipity.'}</Text>
        </Box>
      </Box>
      {width >= 85 && <Box flexDirection="column" alignItems="flex-end"><Status snapshot={snapshot} now={now} /><Text color={c.faint}>TEXT ONLY / HUMAN TO HUMAN</Text><Text color={c.muted}>{snapshot.stats.online} online · {snapshot.stats.waiting} waiting</Text></Box>}
    </Box>
    {width < 85 && <Box marginTop={1} justifyContent="space-between"><Status snapshot={snapshot} now={now} /><Text color={c.muted}>{snapshot.stats.online} online</Text></Box>}
  </Box>;
}

function Queue({ snapshot, now, width, short }: { snapshot: ClientSnapshot; now: number; width: number; short: boolean }) {
  const c = usePalette();
  const disconnected = snapshot.connection !== 'connected';
  const queued = snapshot.status === 'queued';
  return <Box flexDirection="column" justifyContent="center" alignItems="center" flexGrow={1}>
    {!short && <Box flexDirection="column" alignItems="center" marginBottom={1}>
      <Text color={c.faint}>·       ·       ·</Text>
      <Text color={c.lavender}>{queued ? '◌   ·   ◎   ·   ◌' : '◌       ◇       ◌'}</Text>
      <Text color={c.faint}>·       ·       ·</Text>
    </Box>}
    <Text color={c.text} bold>{disconnected ? 'Opening a little window to the world' : queued ? 'Somewhere, someone else is waiting.' : snapshot.available ? 'Take a breath. Find a new conversation.' : 'Your work is ready when you are.'}</Text>
    <Box marginTop={1}><Text color={c.muted}>{clip(disconnected ? 'Connecting to the lounge…' : queued ? `${profileSummary(snapshot.profile)} · ${elapsed(snapshot.queuedAt, now)} elapsed` : snapshot.available ? 'Type /join to meet someone new.' : 'Type /working when Claude starts another task.', width - 4)}</Text></Box>
    {!short && <Box marginTop={2} flexDirection="column" alignItems="center"><Text color={c.coral}>Good conversations start small.</Text><Text color={c.faint}>A side project. A strange idea. Your best snack.</Text></Box>}
  </Box>;
}

type ChatLine = { text: string; kind: 'headerYou' | 'headerPeer' | 'message' | 'system' | 'space' };
export function transcriptLines(snapshot: ClientSnapshot, width: number): ChatLine[] {
  return snapshot.messages.flatMap<ChatLine>(message => {
    if (message.from === 'system') return wrap(`· ${message.text}`, width).map(text => ({ text, kind: 'system' as const }));
    return [
      { text: clip(`${message.from === 'you' ? 'YOU' : safeText(snapshot.peer?.alias ?? 'STRANGER')}  ${timeLabel(message.at)}`, width), kind: message.from === 'you' ? 'headerYou' as const : 'headerPeer' as const },
      ...wrap(message.text, width).map(text => ({ text, kind: 'message' as const })),
      { text: '', kind: 'space' as const },
    ];
  });
}

function Transcript({ snapshot, width, height, scroll }: { snapshot: ClientSnapshot; width: number; height: number; scroll: number }) {
  const c = usePalette();
  const lines = transcriptLines(snapshot, width);
  const offset = Math.min(scroll, Math.max(0, lines.length - height));
  const end = Math.max(height, lines.length - offset);
  const visible = lines.slice(Math.max(0, end - height), end);
  return <Box flexDirection="column" height={height} flexShrink={0} justifyContent="flex-end">
    {visible.map((line, index) => <Text key={`${end - height + index}:${line.kind}`} color={line.kind === 'headerYou' ? c.mint : line.kind === 'headerPeer' ? c.lavender : line.kind === 'system' ? c.muted : c.text} bold={line.kind === 'headerYou' || line.kind === 'headerPeer'}>{line.text || ' '}</Text>)}
  </Box>;
}

function Rail({ snapshot, now, height }: { snapshot: ClientSnapshot; now: number; height: number }) {
  const c = usePalette();
  return <Box borderStyle="round" borderColor={c.border} width={29} paddingX={2} flexDirection="column" height={height}>
    <Box marginTop={1}><Label color={c.coral}>THE WAITING ROOM</Label></Box>
    <Text color={c.muted}>A pause. A possibility.</Text>
    <Box marginTop={1} justifyContent="space-between"><Text color={c.muted}>In the lounge</Text><Text color={c.mint} bold>{snapshot.stats.online}</Text></Box>
    <Box justifyContent="space-between"><Text color={c.muted}>Finding a match</Text><Text color={c.lavender}>{snapshot.stats.waiting}</Text></Box>
    <Box justifyContent="space-between"><Text color={c.muted}>In conversation</Text><Text color={c.text}>{snapshot.stats.chatting}</Text></Box>
    <Box marginTop={1}><Text color={c.border}>───────────────────────</Text></Box>
    <Box marginTop={1}><Label>YOUR FREQUENCY</Label></Box>
    <Text color={c.text}>{profileSummary(snapshot.profile)}</Text>
    <Text color={c.faint}>Language: {snapshot.profile.language.toUpperCase()}</Text>
    <Box marginTop={1} flexDirection="column">
      {(snapshot.profile.interests.length ? snapshot.profile.interests : ['add your interests']).slice(0, height < 28 ? 2 : 4).map(interest => <Text key={interest} color={c.lavender}>{clip(`# ${interest}`, 23)}</Text>)}
    </Box>
    {height >= 24 && <Box marginTop={1} flexDirection="column"><Text color={c.border}>───────────────────────</Text><Box marginTop={1}><Label color={c.mint}>CLAUDE IS {snapshot.available ? 'WORKING' : 'FINISHED'}</Label></Box><Text color={c.muted}>{snapshot.keepChat ? 'Stay mode is on.' : 'We pause when work is done.'}</Text>{height >= 29 && snapshot.status === 'chatting' && <Text color={c.faint}>Together for {elapsed(snapshot.matchedAt, now)}</Text>}</Box>}
    {height >= 31 && <Box marginTop={1} flexDirection="column"><Text color={c.faint}>No code, prompts, or files</Text><Text color={c.faint}>are shared with strangers.</Text></Box>}
  </Box>;
}

function Help({ width, height, scroll }: { width: number; height: number; scroll: number }) {
  const c = usePalette();
  const rows = [
    ['/next', 'Meet someone new'], ['/leave · /join', 'Pause or return to the queue'],
    ['/interests music, rust', 'Choose up to 8 interests'], ['/mode random|interests', 'Change how you match'],
    ['/language en', 'Set your two-letter language'], ['/block', 'Block this person and move on'],
    ['/report spam', 'Report and end the conversation'], ['Report reasons', 'spam, harassment, sexual, hate, other'],
    ['/stay', 'Keep the chat when Claude finishes'], ['/done · /working', 'Manually update task status'],
    ['Ctrl+N · Ctrl+L', 'Next person · leave room'], ['Page Up · Page Down', 'Scroll the conversation'],
    ['Tab · Esc', 'Complete a command · dismiss help'], ['/theme light|dark|auto', 'Choose readable terminal colors'], ['/quit', 'Close the lounge'],
  ];
  return <Box flexDirection="column" flexGrow={1}>
    <Text color={c.coral} bold>MAKE YOURSELF AT HOME</Text>
    <Text color={c.muted}>Page Up/Down: more commands.</Text>
    <Box marginTop={1} flexDirection="column">{rows.slice(scroll, scroll + Math.max(3, height - 4)).map(([command, description]) => <Text key={command}><Text color={c.lavender}>{width < 50 ? clip(command ?? '', width) : command?.padEnd(27)}</Text>{width >= 50 && <Text color={c.text}>{clip(description ?? '', width - 27)}</Text>}</Text>)}</Box>
  </Box>;
}

export function RouletteView({ snapshot, width = 108, height = 36, draft = '', cursor = draft.length, scroll = 0, now = Date.now(), demo = false, help = false, helpScroll = 0 }: RouletteViewProps) {
  const c = usePalette();
  const columns = Math.max(30, width);
  const wide = columns >= 100;
  const short = height < 29;
  const contentWidth = columns - 2;
  const chatWidth = wide ? contentWidth - 30 : contentWidth;
  const innerWidth = chatWidth - 6;
  const banner = !snapshot.available;
  const headerRows = short ? 3 : contentWidth < 85 ? 6 : 4;
  const panelHeight = Math.max(10, height - headerRows - 6 - (banner ? 3 : 0));
  const transcriptHeight = Math.max(3, panelHeight - (snapshot.icebreaker && snapshot.status === 'chatting' ? 8 : 5));
  const inputWidth = contentWidth - 8;
  const cursorCharacter = Array.from(draft.slice(cursor))[0] ?? ' ';
  const beforeCursor = tail(draft.slice(0, cursor), inputWidth - displayWidth(cursorCharacter) - 1);
  const inputStart = cursor > beforeCursor.length;
  const remainingWidth = Math.max(0, inputWidth - displayWidth(beforeCursor) - displayWidth(cursorCharacter) - (inputStart ? 1 : 0));
  const afterCursor = clip(draft.slice(cursor + cursorCharacter.length), remainingWidth);

  return <Box flexDirection="column" width={columns} paddingX={1}>
    <Header snapshot={snapshot} width={contentWidth} now={now} demo={demo} short={short} />
    {banner && <Box borderStyle="round" borderColor={c.mint} paddingX={1} marginBottom={0}><Text color={c.mint} bold>✓ CLAUDE FINISHED </Text><Text color={c.text}>{clip(snapshot.keepChat ? 'Stay mode is on. Enjoy your conversation.' : 'Your task is ready. /working to rejoin', contentWidth - 23)}</Text></Box>}
    <Box gap={1}>
      <Box width={chatWidth} height={panelHeight} borderStyle="round" borderColor={snapshot.status === 'chatting' ? c.lavender : c.border} paddingX={2} flexDirection="column">
        <Box justifyContent="space-between" marginBottom={1} flexShrink={0}>
          <Text color={c.lavender} bold>{help ? 'QUICK GUIDE' : snapshot.status === 'chatting' ? `◈ ${clip(snapshot.peer?.alias ?? 'A new stranger', Math.max(10, innerWidth - 20))}` : '◈ THE LOUNGE'}</Text>
          <Text color={c.faint}>{help ? '/help to close' : snapshot.status === 'chatting' ? 'PRIVATE ROOM' : snapshot.alias ? clip(snapshot.alias, 22) : 'WELCOME'}</Text>
        </Box>
        {help ? <Help width={innerWidth} height={panelHeight - 4} scroll={helpScroll} /> : snapshot.status === 'chatting' || (snapshot.status === 'paused' && snapshot.messages.length > 0) ? <>
          {snapshot.status === 'chatting' && snapshot.icebreaker && <Box flexDirection="column" marginBottom={1} flexShrink={0}><Text color={c.coral}>{clip(`↳ ${snapshot.icebreaker}`, innerWidth)}</Text><Text color={c.faint}>{clip(snapshot.sharedInterests.length ? `You both like ${snapshot.sharedInterests.map(value => `#${value}`).join('  ')}` : 'Different worlds. One conversation.', innerWidth)}</Text></Box>}
          <Transcript snapshot={snapshot} width={innerWidth} height={transcriptHeight} scroll={scroll} />
          <Box flexGrow={1} />
          <Text color={c.faint}>{scroll > 0 ? '↑ Viewing earlier messages · Page Down for latest' : snapshot.typing ? `${clip(snapshot.peer?.alias ?? 'Your stranger', innerWidth - 12)} is typing…` : snapshot.status !== 'chatting' ? 'The conversation ended. /next to meet someone new.' : ' '}</Text>
        </> : <Queue snapshot={snapshot} now={now} width={innerWidth} short={short} />}
      </Box>
      {wide && <Rail snapshot={snapshot} now={now} height={panelHeight} />}
    </Box>
    <Box paddingX={1} height={1}><Text color={snapshot.error ? c.yellow : c.muted}>{clip(snapshot.error ? `! ${snapshot.error}` : snapshot.notice ?? (snapshot.status === 'chatting' ? 'Be kind. Be curious. You can leave at any time.' : 'Your next conversation is one /join away.'), contentWidth - 2)}</Text></Box>
    <Box borderStyle="round" borderColor={c.coral} paddingX={1}>
      <Text color={c.coral} bold>› </Text>
      {draft ? <Text color={c.text}>{inputStart ? '…' : ''}{beforeCursor}<Text inverse>{cursorCharacter}</Text>{afterCursor}</Text> : <Text color={c.faint}><Text inverse> </Text>{snapshot.status === 'chatting' ? ' Say hello…' : ' /interests coffee, coding, music'}</Text>}
    </Box>
    <Box justifyContent="space-between" paddingX={1}><Text color={c.faint}>{columns >= 75 ? 'Enter send   Ctrl+N next   Ctrl+L leave   /help commands' : 'Enter send · /next · /help · /quit'}</Text>{columns >= 100 && <Text color={c.faint}>Your code stays yours.</Text>}</Box>
  </Box>;
}

export function ConsentView({ width = 90, height = 32, demo = false }: { width?: number; height?: number; demo?: boolean }) {
  const c = usePalette();
  const compact = height <= 28 || width < 65;
  const columns = Math.max(30, Math.min(width - 2, 88));
  if (compact) return <Box flexDirection="column" width={columns} paddingX={1}>
    <Text color={c.coral} bold>CLAUDE ROULETTE</Text>
    <Text color={c.text}>Company while Claude thinks.</Text>
    <Box borderStyle="round" borderColor={c.lavender} marginY={1} paddingX={2} flexDirection="column">
      <Text color={c.lavender} bold>YOUR NEXT GOOD CONVERSATION</Text>
      <Text color={c.text}>18+ only. Be kind. No harassment, hate, sexual content, or spam.</Text>
      <Text color={c.mint}>Leave, block, or report any time.</Text>
      <Text color={c.mint}>No code, prompts, or files are shared.</Text>
      <Text color={c.muted}>Strangers can copy chat. Skip secrets.</Text>
      <Text color={c.faint}>{demo ? 'SIMULATED DEMO. No one else is connected.' : 'Server relays messages without saving them. Reports: identity and reason.'}</Text>
    </Box>
    <Text color={c.coral} bold>Enter: I am 18+ and agree</Text>
    <Text color={c.faint}>Esc: leave · /help inside</Text>
  </Box>;
  return <Box flexDirection="column" width={columns} padding={1}>
    <Text color={c.coral} bold>C L A U D E   R O U L E T T E</Text>
    <Text color={c.text}>A human in the loop, while Claude is working.</Text>
    <Box borderStyle="round" borderColor={c.lavender} marginY={1} paddingX={3} paddingY={1} flexDirection="column">
      <Text color={c.lavender} bold>YOUR NEXT GOOD CONVERSATION</Text>
      <Box marginY={1}><Text color={c.text}>Meet a random person who is waiting, just like you. Swap ideas, talk side projects, or find out what is on their playlist.</Text></Box>
      <Text color={c.mint}>✓ Text only. Anonymous aliases. Leave whenever you want.</Text>
      <Text color={c.mint}>✓ Your code, prompts, files, and Claude context stay private.</Text>
      <Box marginTop={1} flexDirection="column"><Text color={c.muted}>This lounge is for adults 18 and older. Be kind. No harassment, hate, sexual content, or spam.</Text><Text color={c.muted}>Strangers can copy what you send. Skip sensitive details. You can block or report anyone.</Text></Box>
      <Box marginTop={1}><Text color={c.faint}>{demo ? 'Demo mode uses a simulated peer. No one else is connected.' : 'Messages pass through the server and are not saved. Reports contain identity and reason.'}</Text></Box>
    </Box>
    <Text color={c.coral} bold>Enter: I am 18+ and agree to these ground rules</Text>
    <Text color={c.faint}>Esc: leave · Once inside, use /interests to find your people.</Text>
  </Box>;
}
