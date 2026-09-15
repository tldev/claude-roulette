export type ThemeMode = 'auto' | 'light' | 'dark';
export type TerminalTheme = Exclude<ThemeMode, 'auto'>;
export type ThemePalette = Readonly<Record<'coral' | 'lavender' | 'mint' | 'text' | 'muted' | 'faint' | 'border' | 'yellow', string>>;

export const palettes: Readonly<Record<TerminalTheme, ThemePalette>> = {
  light: {
    coral: '#A5442D', lavender: '#6841A3', mint: '#004B48', text: '#252525',
    muted: '#535353', faint: '#646464', border: '#7A7A7A', yellow: '#774400',
  },
  dark: {
    coral: '#EF9B83', lavender: '#B5A3F4', mint: '#85D9BF', text: '#E7E8DF',
    muted: '#B0B5A8', faint: '#929889', border: '#707866', yellow: '#E6C88B',
  },
};

export function parseThemeMode(value: unknown): ThemeMode | undefined {
  return value === 'auto' || value === 'light' || value === 'dark' ? value : undefined;
}

function themeFromRgb(red: number, green: number, blue: number): TerminalTheme {
  const linear = [red, green, blue].map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
  return luminance > 0.179 ? 'light' : 'dark';
}

export function themeFromColorFgBg(value: string | undefined): TerminalTheme | undefined {
  if (!value || !/^(?:\d{1,3};)(?:default;|\d{1,3};)?\d{1,3}$/.test(value)) return undefined;
  const background = Number(value.split(';').at(-1));
  if (background === 0 || background === 8) return 'dark';
  if (background === 7 || background === 15) return 'light';
  // Non-neutral ANSI entries are customizable, so do not guess from their index.
  if (background >= 232 && background <= 255) {
    const level = (8 + (background - 232) * 10) / 255;
    return themeFromRgb(level, level, level);
  }
  return undefined;
}

const backgroundReply = /\u001b\]11;([^\u0007\u001b]*)(?:\u0007|\u001b\\)/;

export function parseOscBackground(response: string): TerminalTheme | undefined {
  const value = response.match(backgroundReply)?.[1];
  const match = value?.match(/^rgb:([a-f\d]{1,4})\/([a-f\d]{1,4})\/([a-f\d]{1,4})$/i);
  if (!match) return undefined;
  const components = match.slice(1).map(component => parseInt(component!, 16) / (16 ** component!.length - 1));
  return themeFromRgb(components[0]!, components[1]!, components[2]!);
}

export interface ThemeDetectionOptions {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** Probe before mounting the TUI so terminal responses cannot enter the chat draft. */
export function queryTerminalBackground(options: ThemeDetectionOptions = {}): Promise<TerminalTheme | undefined> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const env = options.env ?? process.env;
  if (!input.isTTY || !output.isTTY || env.TERM === 'dumb' || input.destroyed || output.destroyed || output.writableEnded
    || input.readableEnded || input.listenerCount('data') || input.listenerCount('readable')) return Promise.resolve(undefined);

  return new Promise(resolve => {
    const wasRaw = input.isRaw;
    const wasFlowing = input.readableFlowing === true;
    let buffered = Buffer.alloc(0);
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (theme?: TerminalTheme, reply?: RegExpMatchArray) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('error', onEnd);
      output.removeListener('error', onEnd);
      input.pause();
      try { input.setRawMode(wasRaw); } catch { /* A closed terminal cannot restore raw mode. */ }
      if (reply && reply.index !== undefined) {
        buffered = Buffer.concat([buffered.subarray(0, reply.index), buffered.subarray(reply.index + reply[0].length)]);
      }
      if (buffered.length && !input.destroyed && !input.readableEnded) input.unshift(buffered);
      if (wasFlowing) input.resume();
      resolve(theme);
    };
    const onEnd = () => finish();
    const onData = (chunk: Buffer | string) => {
      buffered = Buffer.concat([buffered, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      const response = buffered.toString('latin1');
      const reply = response.match(backgroundReply);
      if (reply) finish(parseOscBackground(reply[0]), reply);
      else if (buffered.length > 4096) finish();
    };
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onEnd);
    output.once('error', onEnd);
    timer = setTimeout(onEnd, Math.min(180, Math.max(1, options.timeoutMs ?? 120)));
    try {
      input.setRawMode(true);
      input.resume();
      // Xterm OSC 11 with '?' requests the current background without changing it.
      // https://invisible-island.net/xterm/ctlseqs/ctlseqs.html
      output.write('\u001b]11;?\u0007');
    } catch { finish(); }
  });
}

export async function detectTerminalTheme(options: ThemeDetectionOptions = {}): Promise<TerminalTheme> {
  return await queryTerminalBackground(options) ?? themeFromColorFgBg((options.env ?? process.env).COLORFGBG) ?? 'dark';
}
