# Getting Started with AgentHub

**English** | [Tiếng Việt](../GETTING-STARTED.md)

## Rename the application

Open **Settings → Application name** to change the display name, short name, tagline, and accent color. You can also use the CLI:

```bash
agenthub config set branding.name "New name"
```

This changes display text only. The `agenthub` CLI, service, `~/.agenthub` directory, MCP server, `AGENTHUB_*` environment variables, and release package name remain unchanged. PNG/SVG logos can be uploaded in Settings; logos are limited to 256KB and SVG is safety-checked.

A beginner's guide to installing AgentHub, connecting AI worker accounts, and delegating coding tasks.

AgentHub runs locally on your machine. It breaks down development tasks and schedules them across AI coding workers (Gemini via Antigravity CLI and OpenAI Codex CLI). Each task runs in an isolated git worktree. The hub continuously monitors quota limits, system load, and disk headroom, and automatically executes quality checks (lint, test, build, migration verification) once a worker finishes. **Claude Code** acts as the central coordinator ("Brain"): planning, delegating, reviewing, and merging code.

> **Flexible Control Interfaces:** You can interact with and control AgentHub (dispatch tasks, review diffs, manage queues) via **direct Chat with Claude on the Web Dashboard**, **Remote Control via Telegram Bot** on your mobile device, or **Claude Code in VS Code** using the Model Context Protocol (MCP) (see Sections 7 and 8). The Web Dashboard provides real-time progress tracking, live streaming logs, account quota gauges, host resource monitors, and comprehensive task management.

## Quick setup by chat

Open the Dashboard and click **Set up by chat** in the checklist, Setup page, or Settings. Claude follows the [setup playbook](setup/SETUP-PLAYBOOK.md), asks one question at a time, shows a dry-run diff before every write, and uses the secure secret page for keys and tokens. You can stop at any point and resume the setup session later.

## Move to a new machine

On the old machine run:

```bash
agenthub setup export --out agenthub-setup.json
```

Move the file to the new machine (it contains no tokens, keys, passwords, secrets, or machine-specific absolute paths), then tell Claude: “read `docs/setup/SETUP-PLAYBOOK.md` and install from `agenthub-setup.json`”. Claude runs an import dry-run, reports projects that need cloning, and asks again only for missing secrets through `hub_request_secret`:

```bash
agenthub setup import agenthub-setup.json --dry-run
agenthub setup import agenthub-setup.json
```

---

## 1. Requirements

