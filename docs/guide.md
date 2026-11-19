# agent-bridge user guide

[한국어](guide.ko.md)

A guide for first-time users. The full list of commands and options is in [reference.ko.md](reference.ko.md) (Korean).

> **Note on language.** The dashboard, its buttons and most CLI messages are in Korean for now. Where this guide names a screen label, the Korean text is shown in parentheses so you can find it.

## 1. What agent-bridge does

AI coding tools are normally opened and used one at a time. agent-bridge puts a **local task queue** between them so they can hand work to each other.

```
write a task ─▶ [queue] ─▶ the receiving AI runs it ─▶ result (reply) ─▶ confirm (ACK)
```

- **Task**: one piece of work you hand to someone, such as "read this folder and summarize it". You write it as a JSON file (an envelope).
- **Runner**: the part that takes tasks from the queue and actually runs the matching AI. A task only moves while a runner is on.
- **Reply**: the result or question the AI sends back.
- **Confirm (ACK)**: telling the queue you received a reply. Until you confirm, the same reply is delivered again.

The queue itself never calls an AI. Usage is only incurred **when a runner executes a task**.

## 2. Before you start

1. **Install and sign in to each AI tool yourself** (Codex, Claude Code, Antigravity `agy`). agent-bridge does not sign in for you and never receives or stores your sign-in details. Following each provider's terms is your responsibility.
2. One AI is enough. With two or more, they can hand work to each other.
3. In the unzipped folder, run `Self Test.cmd` once to check the installation. It does not call any AI.

```powershell
.\agent-bridge.cmd doctor          # which AIs were found
.\agent-bridge.cmd settings        # which AIs are on, and how Gemini signs in
```

## 3. Three ways to start it

| Way | When to use it |
|---|---|
| **`Start Tray.cmd`** | Easiest. An icon appears at the bottom right of the taskbar and no window opens |
| `Start Dashboard.cmd` | When you are fine keeping a black console window open |
| `agent-bridge.cmd` commands | When you want to send tasks as files and read results with commands |

### The tray icon (bottom right)

Run `Start Tray.cmd`. A blue round icon appears; it may be under the hidden-icons arrow. **Right-click** it for:

- **Start runner / Stop runner** (the current state is shown at the top)
- **Open dashboard** (double-clicking the icon does the same)
- **Open settings**: goes straight to the Settings tab
- **Quit**: closes the icon and the dashboard together

The work folder is your user folder. To use another folder or a Git repository, start it yourself as below. A runner started from the tray is **read-only**. Add `--allow-write` when the AI needs to write files.

```powershell
.\agent-bridge.cmd serve --repo "C:\work\project" --tray --allow-write
```

## 4. Using the dashboard

It opens at `http://127.0.0.1:<number>`. This address works **only on your own computer**.

| Tab | What it does |
|---|---|
| Tasks (작업) | Create tasks and watch their progress and results |
| Work folders (작업 폴더) | Create separate work folders (Git worktrees) from a Git repository, so tasks do not touch each other's files |
| Profiles (프로필) | See what information is handed to the AI for each task |
| Settings (설정) | Switch AIs on or off, and choose how Gemini signs in |

### Task states

| State | Meaning | What to do |
|---|---|---|
| Queued (대기 중) | Waiting its turn in the queue | Check that the runner is on |
| Working (작업 중) | The AI is on it | Wait, or cancel if needed |
| Ready (준비됨) | A result has arrived | Read it, then press **Confirm receipt** (수신 확인) |
| Blocked (진행 불가) | It stopped | Read the reason and see "Troubleshooting" below |
| Cancelled (취소됨) | You cancelled it | |

## 5. Settings: which AIs to use and how Gemini signs in

**Which AIs to use**: only the AIs you switch on send and receive tasks. A task addressed to a switched-off AI is rejected. If a runner is already on, stop it and start it again to apply a change.

**How Gemini signs in**: Gemini takes no tasks until you choose.

