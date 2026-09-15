import type { Elements, RenderElement } from 'claude-code';
import type { RouletteController } from './controller';
import { cleanText } from './protocol';

const ACCENT = '#bf8cff';
const MINT = '#76ead7';
const GOLD = '#f5cd79';
const SPIN = ['◐', '◓', '◑', '◒'];

export function paneView(ui: Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Input'>, controller: RouletteController, columns: number, rows: number): RenderElement {
  const { Box, Text, Button, Input } = ui;
  const m = controller.model;
  const width = Math.max(20, Math.min(columns - 2, 88));
  const text = (value: string, color?: string, bold = false) => Text({ children: cleanText(value), ...(color ? { color } : {}), ...(bold ? { bold } : {}) });
  const dim = (value: string) => Text({ children: cleanText(value), dimColor: true });
  const button = (key: string, label: string, onPress: () => void) => Button({ key, label, onPress, ...(key === 'accept' ? { autoFocus: true } : {}) });
  const column = (children: RenderElement[]) => Box({ flexDirection: 'column', children });
  const row = (children: RenderElement[]) => Box({ flexDirection: 'row', gap: 1, children });
  const body: RenderElement[] = [];
  const busy = m.busy ? `${SPIN[m.frame % 4]} Claude is working` : '✓ Claude is ready';
  body.push(text('◌  C L A U D E  R O U L E T T E', ACCENT, true));
  body.push(row([text(busy, m.busy ? GOLD : MINT), dim(` · ${m.stats.online} online · ${m.stats.waiting} waiting`)]));
  body.push(dim('Human company while your agent does the work.'));

  if (!m.confirmedRules) {
    body.push(Box({ flexDirection: 'column', borderStyle: 'round', borderColor: ACCENT, paddingX: 1, marginTop: 1, children: [
      text('A little serendipity between prompts.', MINT, true),
      text('Meet one random person. Talk code, swap ideas, or just say hi.'),
      text('Your chat never goes into Claude. No prompts, files, or task names are shared.'),
      dim('18+ only. Be kind. Do not share secrets. Block or report anyone.'),
      dim('The server relays chat. Operators receive report metadata.'),
      button('accept', 'I am 18+, agree, and want to join', () => controller.activate()),
      button('preferences', 'Set interests first', () => controller.settings()),
    ] }));
  } else {
    const status = m.phase === 'chatting' ? `● CONNECTED TO ${m.peer ? cleanText(m.peer.alias, 40) : 'A HUMAN'}`
      : m.phase === 'queued' ? `${SPIN[m.frame % 4]} FINDING YOUR PERSON`
        : m.phase === 'reconnecting' ? '◌ RECONNECTING'
          : m.phase === 'connecting' ? '◌ CONNECTING'
            : m.phase === 'paused' ? 'Ⅱ TAKING A BREATHER' : '○ ON DECK';
    body.push(Box({ marginTop: 1, children: text(status, m.phase === 'chatting' ? MINT : ACCENT, true) }));
    if (m.phase === 'chatting') {
      const tags = m.sharedInterests.length ? `Common ground: ${m.sharedInterests.map(v => `#${cleanText(v, 24)}`).join(' ')}` : 'A random connection. Start somewhere unexpected.';
      body.push(dim(tags));
      if (m.lines.length === 0) {
        body.push(Box({ borderStyle: 'round', borderColor: 'gray', paddingX: 1, children: column([
          text('BREAK THE ICE', GOLD, true), text(m.icebreaker || 'What is the most surprising thing you have built lately?'),
          button('icebreaker', 'Send this icebreaker', () => controller.send(m.icebreaker || 'What are you building lately?')),
        ]) }));
      }
    } else if (m.phase === 'queued' || m.phase === 'connecting' || m.phase === 'reconnecting') {
      const seconds = Math.max(0, Math.floor((m.now - m.queuedAt) / 1000));
      body.push(Box({ borderStyle: 'round', borderColor: ACCENT, paddingX: 1, children: column([
        text(`${'░'.repeat(m.frame % 8)}◉${'░'.repeat(7 - m.frame % 8)}`, ACCENT),
        text(m.phase === 'queued' ? `Looking for another person${seconds ? ` · ${seconds}s` : ''}` : 'Opening a connection...'),
        dim(m.profile.mode === 'interests' ? 'Shared interests first. Random matches follow.' : 'Surprise me. Every connection is random.'),
        dim(`Language ${m.profile.language} · ${m.profile.interests.length ? m.profile.interests.join(', ') : 'all interests welcome'}`),
      ]) }));
    } else if (m.lines.length === 0) {
      body.push(Box({ borderStyle: 'round', borderColor: 'gray', paddingX: 1, children: column([
        text(m.busy ? 'Your next conversation is one click away.' : 'You are on the guest list.', MINT, true),
        dim(m.busy ? 'Join the queue whenever you are ready.' : 'Start a Claude task. We will find you company while it runs.'),
      ]) }));
    }

    if (m.lines.length) {
      const count = Math.max(2, Math.min(12, Math.floor((rows - 13) / 2)));
      const end = Math.max(1, m.lines.length - m.scroll);
      const lines = m.lines.slice(Math.max(0, end - count), end);
      const conversation = lines.flatMap(line => {
        if (line.who === 'system') return [dim(`· ${line.text}`)];
        const name = line.who === 'you' ? 'YOU' : m.peer ? cleanText(m.peer.alias, 28).toUpperCase() : 'STRANGER';
        const color = line.who === 'you' ? ACCENT : MINT;
        return [text(name, color, true), text(line.text)];
      });
      body.push(Box({ flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', paddingX: 1, width, children: conversation }));
      if (m.lines.length > count || m.scroll) body.push(row([
        button('older', '↑ Older', () => controller.scroll(count)),
        button('newer', '↓ Newer', () => controller.scroll(-count)),
        dim(m.scroll ? `${m.scroll} newer messages` : 'Latest messages'),
      ]));
    }
    if (m.peerTyping) body.push(text('··· your partner is typing', MINT));
    if (m.phase === 'chatting') body.push(Input({
      key: 'message', label: '› ', placeholder: 'Say something human...',
      value: m.draft, submitLabel: 'send', autoFocus: true,
      onInput: value => controller.draft(value), onSubmit: value => controller.send(value),
    }));
    if (m.notice) body.push(dim(m.notice));
    if (m.error) body.push(text(m.error, '#ff9a9e'));
    const actions: RenderElement[] = [];
    if (!m.enabled) actions.push(button('enable', 'Turn on', () => controller.activate()));
    if (m.busy) actions.push(button('next', m.phase === 'chatting' ? 'Next person →' : 'Join queue →', () => m.phase === 'chatting' ? controller.next() : controller.join()));
    if (['queued', 'chatting', 'connecting', 'reconnecting'].includes(m.phase)) actions.push(button('pause', 'Pause', () => controller.pause()));
    actions.push(button('settings', 'Preferences', () => controller.settings()));
    if (m.roomId) actions.push(button('report', 'Report / block', () => controller.reports()));
    body.push(row(actions));
    body.push(row([
      button('keep', `${m.keepChat ? '☑' : '☐'} Keep chat when Claude finishes`, () => controller.toggleKeepChat()),
    ]));
    body.push(row([
      button('hide', 'Hide pane', () => { void controller.hide(); }),
      button('stop', 'Turn off', () => { void controller.stop(); }),
    ]));
  }
  if (m.showSettings) {
    body.push(Box({ borderStyle: 'round', borderColor: ACCENT, paddingX: 1, flexDirection: 'column', children: [
      text('YOUR ORBIT', ACCENT, true),
      Input({ key: 'interests', label: 'Interests', value: m.profile.interests.join(', '), placeholder: 'typescript, music, startups', submitLabel: 'save', onSubmit: value => controller.setInterests(value) }),
      dim('Up to 8 comma-separated interests. Press Enter to save each field.'),
      Input({ key: 'language', label: 'Language', value: m.profile.language, submitLabel: 'save', onSubmit: value => controller.setLanguage(value) }),
      button('mode', `Matching: ${m.profile.mode === 'interests' ? 'shared interests' : 'pure random'}`, () => controller.toggleMode()),
      button('close-settings', 'Done', () => controller.settings()),
    ] }));
  }
  if (m.showReport) {
    body.push(Box({ borderStyle: 'round', borderColor: '#ff9a9e', paddingX: 1, flexDirection: 'column', children: [
      text('YOU CONTROL THIS ROOM', '#ff9a9e', true),
      dim('Reports share room metadata with the operator for review.'),
      row([
        button('report-spam', 'Spam', () => controller.report('spam')),
        button('report-harassment', 'Harassment', () => controller.report('harassment')),
        button('report-sexual', 'Sexual content', () => controller.report('sexual')),
      ]),
      row([
        button('report-hate', 'Hate', () => controller.report('hate')),
        button('report-other', 'Other', () => controller.report('other')),
        button('block', 'Block and leave', () => controller.block()),
        button('cancel-report', 'Cancel', () => controller.reports()),
      ]),
    ] }));
  }
  body.push(dim('Private from Claude · Esc returns to your task · /roulette reopens'));
  return Box({ flexDirection: 'column', paddingX: 1, children: body });
}