| Component | Notes |
|---|---|
| **Linux** | Verified on Ubuntu. Leverages `/proc`, `nice`/`ionice`, and systemd user services. |
| **macOS** | Fully supported: process monitoring via `ps`/`lsof`, priority adjustments via `nice`, default browser launching via `open`, and daemon management via LaunchAgent (`ionice` and systemd are unavailable on macOS). |
| **Windows** | Not natively supported. Recommended via WSL2 (run AgentHub inside the Linux subsystem). |
| **Node.js 22** | Release installer downloads it on macOS/Linux when PATH has no Node; manual setup can use [nvm](https://github.com/nvm-sh/nvm). |
| **git** | Projects managed by AgentHub must be git repositories. |
| **At least one Worker CLI** | `agy` (Antigravity CLI with Google authentication) and/or `codex` (Codex CLI with OpenAI authentication). |
| **Claude Code** | Required to use Claude as the orchestrator Brain (Claude Code extension for VS Code or the `claude` CLI). |
| **Hardware Resources** | Workers execute builds and test suites concurrently. Recommended benchmark: 12 CPU cores / 16 GB RAM comfortably runs ~4 concurrent worker processes. |

### Install the Antigravity CLI (`agy`)

On the **Setup** page, click **Install** next to Antigravity CLI to run the official installer. AgentHub streams its output and verifies the binary after it completes:

```sh
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

If installation succeeds but AgentHub still cannot find `agy`, the daemon may have a different PATH from your interactive shell. Set an absolute path with `AGENTHUB_AGY_BIN=/path/to/agy` and restart the daemon. AgentHub searches PATH, `~/.local/bin/agy`, and `~/.gemini/bin/agy`; the log is at `~/.agenthub/logs/setup-agy.log`.

---

## 2. Installation

### Quick One-Line Install from Release (inspect before running):

```bash
curl -fsSL https://raw.githubusercontent.com/ducanh19020217/agenthub/main/scripts/install.sh -o /tmp/agenthub-install.sh
less /tmp/agenthub-install.sh
sh /tmp/agenthub-install.sh --from-release
```

Preview actions with `sh /tmp/agenthub-install.sh --dry-run`. Safe uninstallation preserving user data: `sh /tmp/agenthub-install.sh --uninstall`; use `--purge` only when you explicitly confirm wiping all data.

To test the installer in a clean `node:22-slim` container:

```bash
scripts/smoke-install.sh release/agenthub-*.tar.gz
```

To uninstall:

```bash
sh /tmp/agenthub-install.sh --uninstall
sh /tmp/agenthub-install.sh --uninstall --purge
```

### What if installation fails?

You do not need to clean anything by hand. If download, native-module validation, setup, the CLI link, or service installation fails, the installer removes its temporary directories and restores `current`, the CLI link, and the service to the previous release (when available). Detailed output is kept at `${TMPDIR:-/tmp}/agenthub-install-<time>.log`; include that file when asking for help. The previous release remains usable.

### Manual Setup:

```bash
git clone https://github.com/ducanh19020217/agenthub.git ~/agenthub
cd ~/agenthub
source ~/.nvm/nvm.sh && nvm install 22 && nvm use 22

npm ci
npm --prefix web ci
npm run build
npm run build:web

node dist/cli.js link     # Creates the `agenthub` symlink in ~/.local/bin (ensure it is in your PATH)
agenthub doctor           # Validates Node.js, git, agy, codex, and port 7700 availability
```

On macOS, release installation does not require Node, nvm, or Xcode Command Line Tools. The installer downloads the official Node.js 22 archive for `darwin-arm64` or `darwin-x64`, verifies `SHASUMS256.txt`, and stores it at `~/.agenthub/runtime/node-v22.x`. Use `--use-nvm` only when you explicitly want nvm. Common failures are a bad checksum, a wrong OS/architecture archive, or missing `curl`/`tar`; for source installs that report missing Command Line Tools, run `xcode-select --install` and retry.

Data files (SQLite database, auth token, logs, and worktrees) are stored in `~/.agenthub/` by default. You can customize this storage location using the `AGENTHUB_HOME` environment variable.

---

## 3. Running Hub in the Background and Opening the Dashboard

```bash
agenthub install-service          # Linux: systemd; macOS: ~/Library/LaunchAgents/dev.agenthub.plist
loginctl enable-linger "$USER"    # (Optional, Linux) Keeps daemon running even when logged out
systemctl --user status agenthub  # Check daemon running status

agenthub open                     # Opens http://127.0.0.1:7700/#token=... in your default browser
```

`agenthub restart` drains by default; add `--wait` to wait until the drain completes. Use `--now`/`--force` only when you accept stopping active workers. `./scripts/run-prod.sh --restart` and `./scripts/stop-prod.sh` also drain by default, while `--force` stops immediately.

If the service was installed before safe restart support, run `agenthub install-service` again (or `./scripts/run-prod.sh --build-only` followed by `node dist/cli.js install-service`) so the systemd unit receives `KillMode=process`; verify with `systemctl --user cat agenthub`. This does not require interrupting active workers: the drain restarts the hub when it becomes idle.

- The Web Dashboard binds strictly to `127.0.0.1` and requires an authentication token (which can also be retrieved via `agenthub open --no-browser`).
- To access the dashboard from a remote machine, **use an SSH tunnel** rather than exposing port 7700 to the public network:
  ```bash
  ssh -L 7700:127.0.0.1:7700 user@remote-machine
  ```
  Then open `http://127.0.0.1:7700/#token=...` on your local machine.
- Updating to newer releases:
  ```bash
  git pull && npm ci && npm --prefix web ci && npm run build && npm run build:web && systemctl --user restart agenthub
  ```

---

## 4. Connecting Worker Accounts (Gemini, Codex)

Navigate to **Profiles**, click **Add Profile**, select the provider, and enter a unique profile name. The dashboard opens a step-by-step wizard alongside an interactive terminal session:

- **Antigravity (Gemini):** The hub selects `Google OAuth` from the `agy` menu (press Enter if the interactive selection is shown). Click **Open Google Login**, sign into the target Google account. When Google redirects to `antigravity.google`, copy the authorization code, paste it into the dashboard input, and click **Submit**. Wait for confirmation; the hub automatically captures the associated account email. The OAuth code is valid for approximately 60 seconds; click **Re-login** if it expires. Use distinct Google accounts across different profiles to maintain separate quota pools.
- **Codex (OpenAI):** The hub runs `codex login --device-auth`. Open the verification link, sign into ChatGPT, copy the device pairing code shown on the dashboard, paste it into the login page, and await authorization.

Profile cards indicate live status: **Logged In**, **Not Logged In**, **Verification Needed**, or **Error**. Each card also shows 5-hour/weekly quota progress, currently executing tasks, email collision warnings, and action menus (**Check**, **Edit**, **Rename**, **Delete**). Deleting a profile allows keeping or completely purging its data directory.

If the authentication URL is not visible, check the full terminal output or click **Reconnect**. When an email collision warning is displayed, log in again using a different Google account.

### Accounts & Provider Terms
By default, AgentHub limits each engine to a single **personal** profile to avoid encouraging the rotation of multiple personal accounts to bypass provider limits. **API key** and **Team** accounts can be added without restriction. If you enable `multiplePerProvider` in Settings, the dashboard displays a warning and you assume responsibility for compliance with your provider's terms of service. For shared or heavy usage, prefer Team tiers or API keys over multiple personal tiers.

---

## 5. Claude Account Login

Claude acts as the central coordinator ("Brain") of AgentHub: receiving high-level instructions, decomposing them into independent work units, delegating them to worker models (Gemini, Codex), monitoring execution progress, and conducting code reviews.

### Isolated Storage
Each Claude profile is stored independently in its own directory:
```
~/.agenthub/claude-homes/<profile_name>/
```
This directory is automatically restricted with `0700` permissions (accessible only by the current OS user) and holds `.claude.json` configuration and `.credentials.json` authentication files.

### Adding and Authenticating Claude Profiles

1. **Via Web Dashboard (Recommended)**:
   - Navigate to **Profiles**, click **Add Profile**.
   - Select **Claude** as provider, enter a profile name (e.g., `claude-main` or `claude-work`), and choose the account type (`personal`, `team`, or `api_key`).
   - Click **Create & Login**. The dashboard opens an interactive PTY terminal and automatically submits `/login`.
   - Select your subscription tier (Claude Pro / Team / Enterprise).
   - Click the provided OAuth link to authenticate in your browser.
   - Copy the authorization code, paste it into the dashboard input, and click **Submit**.
   - Upon completion, the hub automatically detects the email address and transitions the profile status to **Logged In**.

2. **Via CLI**:
   ```bash
   # Create a new Claude profile
   agenthub profile add claude-main --engine claude

   # Start interactive login session
   agenthub profile login claude-main
   ```

### Automated Session Health Tracking
The system periodically validates session token health. Profile cards on the **Profiles** page display:
- **Logged In**: Displays the associated email address and connection status.
- **Not Logged In**: Indicates an expired session, providing a quick **Login** button.
- **Management Operations**: Supports **Check connection**, **Rename profile**, or **Delete profile** (with an option to preserve or delete the configuration directory).

---

## 6. Registering Projects (Adding a Project)

In AgentHub, a **project** represents a local git repository on your machine. When an AI worker (Gemini or Codex) receives a task, the hub automatically spins up an isolated git worktree (under branch `agenthub/<slug>`), allowing workers to implement changes safely without touching your active working directory or branch.

### 3 Steps to Add a Project:

1. **Prepare the repository**: Clone the repo onto your machine (if not already present). Ensure it is initialized as a git repository with a default branch (such as `main`).
2. **Register the project in AgentHub**:
   - **Bring an existing project into the hub**: Open **Projects**, launch the **registration wizard**, choose **Existing repository**, and enter an absolute path. AgentHub inspects branches, lockfiles, hooks, language, guidance files, and previous Claude Code sessions. Review the suggestions before creating; the **Advanced** form remains available for manual settings.
   - **Create a new project**: In the same wizard, choose **New project**. AgentHub creates the directory, runs `git init`, makes an empty initial commit, and creates the default branch before registering the project.
   - Always verify the path and base branch. An enabled integration branch is local-only: the hub merges locally and never pushes it automatically.
   - **Or via CLI**:
     ```bash
     agenthub project add <project_name> /absolute/path/to/git/repository
     ```
3. **Dispatch tasks**: After registration, you can dispatch tasks to workers via `/newtask` on Telegram, through chat with Claude on the Web Dashboard, or directly from the **Tasks** page.

### Configuration Fields in Registration Form:

- **Project Name**: Display name for the project (the system auto-derives the project ID from this name).
- **Git Repo Path**: Absolute path to the repository root directory on this machine. This directory must exist and must be a valid git repository.
- **Default Branch**: Base branch (default is `main`) that workers branch off from and merge back into after approval. The branch must exist in the repository.
- **Max Parallel Workers (`maxParallel`)**: Maximum number of concurrent tasks allowed for this project (default: 3).

### Advanced Settings (collapsed by default):

- **Environment Template (`envTemplate` - JSON format)**: Optional template used to generate isolated `.env` files per worktree, preventing port collisions or database conflicts when multiple workers run in parallel. Supported template placeholders:
  - `{slot}`: Worker slot number (1 through 9).
  - `{slug}`: Task slug identifier (e.g., `add-login`).
  - `{slug_underscored}`: Task slug with hyphens replaced by underscores (e.g., `add_login`).

  *Example `envTemplate`:*
  ```json
  {
    "PORT": "300{slot}",
    "DATABASE_URL": "postgresql://postgres:postgres@localhost:5432/myapp_t_{slug_underscored}"
  }
  ```

- **Automated Checks (`checks` - JSON array)**: Automated verification commands executed after a worker completes its task (e.g., `lint`, `test`):
  ```json
  [
    { "name": "lint", "cmd": ["npm", "run", "lint"] },
    { "name": "test", "cmd": ["npm", "test"] }
  ]
  ```

- **`onWorktreeRemoved` Hooks**: Cleanup commands executed after a worktree is removed (e.g., `docker exec my_postgres psql -U user -d postgres -c "DROP DATABASE IF EXISTS myapp_t_{slug_underscored}"`).
- **Automated Merge**: Configure an integration worktree per target branch and post-merge verification commands (e.g., `npm run lint`, `npm run typecheck`). When a task is approved with merge enabled, the hub automatically merges the task branch, runs verification checks, and reverts if conflicts or test failures arise.

> **Project Conventions**: Repositories should maintain an `AGENTS.md` file defining project conventions, testing instructions, and forbidden actions. Workers inspect this file before starting work.

---

## 7. Controlling the Hub: Web Dashboard, Telegram, and Claude Code in VS Code

You can control and coordinate AgentHub through three flexible channels:

### 7.1 Direct Chat on the Web Dashboard

The Web Dashboard chat panel allows you to interact directly with Claude Code without switching away from your browser:

1. Click **Chat** on the navigation bar or click the Brain icon.
2. **Model & Mode Selection**:
   - Model: `sonnet` (deep reasoning, ideal for complex task coordination) or `haiku` (fast responses, low quota consumption).
   - Mode: **Safe (`safe`)** (default — allows read-only inspections and safe MCP queries) or **Full (`full`)** (unrestricted execution rights; requires `chat.allowFullMode: true` in configuration).
3. **Session Management**:
   - The session drawer supports search, pinning key sessions, renaming, archiving, and deletion with confirmation dialogs.
   - **Export Markdown**: Download complete conversation histories as `.md` files.
   - Virtualized message rendering with smooth historical infinite scrolling (`before=`).
4. **Tool Permission Broker**:
   - When Claude needs to execute commands outside the safe catalog, an interactive permission dialog appears in the chat with three choices: **Allow**, **Always Allow** (persisted for matching commands throughout the session), or **Deny**.
   - The idle watchdog automatically pauses while waiting for your decision to prevent timeouts.
5. **Context Compression & Summarized Forks**:
   - **ContextMeter** visualizes live token usage against capacity.
   - **Compact Context** (`/compact`): Requests Claude to condense context to maintain long-running conversations.
   - **Fork with Summary** (`/fork-summary`): Claude summarizes the session outcome and initiates a fresh session with the summary as input context.
   - Auto-compaction: The system triggers automatic compaction when context usage exceeds `autoCompactPercent` (default: 85% of 200,000 tokens).

### 7.2 Control via Claude Code in VS Code (MCP)

If you prefer working within your IDE or terminal:

1. Register the AgentHub MCP server with Claude Code (one-time setup):
   ```bash
   agenthub mcp-install    # Runs: claude mcp add --scope user agenthub -- node .../dist/cli.js mcp
   ```
2. Open your project repository in **VS Code** and open the **Claude Code** panel.
3. Converse with Claude using natural language. Claude utilizes the following MCP tools:

| Tool | Purpose |
|---|---|
| `hub_status`, `hub_tasks`, `hub_task`, `hub_task_log` | Inspect hub status, list tasks, view details and stream logs |
| `hub_create_task`, `hub_update_task` | Create tasks (prompt, base branch, model, dependencies) or edit draft tasks |
| `hub_create_batch`, `hub_dispatch_batch` | Create multi-task batches with dependency graphs and dispatch them |
| `hub_review` | Approve (`approved`, with auto-merge if configured) or request changes (`changes_requested` + comments) |
| `hub_retry`, `hub_cancel` | Retry failed/blocked tasks or cancel tasks (`hub_cancel` requires a `reason`, shown on the task detail page) |
| `hub_wait` | Block and wait until tasks require review |
| `hub_projects`, `hub_register_project`, `hub_profiles`, `hub_mark_quota` | Manage projects, worker profiles, and record quota limits |
| `hub_git`, `hub_savings`, `hub_claude_usage`, `hub_brain` | Inspect git diffs, review token savings analytics, and monitor Claude usage |

Sample natural language prompts:
- *"Read docs/PLAN.md, break Phase 2 into small parallel tasks with dependencies, and submit them to the hub."*
- *"Check if any tasks are ready for review. Review and merge passing tasks, and send back failing ones with actionable error summaries."*
- *"Task X is taking longer than expected. Pull its execution log and diagnose the issue."*

If Claude Code is not installed, tasks can be created manually via the **Tasks → New Task** web interface or using `agenthub task add`.

---

## 8. Remote Control via Telegram

AgentHub integrates an official Telegram bot allowing you to monitor progress, review code diffs, approve permissions, and chat with Claude from your mobile device.

### Step 1: Create a Bot via @BotFather
1. Open Telegram and search for the verified **`@BotFather`** account.
2. Send the `/newbot` command.
3. Enter a display name for your bot (e.g., `MyAgentHubBot`).
4. Enter a unique username ending in `bot` (e.g., `my_agenthub_remote_bot`).
5. `@BotFather` returns your HTTP API Bot Token (e.g., `123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ`).

### Step 2: Configure the Token in AgentHub
- **Option A: Via Web Dashboard**:
  Go to **Settings**, scroll to **Telegram Bot**, paste the Bot Token, and click **Save Token**.
- **Option B: Via File**:
  ```bash
  mkdir -p ~/.agenthub/secrets
  echo "YOUR_BOT_TOKEN_HERE" > ~/.agenthub/secrets/telegram.token
  chmod 0600 ~/.agenthub/secrets/telegram.token
  ```
- **Configuration in `~/.agenthub/config.json`**:
  ```json
  {
    "telegram": {
      "enabled": true,
      "botTokenFile": "~/.agenthub/secrets/telegram.token",
      "allowedChatIds": [],
      "notify": {
        "reviewReady": true,
        "failed": true,
        "blocked": true,
        "quota": true,
        "fallback": true
      }
    }
  }
  ```

### Step 3: Device Pairing Flow
To ensure strict security, the bot only responds to paired and authorized chats:
1. Navigate to **Settings** on the Web Dashboard, locate the Telegram section, and click **Generate Pairing Code** (or call `POST /api/telegram/pair-code`).
2. The system generates a temporary 6-digit verification code (valid for 5 minutes).
3. Open your bot chat on Telegram, click **Start**, and send the 6-digit code (or type `/pair <code>`).
4. The bot confirms successful pairing and saves your `chatId` to the allowed list.

### Telegram Command Reference

| Command | Description |
|---|---|
| `/status` | View overall system health: active/queued tasks, CPU/RAM usage, disk headroom, and worker quota |
| `/tasks [status]` | Filter and list tasks (e.g., `/tasks review`, `/tasks running`, `/tasks failed`) |
| `/task <id>` | View task details: description, autocheck results, and dashboard direct link |
| `/log <id>` | Stream the latest 30 lines of the task execution log |
| `/approve <id>` | Approve a completed task (triggers auto-merge if project integration worktree is configured) |
| `/reject <id> <feedback>` | Reject task with review comments, sending it back to the worker for remediation |
| `/cancel <id>` | Cancel a running task (displays inline confirmation prompt) |
| `/retry <id>` | Re-run a failed or blocked task |
| `/pause` | Pause task scheduling (running tasks continue until completion) |
| `/resume` | Resume task scheduling |
| `/new` | Start a fresh conversational session with Claude |
| `/stop` | Abort the currently generating response from Claude |
| `/help` | Display command help and usage syntax |

*Note: `<id>` can be a short unique slug or full `project/slug` identifier.*

### Natural Conversation & Inline Approvals
- **Natural Messaging**: Any plain text message sent to the bot (without a `/` prefix) is forwarded directly to Claude (`telegram:<chatId>`). You can direct planning, ask for code explanations, or adjust tasks directly from your phone.
- **Interactive Permissions**: When Claude requests tool execution, the bot sends an inline authorization prompt with three buttons: **Allow**, **Always Allow**, and **Deny**.
- **Quick Action Buttons**: When a task completes automated verification (`reviewReady`), the Telegram notification includes inline action buttons: **Approve**, **Reject**, and **View Log**.

### Telegram Bot Security Architecture
- **Strict Chat Authorization**: Messages from unknown or unpaired Telegram users are rejected immediately (`🚫 You are not authorized to control this bot`) and logged as security warnings.
- **Secure File Permissions**: The bot token file is saved with strict `0600` permissions (read/write by owner only).
- **Token Redaction**: Bot tokens are never saved in the SQLite database, never logged to stdout/files, and never returned via the API (the API only returns `{ configured: true }`).

---

## 9. Claude Fallback Chain when Tokens are Exhausted

When your primary Claude account encounters rate limits (HTTP 429) or reaches usage limits, AgentHub activates the configured **Fallback Chain** in `brain.fallback` without interrupting ongoing development workflows:

### Supported Fallback Steps

1. **Switch Profile (`profile`)**:
   `{ "type": "profile", "profile": "claude-team" }`  
   Switches to another authenticated Claude profile (such as a secondary or Team account). If `profile` is omitted, the hub automatically finds and switches to any active logged-in profile.

2. **Downgrade Model (`model`)**:
   `{ "type": "model", "model": "haiku" }`  
   Temporarily shifts from `sonnet` to a lighter model (`haiku`) to preserve quota while continuing coordination.

3. **Anthropic API Key (`apiKey`) with Spending Safeguards**:
   `{ "type": "apiKey", "dailyCapUSD": 5 }`  
   Temporarily routes requests through direct Anthropic API access with a strict daily budget.

   > [!WARNING]
   > **API Key Cost Warning**: Unlike fixed-fee monthly subscriptions (Claude Pro / Team), Anthropic API keys charge per token (pay-as-you-go).
   > AgentHub protects you by **mandating a daily expenditure ceiling** (`dailyCapUSD`, e.g., 5 USD/day). When daily spending reaches this cap, the step is immediately locked and execution falls back to the next step in the chain.
   > The API key is stored securely in `~/.agenthub/secrets/anthropic.key` with `0600` permissions and is never exposed through web or API responses (which only return `apiKeyConfigured: true`).

4. **Codex CLI Reviewer / Engine (`engine`)**:
   `{ "type": "engine", "engine": "codex" }`  
   Activates OpenAI Codex CLI in read-only mode (`readOnly: true`) to conduct code reviews and provide coordination assistance.

5. **Wait for Quota Reset (`wait`)**:
   `{ "type": "wait" }`  
   Pauses Brain execution until Claude's next quota reset window (`resetAt`).

### Configuration Example in `~/.agenthub/config.json`

```json
{
  "brain": {
    "fallback": [
      { "type": "profile", "profile": "claude-team" },
      { "type": "model", "model": "haiku" },
      { "type": "apiKey", "dailyCapUSD": 5 },
      { "type": "engine", "engine": "codex" },
      { "type": "wait" }
    ]
  }
}
```

You can inspect the active fallback tier, daily expenditure, and step configuration on the **Settings** page of the Web Dashboard.

---

## 10. Task Lifecycle

`queued` → `running` (worker executes in dedicated worktree, committing changes incrementally) → worker generates `.agenthub/DONE` (or `.agenthub/BLOCKED`) → `checking` (hub runs automated test suites) → `review` → Claude or user **Approves & Merges** or **Requests Changes** (re-queues task with feedback) → `done`.

### Waiting Status Badges on Dashboard:
- **Waiting for parallel slot**: Project is at capacity for its `maxParallel` limit.
- **Waiting for idle profile**: All compatible worker profiles are busy.
- **Waiting for disk**: Worktree or Docker storage partition is below minimum safe threshold.
- **Waiting for model quota**: Associated account has exhausted its quota window.

---

## 11. Host Machine Protection (Recommended Settings)

Configure safety boundaries via the **Settings** page or `PUT /api/config`:

```json
{
  "load": { "enabled": true, "high": 16, "ok": 11, "minFreeMemGB": 1.5, "recoverAfterSec": 300 },
  "disk": {
    "minFreeGB": 3,
    "extraPaths": [{ "path": "/var/lib/docker", "minFreeGB": 1.5, "label": "Docker" }]
  },
  "defaultTimeout": 5400,
  "multiplePerProvider": false
}
```

- **Load Guard**: When CPU load exceeds `high` or free memory falls below `minFreeMemGB`, the scheduler throttles each project to a single active task. Normal scheduling resumes once load remains below `ok` for `recoverAfterSec`.
- **Disk Guard**: Prevents launching new tasks when free disk falls below `minFreeGB`. Monitor additional directories (such as Docker partitions) as needed.
- **Execution Watchdog & Stall Guard**: Enforces execution timeouts (`defaultTimeout`), detects infinite loops without git commits, and terminates stalled worker processes.

Workers and verification tasks run under low operating system scheduling priority (`nice` and `ionice` on Linux, `nice` on macOS), ensuring your primary IDE and browser remain responsive.

---

## 12. Honest Limitations & Operational Notes

- **Chat Permission Scope**: The chat interface defaults to Safe mode (`safe`). When Claude needs to execute commands, you must grant approval via the chat dialog or Telegram. To allow full automated execution without prompt interruptions, enable `chat.allowFullMode: true` in your configuration.
- **Reviewer Failover & Auto-Merge**: When Claude quota is exhausted and the system falls back to the Codex reviewer, tasks reviewed by Codex **are not automatically merged**. You must inspect and execute the merge manually.
- **Single-User Architecture**: AgentHub is designed for local, single-user operation. The Web Dashboard does not provide multi-tenant authentication or role-based access control.
- **Execution Privilege in Worktrees**: Workers execute with your local user privileges within their assigned worktree. Only register repositories you trust, and never place real production secrets in `.env` templates.
- **Docker Resource Protection**: Avoid running heavy `docker build` or `docker pull` commands within worker tasks on disks shared with system services, as exhausting disk capacity can destabilize local databases.

---

## 13. Quick Troubleshooting

| Symptom | Resolution |
|---|---|
| Dashboard blank or inaccessible | Check service status with `systemctl --user status agenthub` and view `~/.agenthub/logs/daemon.out` |
| Task stays in "waiting" status | Inspect the wait reason badge (Section 10). Check disk headroom, system load, and profile quota on the Dashboard |
| Machine slows down significantly | Lower `maxParallel` in project settings. Check for orphaned child processes on Dashboard (click "Clean Orphans") |
| Worker fails with missing dependencies | The hub automatically runs `npm install`/`pnpm install` during worktree initialization. Inspect the task's run log for details |
| Worker loops without committing | Cancel the task, refine the prompt to a narrower scope, and explicitly instruct incremental commits |
| Telegram bot not responding | Validate the token in `~/.agenthub/secrets/telegram.token` and verify device pairing on the Dashboard |

Additional Documentation:
- [Feature Catalog (docs/FEATURES.md)](../FEATURES.md)
- [Operational Guide (docs/USAGE.md)](../USAGE.md)
- [System Architecture & Plan (docs/PLAN.md)](../PLAN.md)
- [Project Overview & README (README.md)](../../README.md)

## 14. Post-merge self-deploy

Deploy steps are trusted configuration in `~/.agenthub/config.json` only; they are not accepted through the API/MCP. Example for the AgentHub repository:

```json
{
  "deploy": {
    "agenthub": {
      "steps": [["npm", "run", "build"], ["npm", "run", "build:web"], ["node", "scripts/install-web.mjs"]],
      "timeoutSec": 900,
      "restartHub": true,
      "push": {
        "remote": "origin",
        "from": "integration",
        "to": "main",
        "ffOnly": true,
        "minIntervalMin": 30
      }
    }
  }
}
```

Each step runs as argv in the integration worktree and is logged under `~/.agenthub/logs/deploy/<project>/<time>.log`. Push is disabled by default and is fast-forward-only when enabled.

### Integration worktrees for merge and deploy

AgentHub supports two types of integration worktrees:
1. **Hub-managed integration worktree (`settings.integration.enabled = true`)** (recommended):
   - Located at `<worktree.root>/.integration` (if `settings.worktree.root` is configured) or `~/.agenthub/integration/<projectId>`, checking out `settings.integration.branch` (defaults to `agenthub/integration`).
   - Used for both automated merging (`mergeTaskIntoBase`), executing merge-checks, and post-merge self-deployment.
   - AgentHub automatically manages lifecycle and dependency installation matching the task worktree policy (`worktree.install`: `auto` using cache/symlink or `npm ci`). If `package-lock.json` or lockfiles change in a merge commit, dependencies are automatically reinstalled before running merge-checks.
2. **Manually declared worktrees (`project.merge.worktrees`)** (legacy):
   - Explicit absolute paths configured per baseRef in project merge settings.
   - Used only when `settings.integration.enabled = false`. When `settings.integration.enabled = true`, the hub-managed worktree takes precedence and the legacy configuration is ignored.

To avoid overloading CI workflows during frequent merges, AgentHub supports **batched pushes** configured via `minIntervalMin` (defaults to 30 minutes):
- After a successful deploy, the hub only pushes to the remote if the time elapsed since the previous push is ≥ `minIntervalMin`.
- If the interval has not yet elapsed, the hub schedules a deferred push (executing git push without rebuilding) once the interval expires, batching all intermediate merges into a single push. The push schedule and last push timestamp persist across daemon restarts.
- Deploy status displays either `push lúc HH:MM` (pushed at HH:MM) or `push đang chờ tới HH:MM` (push scheduled for HH:MM).
- To push immediately without waiting for the timer, call `POST /api/projects/:id/deploy` with `{"pushNow": true}` or use the Telegram bot command `/deploy <project> push`.
- **Release requirement:** Prior to creating a release tag, you must trigger `pushNow` and confirm that `main == integration` to ensure the release contains all merged changes.

Rerun the entire deploy pipeline from the Projects page or via `/deploy <project>` in Telegram; `/deploy` without an argument shows the latest status.