- **Gemini API key (recommended)**
  1. Create a key in [Google AI Studio](https://aistudio.google.com/apikey).
  2. Add a **user environment variable** in Windows named `GEMINI_API_KEY`, with your key as the value.
  3. Close and reopen the tray and any terminals.
  4. In the Settings tab, choose the Gemini API key option and save.

  Google may bill you for the usage. agent-bridge never stores or shows the key.
- **Personal Google account**: this may violate Google's terms. [Google's FAQ](https://antigravity.google/docs/faq/) says other programs may not use an Antigravity login and that accounts can be suspended. You can choose it only after accepting that risk.
- **Both**: tasks use the default method, and you can switch per task with `"gemini_auth": "api-key"` or `"account"`.

## 6. Try it: examples

The basic shape of a task envelope (`task.json`). `sender` is who sends it and `recipient` is the AI that takes it. They must differ.

```json
{
  "message_id": "hello-1",
  "task_id": "hello",
  "sender": "claude-code",
  "recipient": "codex",
  "cwd": "C:/work/project",
  "goal": "Read this folder and summarize it briefly",
  "acceptance": ["Summarize with evidence, without changing any file"],
  "sandbox": "read-only",
  "write_files": [],
  "file_refs": []
}
```

- `message_id`: the task's unique name. **Sending the same name with the same content again does not create a new task.**
- `acceptance`: the completion criteria. The AI reports pass or fail with evidence for each one.

### Example A. Read only

Use the envelope above. Send it, run it once, then receive the result.

```powershell
.\agent-bridge.cmd send .\task.json
.\agent-bridge.cmd run --once
.\agent-bridge.cmd receive --as claude-code
.\agent-bridge.cmd ack "<message_id of the reply>" --as claude-code
```

`run --once` ends when there is nothing left to take. Without `--once` it keeps waiting.

### Example B. Allowing file writes

Writing needs **all three** of these. Without any one of them, the task does not run.

1. `"sandbox": "workspace-write"` in the envelope
2. The files that may change, listed in `write_files` (for example `["README.md"]`)
3. The runner started with `--allow-write`

```powershell
.\agent-bridge.cmd run --once --allow-write
```

If a file outside the list is found changed, the task is set to Blocked and waits for you. **This is detection after the fact, not a sandbox**, so it does not undo the change. For important folders, use Git and create separate work folders (worktrees).

### Example C. One AI writes, another reviews

Add `"chain": {"review": true}` to the envelope. Codex's result is reviewed independently by Claude Code. **Both Codex and Claude Code must be switched on.** If the review rejects the work, a rework task listing the findings is created.

### Example D. When the AI asks a question

If the AI lacks information, it stops with a question instead of guessing. Type your answer in the task details in the dashboard and the same conversation continues. From the command line, send a follow-up that names the question's `reply_id` (`send followup.json --reply-to <reply_id>`).

### Example E. Choosing the model and effort per task

Add `"model"` (a model name) and `"effort"` (`low`, `medium`, `high` or `xhigh`) to the envelope. A lower effort for light work reduces usage.

## 7. Usage and cost

- The queue, dashboard and tray never call an AI themselves.
- When a runner executes a task, usage is charged to **each AI service's plan or API billing**.
- Input and output tokens are recorded for every attempt and shown under "Usage" (사용량) in the task details.
- `check-connections` makes one short real call to each installed AI, which uses a small amount.
- The AI reads its own built-in instructions as input, so even a short answer uses some input tokens.

## 8. Troubleshooting

Messages appear in Korean. The first column gives their meaning.

| Symptom | Cause and fix |
|---|---|
| A task stays Queued | The runner is off. Choose "Start runner" in the tray, or run `run` |
| "You have not chosen a Gemini sign-in method yet" | Choose one in the Settings tab, or run `settings --gemini-auth api-key` |
| "GEMINI_API_KEY is missing" | Add the key as a user environment variable, then **close and reopen** the tray and terminals |
| "Personal-account sign-in needs your consent" | Read the warning and accept it, or choose the API key method |
| "Sign-in is needed or authentication failed" | Open that AI tool yourself and sign in, then try again. `check-connections` shows the status |
| "Usage limit reached" | The service's limit is full. Try again later with Requeue (다시 대기열에 넣기) |
| Blocked: file changed outside the allowed list | A file not on the list was changed. Review the change, undo it if needed, then requeue |
| Blocked: question | The AI is asking. Send your answer |
| "This agent is not available on this PC" | The AI was not found or is switched off. Check `doctor` and Settings |
| I cannot see the tray icon | Look under the hidden-icons arrow. If it says it is already running, an icon is already on |
| Windows shows a warning | The scripts are not code-signed. Compare the SHA-256 value on the Release page, then run `Unblock-File` |
| The dashboard cannot create tasks | Creating tasks there needs Git and a Git repository. For plain folders, use the `send` command |

## 9. FAQ

**Are my files or conversations sent anywhere?**
agent-bridge sends nothing to any server of its own and has no usage statistics. Task data stays in the queue on your computer. What goes to an AI is what each tool sends to its own service.

**Does it store API keys or passwords?**
No. The settings file holds only executable paths and the method you chose. Your key lives only in your user environment variables.

**Can I use just one AI?**
Yes. `sender` is only the name that receives replies, so that AI does not have to be installed.

**Does it work on macOS or Linux?**
Only Windows x64 has been tested. The tray icon is Windows-only.

**Is it connected to Claude Code, Codex or Antigravity?**
No. agent-bridge is an independent project and is not an official tool of any of those companies.

**I found a problem or want a feature.**
Please open an issue on [GitHub Issues](https://github.com/Zenorin/agent-bridge/issues).
