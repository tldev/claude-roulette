import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseThemeMode, type ThemeMode } from '../tui/theme.js';
import { ProfileSchema, type Profile } from '../shared/protocol.js';

export interface LocalConfig { identities: Record<string, string>; profile: Profile; consent: boolean; theme?: ThemeMode }
export const defaultProfile: Profile = { interests: [], language: 'en', mode: 'interests' };
export function configDirectory(): string { return process.env.ROULETTE_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'claude-roulette'); }
export function loadConfig(directory = configDirectory()): LocalConfig {
  try {
    const value = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8')) as Partial<LocalConfig>;
    const identities: Record<string, string> = {};
    if (value.identities && typeof value.identities === 'object') for (const [key, token] of Object.entries(value.identities)) if (typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)) identities[key] = token;
    return { identities, profile: ProfileSchema.parse(value.profile ?? defaultProfile), consent: value.consent === true, theme: parseThemeMode(value.theme) ?? 'auto' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read Roulette configuration. Fix or move config.json before retrying; your identity has not been replaced.');
    return { identities: {}, profile: defaultProfile, consent: false, theme: 'auto' };
  }
}
export function saveConfig(config: LocalConfig, directory = configDirectory()): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = join(directory, `config.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, join(directory, 'config.json'));
  chmodSync(join(directory, 'config.json'), 0o600);
}
export function identityFor(config: LocalConfig, server: string): string {
  const url = new URL(server);
  if (url.protocol === 'ws:') url.protocol = 'http:';
  if (url.protocol === 'wss:') url.protocol = 'https:';
  const origin = url.origin;
  const websocketOrigin = origin.replace(/^http/, 'ws');
  // Preserve existing identities when switching between HTTP and WebSocket URL forms.
  return config.identities[origin] ??= config.identities[websocketOrigin] ?? randomBytes(32).toString('hex');
}
