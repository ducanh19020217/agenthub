# AgentHub setup playbook for chat

This is Claude’s standard flow when the user asks to set up AgentHub. Ask one question at a time, offer short choices, and wait. The user may stop at any point and continue later.

## Rules

- Before every step call `hub_effective_config`; skip anything already configured unless the user asks to review it.
- Every write starts with `dryRun: true`. Show the diff, wait for confirmation, then repeat with `dryRun: false`.
- Never ask for, accept, print, or store secrets in chat. Use `hub_request_secret` and continue only after it reports that the secret was stored.
- On resume, reread effective configuration and do not repeat completed steps.

## Steps

1. **Check the machine.** Ask: “Check this machine now? (Yes / No, install automatically / Stop)” (default Yes). Call `hub_effective_config` and `hub_doctor`/`agenthub doctor`; verify Node 22, Git, Claude, Codex, agy, and the daemon. Continue only when the required tools and daemon are healthy.
2. **Install or update AgentHub.** Ask: “Install/update the official release? (Install release / Already installed / Stop)” (default Install when doctor fails). Use the release installer, then verify `agenthub --version`, `/health`, and the daemon.
3. **Register the project.** Ask: “Use a Git URL or an existing directory? (URL / Directory / Skip)” (default current Git repo). Clone only to a confirmed location, then call `hub_register_project`. Verify with `hub_projects`.
4. **Choose a preset.** Ask: “Which level? (safe / balanced / auto)” (default `balanced`). `safe` favors manual approval, `balanced` balances speed and control, and `auto` automates more when protective checks exist. Call `hub_apply_preset` dry-run, show the diff, then apply. For auto without checks, call discover with `kind: "checks"` first.
5. **Departments.** Ask: “Do you need departments? (No / Yes: …)” (default No). Keep everything in `chung` unless explicitly requested. Use department tools with dry-run and verify effective config.
6. **Brain and automatic approval.** Ask: “How should the brain run? (Suggest, I approve / Automatic with checks / Off)” (default Suggest). Apply configuration through dry-run. If automatic mode lacks checks, call discover `checks`, show suggestions, and confirm. Verify engine, model, permissions, reviewer, and checks.
7. **OpenProject.** Ask for the URL and project. Call discover `openproject`, then `hub_request_secret` for the key, discover again, show status mapping, and ask: “Confirm mapping and choose primary/secondary? (Confirm / Edit / Skip)”. Write only after dry-run confirmation; test read-only connectivity.
8. **Gitea.** Ask: “Which sync schedule? (12:00, 18:00 / Custom / Skip)” (default Skip). Discover `gitea`, request the token with `hub_request_secret`, dry-run URL/branches/schedule, then test read-only discovery. Never print the token.
9. **Remote deploy (optional).** Ask whether to enable it (default No). Request deploy secrets through `hub_request_secret`, dry-run commands/health checks/timeouts, validate URLs and commands, and never include secrets in the diff.
10. **Telegram (optional).** Ask whether to enable it (default No). Request the bot token through `hub_request_secret`, dry-run chat/topic settings, then send a test message only after confirmation.
11. **Final checks.** Ask whether to run them (default Yes). Re-read effective config, test enabled integrations, show a sync dry-run diff, run the AgentHub health check, and summarize configured items, missing secrets/checks, and how to resume.

## New machine

The user can say: “read `docs/setup/SETUP-PLAYBOOK.md` and install from `agenthub-setup.json`”. Claude should run `agenthub setup import <file> --dry-run`, compare projects/remotes/paths, and ask again only for missing secrets using `hub_request_secret`. After confirmation, run the real import. Paths under HOME are represented as `~`; never import another machine’s absolute private path.
