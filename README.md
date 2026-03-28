# Claude Reply Tokens

`Claude Reply Tokens` is a VS Code companion extension that shows the token usage for the latest Claude Code reply in the status bar.

It does not depend on private APIs from the official `anthropic.claude-code` extension. Instead, it reads Claude Code's local JSONL session logs and computes the latest full assistant reply chain for the current workspace.

## Features

- Shows the latest Claude reply token usage in the VS Code status bar
- Aggregates a full reply chain instead of only the last assistant JSONL record
- Matches Claude sessions to the current workspace
- Refreshes automatically when Claude writes new transcript lines
- Opens a latest-turn analysis panel from the status bar
- Shows rolling cumulative usage for the current workspace (`1h / 1d / 3d / 7d / 30d`)
- Keeps the matching transcript available as a separate command

## How It Works

The extension scans Claude's local `projects/**/*.jsonl` files, finds the most relevant session for the current workspace, and reconstructs the latest full turn by walking `parentUuid` across assistant records and intermediate `tool_result` user records.

The total includes:

- `input_tokens`
- `output_tokens`
- `cache_creation_input_tokens`
- `cache_read_input_tokens`

Clicking the status bar opens a latest-turn analysis panel that shows:

- Exact token buckets for the turn (`input / output / cache write / cache read`)
- Rolling cumulative token usage for the current workspace (`1h / 1d / 3d / 7d / 30d`)
- A heuristic content mix by message-block category (`user text / tool result / assistant tool use / assistant thinking / assistant text`)
- Per-assistant-step totals so you can see which call in the turn was expensive

Claude's JSONL logs expose usage per assistant record, not per content block, so the content-category section is heuristic rather than exact token accounting.

## Requirements

- VS Code `1.86.0` or later
- Claude Code installed and actively writing transcript files locally

## Settings

This extension contributes the following settings:

- `claudeReplyTokens.dataDirectory`
  Override the Claude config directory. Point it at the folder that contains `projects/`.
- `claudeReplyTokens.refreshIntervalSeconds`
  Fallback full-rescan interval in seconds. Minimum: `30`.

## Commands

- `Claude Reply Tokens: Refresh`
- `Claude Reply Tokens: Open Latest Claude Turn Analysis`
- `Claude Reply Tokens: Open Claude Transcript`
- `Claude Reply Tokens: Open Claude Reply Tokens Settings`

## Development

Install dependencies:

```powershell
npm install
```

Compile:

```powershell
npm run compile
```

Run tests:

```powershell
npm test
```

Launch an Extension Development Host:

1. Open this project in VS Code
2. Press `F5`

## Packaging

Create a VSIX package:

```powershell
npm run package:vsix
```

This produces a file like:

```text
claude-reply-tokens-0.2.2.vsix
```

Install locally:

```powershell
code --install-extension .\claude-reply-tokens-0.2.2.vsix --force
```

## Team Distribution

Recommended workflow:

1. Run `npm run package:vsix`
2. Upload the generated `.vsix` to your shared release location
3. Ask teammates to install it with `code --install-extension ... --force`

## Notes

- This extension currently tracks the current workspace only
- It does not hook into the official Claude Code extension internals
- If multiple Claude sessions match the same workspace, it uses the one with the latest assistant activity
- Before publishing to VS Code Marketplace, replace `YOUR_PUBLISHER_ID` in `package.json` with your real publisher ID
