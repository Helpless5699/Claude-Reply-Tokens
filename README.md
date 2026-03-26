# Claude Reply Tokens

`Claude Reply Tokens` is a VS Code companion extension that shows the token usage for the latest Claude Code reply in the status bar.

It does not depend on private APIs from the official `anthropic.claude-code` extension. Instead, it reads Claude Code's local JSONL session logs and computes the latest full assistant reply chain for the current workspace.

## Features

- Shows the latest Claude reply token usage in the VS Code status bar
- Aggregates a full reply chain instead of only the last assistant JSONL record
- Matches Claude sessions to the current workspace
- Refreshes automatically when Claude writes new transcript lines
- Opens the matching transcript file from the status bar

## How It Works

The extension scans Claude's local `projects/**/*.jsonl` files, finds the most relevant session for the current workspace, and sums token usage across the latest assistant reply chain by walking `parentUuid`.

The total includes:

- `input_tokens`
- `output_tokens`
- `cache_creation_input_tokens`
- `cache_read_input_tokens`

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
claude-reply-tokens-0.1.0.vsix
```

Install locally:

```powershell
code --install-extension .\claude-reply-tokens-0.1.0.vsix --force
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
