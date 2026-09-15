import { safeText, type Profile } from '../shared/protocol.js';

export const COMMANDS = ['/next', '/leave', '/join', '/interests', '/mode', '/language', '/block', '/report', '/done', '/working', '/stay', '/theme', '/help', '/quit'];

export function elapsed(since: number | undefined, now: number): string {
  const seconds = since ? Math.max(0, Math.floor((now - since) / 1000)) : 0;
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}

export function timeLabel(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function parseInterests(value: string): string[] {
  return [...new Set(value.split(',').map(tag => tag.trim().toLowerCase()).filter(Boolean))];
}

export function profileSummary(profile: Profile): string {
  return profile.mode === 'random' ? 'Open to everyone' : profile.interests.length ? 'Shared interests first' : 'Open to everyone';
}

function characterWidth(character: string): number {
  const code = character.codePointAt(0) ?? 0;
  if (/\p{Mark}/u.test(character) || code === 0x200d || code === 0xfe0f) return 0;
  return code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || code >= 0x1f300) ? 2 : 1;
}

export function displayWidth(value: string): number {
  return Array.from(value).reduce((length, character) => length + characterWidth(character), 0);
}

export function clip(value: string, width: number): string {
  if (width <= 0) return '';
  const clean = safeText(value).replace(/\n/g, ' ');
  if (displayWidth(clean) <= width) return clean;
  let result = '';
  for (const character of clean) {
    if (displayWidth(result) + characterWidth(character) > width - 1) break;
    result += character;
  }
  return `${result}…`;
}

export function wrap(value: string, width: number): string[] {
  const clean = safeText(value);
  const limit = Math.max(1, width);
  const lines: string[] = [];
  for (const paragraph of clean.split('\n')) {
    let line = '';
    for (const character of paragraph) {
      if (displayWidth(line) + characterWidth(character) > limit) {
        lines.push(line);
        line = '';
      }
      line += character;
    }
    lines.push(line);
  }
  return lines;
}

export function tail(value: string, width: number): string {
  let result = '';
  for (const character of Array.from(value).reverse()) {
    if (displayWidth(result) + characterWidth(character) > width) break;
    result = character + result;
  }
  return result;
}
