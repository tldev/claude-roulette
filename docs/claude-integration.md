# Native Claude Code integration

Claude Roulette includes a real Claude Mods plugin. `/roulette` opens an interactive pane inside Claude Code. The command runs immediately while Claude is working.

## Run it

The mod connects to the hosted lounge automatically. From this repository:

```sh
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir "$PWD/plugin"
```

No server configuration is needed. The feature flag enables Claude's experimental Mods API. This command scopes the plugin to the launched session and does not edit your Claude settings or install it globally.

1. Run `/roulette` in Claude Code.
2. Accept the 18+ community rules. Set interests and a language if you want.
3. Start a Claude task. Matching begins while the main task is running.
4. Use the pane's text input, Next, Pause, Preferences, and Report / block controls. Enter sends a message. Escape returns the keyboard to Claude.
5. When Claude finishes, matching pauses and the partner is notified. Enable **Keep chat when Claude finishes** to finish an existing conversation. New matches still require an active task.

Closing or hiding the pane leaves the current conversation connected. **Pause** leaves the room and stops matching until you join again. **Turn off** disconnects the mod. `/roulette` reopens the pane.

A fullscreen Claude layout needs at least 110 terminal columns for a user-requested dock, and 144 for an automatic first opening. Claude controls the final pane placement and keyboard focus. Its older inline layout can draw the pane at narrower widths.

## What was verified

On September 15, 2026:

- Claude Code **2.1.270**, installed on the development machine, accepted `claude plugin validate ./plugin` with function hooks enabled. It identified every hook and capability call.
- The same binary ran a real interactive session with `--plugin-dir ./plugin`; `/roulette` displayed the native welcome pane, consent control, preferences control, and privacy copy. This check used no model turn.
- Every hook implementation typechecked against Anthropic's published **2.1.271** declarations, in addition to this repository's narrow adapter declarations.
- Automated tests exercise consent gating, main-turn completion versus subagents, chat isolation, matching preferences, room-bound actions, duplicate-session handling, bad network payloads, and teardown races.

Mods remain early access. The feature flag and API may change. This project does not pretend the established shell hooks can render this interface. If a Claude build cannot load function hooks, use the standalone terminal client until that build supports Mods.

## Sources and API decisions

The implementation follows the [official Mods announcement](https://github.com/anthropics/claude-code/issues/91870), the [official built-in Mods source](https://github.com/anthropics/claude-code/tree/main/mods), and the [2.1.271 declaration snapshot](https://github.com/anthropics/claude-code/blob/4992bdc58a57e38793dd1305f421fd5f14c76adf/mods/types/claude-code.d.ts).

| Surface | Implementation |
| --- | --- |
| Plugin loading | `.claude-plugin/plugin.json`, `hooks/hooks.json` with `modules`, and `register(on)` |
| Command | `$.command.register({ name: 'roulette', immediate: true })` and `command.run` |
| Main task begins | `turn.start`; only the opaque turn ID is retained locally |
| Main task finishes | `turn.complete`; subagent completions and stale turn IDs are ignored |
| Native display | `$.ui.open`, `ui.render` of `Pane`, and `$.ui.resolve` for `Box`, `Text`, `Input`, and `Button` |
| User input | Native `Input.onSubmit`, `Input.onInput`, and `Button.onPress` callbacks |
| Redraw and notice | `$.ui.invalidate`, `$.ui.status`, and `$.ui.toast` |
| Network | `$.http.fetch` with the backend's authenticated polling endpoints |
| Timing | `$.clock.every` with one non-overlapping poll per second |
| Local identity | `$.store`, with the token keyed to the configured server |
| Teardown | `classic.SessionEnd`, plus explicit Turn off |

The Mods sandbox cannot import Node, `ws`, React, or Ink. Its UI is a host-rendered data tree, and its declared HTTP API has no WebSocket or streaming body primitive. The standalone client uses Ink and WebSockets. The mod uses a native renderer plus a dependency-free wire contract checked against the shared TypeScript protocol. Both clients use the same server matcher and moderation rules.

`crypto.randomUUID` and `URL` are explicitly included in the official sandbox globals. The plugin's own typecheck excludes DOM and Node ambient types.

`HttpInit` currently has no timeout or AbortSignal field. The adapter does not invent one. Claude task hooks return without waiting on the network; a stalled request can delay the chat transport, but cannot hold up the model turn. After a network failure, reconnect uses exponential backoff up to 30 seconds. A duplicate identity stops automatic reconnect, preventing two local Claude sessions from repeatedly replacing each other.

## Network and privacy boundary

The mod sends an anonymous token, chosen interests/language, a boolean indicating whether the main task is active, messages the user submits in the chat field, and chat actions. It does not read or transmit prompts, Claude answers, file contents, repository paths, tool output, or Claude session IDs.

Peer text is rendered only in the pane. There is no call to Claude's prompt, model, tool, or shell APIs. Incoming events are decoded and size-bounded before rendering, and terminal escapes and invisible direction controls are stripped. Reports and blocks bind to the room that was visible when clicked, so a delayed action cannot target a new partner.

HTTP calls after session creation include `X-Roulette-Session` as well as bearer authentication. The server rejects a stale instance rather than allowing it to control the replacement session. Identity tokens persist locally in Claude's plugin store. Two concurrent sessions that share that identity cannot both stay connected; a replaced instance shows a notice and waits for explicit user action.

## Maintaining compatibility

Run:

```sh
npm run typecheck
npm test
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin validate ./plugin
```

The local `plugin/types/claude-code.d.ts` is a small, independently authored declaration of the methods used here. It is not a bundled copy of Claude Code. After a Claude update, use Claude's `/plugin-types` command to export that binary's declarations and typecheck `plugin/hooks` against them before claiming compatibility.

The upstream repository documents a `claude plugin test` harness, but the installed 2.1.270 binary does not expose that command. This repository therefore uses Vitest with explicit host adapters, plus native plugin validation and an interactive smoke test. Tests are not claimed to have run in an unavailable native harness.
