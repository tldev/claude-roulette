import React from 'react';
import { renderToString } from 'ink';
import { writeFileSync, mkdirSync } from 'node:fs';
import { RouletteView } from '../src/tui/view.js';
import type { ClientSnapshot } from '../src/client/client.js';

// Render the actual terminal component with a deterministic, labeled demo conversation.
const now = new Date('2026-09-15T19:05:00Z').getTime();
const snapshot: ClientSnapshot = {
  connection: 'connected', status: 'chatting', alias: 'Cosmic Otter',
  stats: { online: 128, waiting: 16, chatting: 112 },
  profile: { interests: ['typescript', 'side projects', 'coffee'], language: 'en', mode: 'interests' },
  available: true, keepChat: false, roomId: 'demo',
  peer: { alias: 'Velvet Badger', interests: ['typescript', 'music'] },
  sharedInterests: ['typescript', 'side projects'], icebreaker: 'What tiny project became your biggest rabbit hole?',
  matchedAt: now - 90000, typing: true,
  messages: [
    { id: '1', text: 'hey! what are you building while your robot does the hard part?', from: 'peer', at: now - 60000 },
    { id: '2', text: 'a little place for serendipity. you?', from: 'you', at: now - 40000 },
    { id: '3', text: 'A music app. It has been almost done for about six months.', from: 'peer', at: now - 10000 },
  ],
};
const ansi = renderToString(<RouletteView snapshot={snapshot} width={108} height={36} now={now} demo draft="The last 10% takes 90% of the time" />, { columns: 108 });
const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function ansiColor(index: number): string {
  const basic = ['#1d1f2d', '#d16d74', '#85d9bf', '#e6c88b', '#829ff0', '#b5a3f4', '#85d9d9', '#e7e8ef', '#60667e', '#ff969e', '#adf0cb', '#ffe1a8', '#a7beff', '#d6c4ff', '#c0ffff', '#ffffff'];
  if (index < 16) return basic[index]!;
  if (index >= 232) { const n = (8 + (index - 232) * 10).toString(16).padStart(2, '0'); return `#${n}${n}${n}`; }
  const n = index - 16;
  const scale = [0, 95, 135, 175, 215, 255];
  return `rgb(${scale[Math.floor(n / 36)]},${scale[Math.floor(n / 6) % 6]},${scale[n % 6]})`;
}
let color = '#E7E8EF';
let bold = false;
const textElements: string[] = [];
for (const [lineIndex, line] of ansi.split('\n').entries()) {
  let x = 30;
  const parts = line.split(/(\x1b\[[0-9;]*m)/g);
  for (const part of parts) {
    if (part.startsWith('\x1b[')) {
      const codes = part.slice(2, -1).split(';').map(Number);
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        if (code === 0) { color = '#E7E8EF'; bold = false; }
        if (code === 1) bold = true;
        if (code === 22) bold = false;
        if (code === 39) color = '#E7E8EF';
        if (code === 38 && codes[i + 1] === 5) { color = ansiColor(codes[i + 2]!); i += 2; }
        else if (code === 38 && codes[i + 1] === 2) { color = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`; i += 4; }
      }
    } else if (part) {
      textElements.push(`<text x="${x}" y="${82 + lineIndex * 23}" fill="${color}" font-weight="${bold ? 700 : 400}" xml:space="preserve">${esc(part)}</text>`);
      x += Array.from(part).length * 10.2;
    }
  }
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1160" height="925" viewBox="0 0 1160 925"><rect width="1160" height="925" rx="18" fill="#151822"/><path d="M18 0h1124a18 18 0 0 1 18 18v30H0V18A18 18 0 0 1 18 0" fill="#202432"/><circle cx="26" cy="24" r="6" fill="#ef9b83"/><circle cx="47" cy="24" r="6" fill="#e6c88b"/><circle cx="68" cy="24" r="6" fill="#85d9bf"/><text x="580" y="29" text-anchor="middle" font-family="Menlo,monospace" font-size="13" fill="#9297ac">Claude Roulette · terminal preview · simulated conversation</text><g font-family="Menlo,DejaVu Sans Mono,monospace" font-size="17">${textElements.join('')}</g></svg>`;
mkdirSync('.artifacts', { recursive: true });
writeFileSync('.artifacts/terminal-preview.svg', svg);
writeFileSync('.artifacts/terminal-preview.ansi', ansi);
console.log('Rendered .artifacts/terminal-preview.svg from the real TUI component.');
