# agent-bridge

[한국어](README.ko.md)

A small local task queue that lets AI coding tools hand work to each other.
You write a task once, choose who should do it — **Claude Code**, **Codex** or **Antigravity** (Gemini) — and collect the result in the same place.

> **Status: early release (0.1.0).** Tested on **Windows x64** only. Most CLI messages and the detailed docs are in Korean for now.
>
> agent-bridge is an independent project. It is not affiliated with or endorsed by Anthropic, OpenAI or Google.

> **Gemini users, please read.** Version 0.1.0 runs the Antigravity CLI with your personal Google account, and this may violate Google's terms. The [Antigravity FAQ](https://antigravity.google/docs/faq/) says using third-party tools with an Antigravity login is not allowed and can lead to account suspension. A version that lets you choose a Gemini API key instead is in progress. Until then, skip the Gemini runner or use it at your own risk.

## What it does

- Keeps tasks, replies and questions in a local SQLite queue (`~/.agent-bridge/bridge.db`).
- Runs each task with the CLI you already have installed and signed in to:
  - Codex through `codex app-server`
  - Claude Code through `claude -p`
  - Gemini through the Antigravity CLI (`agy`) with your own Google account
- Lets you choose the recipient, model and effort per task, and chain steps (for example: Codex writes, Claude reviews).
- Records token usage per attempt so you can see where your budget went.
- Opens an optional dashboard in your browser to submit tasks and watch progress.

The queue itself never calls a model. Model usage only happens when a runner executes a task.

## Install (Windows x64)

1. Download `agent-bridge-win-x64.zip` from the [Releases](../../releases) page and unzip it to any folder.
   A Node.js runtime is bundled, so you do not need to install Node.

   The scripts in the zip are not code-signed, so Windows may show "Windows protected your PC" or block the files.
   Before unzipping, you can check the file against the SHA-256 value on the release page, then unblock it:

   ```powershell
   Get-FileHash .\agent-bridge-win-x64.zip -Algorithm SHA256
   Unblock-File .\agent-bridge-win-x64.zip
   ```
2. Install and sign in to at least one agent CLI yourself (Codex, Claude Code or Antigravity `agy`).
3. Run `Self Test.cmd`. It checks the bundle with mock agents and does not call any model.
4. Check which CLIs were found:

   ```powershell
   .\agent-bridge.cmd doctor
   ```

5. Optional: make one short real call to each installed agent to confirm sign-in.
   This uses a small amount of your usage quota.

   ```powershell
   .\agent-bridge.cmd check-connections
   ```

If a CLI is not detected, set its path in `%USERPROFILE%\.agent-bridge\clients.json` or with `AGENT_BRIDGE_CODEX_CLI`, `AGENT_BRIDGE_CLAUDE_CLI`, `AGENT_BRIDGE_GEMINI_CLI`. Store only executable paths there, never tokens or API keys.

## Quick start

Save this as `task.json`, changing `cwd` to a real folder and `recipient` to an agent you have installed (`codex`, `claude-code` or `gemini`):

```json
{
  "message_id": "hello-1",
  "task_id": "hello",
  "sender": "codex",
  "recipient": "gemini",
  "cwd": "C:/work/project",
  "goal": "Read this folder and summarize it briefly",
  "acceptance": ["Summarize with evidence, without changing any file"],
  "sandbox": "read-only",
  "write_files": [],
  "file_refs": []
}
```

Send it, run it once, then read and acknowledge the reply:

```powershell
.\agent-bridge.cmd send .\task.json
.\agent-bridge.cmd run --once
.\agent-bridge.cmd receive --as codex
.\agent-bridge.cmd ack "<message_id from the reply>" --as codex
```

To use the dashboard instead, point it at a Git repository and open the `http://127.0.0.1` address it prints:

```powershell
.\agent-bridge.cmd serve --repo "C:\work\project"
```

## Safety and privacy

- **Read-only by default.** Write tasks run only when you start the runner with `--allow-write` and the task lists the files it may change in `write_files`. If agent-bridge observes a change outside that list, it marks the task as `blocked` for your review. This is detection after the fact, not a sandbox: it does not undo the change.
- **Everything stays on your computer.** agent-bridge has no telemetry and sends nothing to any server of its own. Model calls go through the official CLIs you installed.
- **The dashboard listens on `127.0.0.1` only** and checks the request origin and a session token.
- **No credentials are stored.** Sign-in is handled by each CLI. The bundle contains no keys, accounts or databases.
- **Settings tamper check.** Before and after a task, agent-bridge compares *hashes* of your agent settings files (for example `~/.claude/settings.json`, `~/.codex/config.toml`) to detect unexpected changes. File contents are not sent anywhere.
- Connected agents can read files in the task folder, and write to it when you allow it. Choose the task folder with care.

## Known limitations

- Windows x64 only. macOS and Linux have not been tested, and the release builder is Windows-only.
- CLI messages, the dashboard and the detailed reference ([docs/reference.ko.md](docs/reference.ko.md)) are in Korean.
- No plugins are required by default. If you list plugins in `required_plugins` in `profiles.json`, every profile keeps them on.
- Artifact Writer is optional. If it is installed, Codex uses it for document files (`.md`, `.html`, `.json` and similar). Otherwise Codex writes them directly inside the task folder.
- Default model names in `profiles.json` and `image-job.mjs` may become outdated. Change them to models available to you.
- Creating tasks from the dashboard needs Git and a Git repository. Plain folders work from the CLI.
- The default review chain (`chain.review`) needs both Codex and Claude Code.
- The queue is shared only within one computer. There is no network relay between machines.

## Run from source

Requires Node.js 22.13 or newer. No npm dependencies.

```powershell
node portable.mjs doctor
node portable.mjs send .\task.json
npm test
```

Build a release zip (Windows x64, output folder must not exist yet):

```powershell
npm run build:release -- release
```

## Documentation

- [docs/reference.ko.md](docs/reference.ko.md): full command and option reference (Korean)
- [docs/common-contract.ko.md](docs/common-contract.ko.md): shared task contracts (Korean)
- [docs/efficiency.ko.md](docs/efficiency.ko.md): usage records and cost notes (Korean)

## Support

agent-bridge is free and open source. If it helps you, you can support development at [talkak.shop](https://talkak.shop).

## License

[MIT](LICENSE)
