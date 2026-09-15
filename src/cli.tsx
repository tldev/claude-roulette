#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { parseArgs } from 'node:util';
import { App } from './tui/app.js';
import { DemoClient, RouletteClient, websocketUrl } from './client/client.js';
import { identityFor, loadConfig, saveConfig } from './client/config.js';
import { ProfileSchema } from './shared/protocol.js';
import { detectTerminalTheme, parseThemeMode, type ThemeMode } from './tui/theme.js';

const HELP = `Claude Roulette 0.1.0
Meet another human while Claude is thinking.

Usage: claude-roulette [options]
  --server URL       Lounge server (default: https://clauderoulette.thelazydeveloper.com)
  --interests LIST   Comma-separated interests, up to 8
  --language CODE    Two-letter language code (default: en)
  --random           Skip interest preference
  --theme MODE       Terminal colors: auto, light, or dark (default: auto)
  --demo             Offline, clearly labeled scripted preview
  --help             Show this help

Inside the lounge: /help, /next, /leave, /join, /interests, /mode,
/language, /block, /report, /done, /working, /stay, /theme, /quit.

For automatic task detection, install the native Claude mod in plugin/.
The standalone TUI uses /done and /working for task status.
Only chat text and chosen interests are shared. Code and prompts stay local.
`;

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { server: { type: 'string' }, interests: { type: 'string' }, language: { type: 'string' }, theme: { type: 'string' }, random: { type: 'boolean' }, demo: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } }, strict: true });
  if (values.help) { process.stdout.write(HELP); return; }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Open an interactive terminal to use the lounge. Use --help for setup.');
  const requestedTheme = parseThemeMode(values.theme);
  if (values.theme !== undefined && !requestedTheme) throw new Error('Choose --theme auto, --theme light, or --theme dark.');
  let themeMode: ThemeMode = requestedTheme ?? 'auto';
  let onThemeChange: ((mode: ThemeMode) => void) | undefined;
  let client: RouletteClient;
  if (values.demo) client = new DemoClient();
  else {
    const config = loadConfig();
    themeMode = requestedTheme ?? config.theme ?? 'auto';
    config.theme = themeMode;
    onThemeChange = mode => { config.theme = mode; saveConfig(config); };
    const url = values.server ?? process.env.ROULETTE_SERVER_URL ?? 'https://clauderoulette.thelazydeveloper.com';
    websocketUrl(url);
    const profile = ProfileSchema.parse({ ...config.profile, ...(values.interests !== undefined ? { interests: values.interests.split(',').map(x => x.trim()).filter(Boolean) } : {}), ...(values.language ? { language: values.language } : {}), ...(values.random ? { mode: 'random' } : {}) });
    config.profile = profile;
    client = new RouletteClient({ url, token: identityFor(config, url), profile, onProfileChange: (next) => { config.profile = next; saveConfig(config); } });
    saveConfig(config);
  }
  const detectedTheme = themeMode === 'auto' ? await detectTerminalTheme() : themeMode;
  const instance = render(<App client={client} demo={values.demo} initialTheme={themeMode} detectedTheme={detectedTheme} onThemeChange={onThemeChange} onExit={() => instance.unmount()} />, { exitOnCtrlC: true, patchConsole: false });
  const stop = (): void => { client.disconnect(); instance.unmount(); };
  process.once('SIGTERM', stop);
  try { await instance.waitUntilExit(); } finally { client.disconnect(); process.removeListener('SIGTERM', stop); }
}

main().catch((error: unknown) => { process.stderr.write(`Roulette: ${error instanceof Error ? error.message : 'Unexpected error'}\n`); process.exitCode = 1; });
