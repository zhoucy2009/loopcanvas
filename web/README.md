# LoopCanvas Web · dshwf-web

A local agent workflow workbench for **execution, learning, and exploration**, with independent review, per-step workflow rollback, live previews, UI-to-source tracing, visual geometry editing, and voice-directed agents.

The interface defaults to **English**. Switch to **中文** in **Settings → Interface language**; the browser remembers your choice. Switching does not restart tasks or translate project content.

## Install and run

Requires **Node.js 24+** and a configured local Codex or DeepSeek Harness runtime.

Download `dshwf-web-0.2.0.tgz` from the [GitHub release](https://github.com/zhoucy2009/loopcanvas/releases/tag/v0.2.0), then:

```sh
npm install -g ./dshwf-web-0.2.0.tgz
dshwf-web
```

The browser opens at `http://127.0.0.1:4317`. Options:

```sh
dshwf-web --no-open
dshwf-web --port 4318
```

While the repository is private, downloading the release requires repository access. The npm registry package is pending first publication; after publication, `npx dshwf-web@latest` will be available. Installing the release archive with npm works independently of registry publication.

From the repository:

```sh
cd web
npm ci
npm start
```

## Runtime setup

Open **Settings**, select **DeepSeek Harness** or **Codex App Server**, and click **Detect local agents**.

- For DeepSeek Harness, configure your harness with `npx @deepseek-ai/dsh web`. Leave the dsh executable path blank for discovery, or provide a full path. Select your model and reasoning effort. Keep smart routing disabled.
- For Codex, use your locally installed, signed-in CLI. The model catalog comes from the local App Server. Smart routing requires account access to the configured Sol, Terra, and Luna models; unavailable models produce an error rather than a silent substitution.
- Credentials stay with the runtime. The workbench does not import desktop-specific tools, approval forwarding, or conversation memory from Codex.

## Main capabilities

- **Agent workflow:** read-only planner, dependency graph, scoped executors, independent step reviewers, final deliverable judge, versioned context handoffs, and explicit direction/concurrency choices.
- **Per-step rollback:** each execution saves files and workflow state in an isolated Git worktree checkpoint. Rollback restores the existing pre-execution checkpoint, including uncommitted, untracked and ignored files, removes later additions, and creates no new checkpoint. The original repository’s Git metadata is preserved. Parallel batches and legacy continuous builds restore as a whole. Old checkpoints without file snapshots cannot be fully restored. Git must be installed.
- **Live preview:** inspect the current artifact next to the debug console. A new preview pauses automatic execution until you inspect or skip it.
- **UI → source → edit:** Cmd/Ctrl-click selects an element and traces its code. Submit targeted feedback to repair the originating step. Shift opens the visual layout editor; drag or resize anchored elements and confirm exact source updates.
- **Voice:** English and Chinese browser commands can call the planner, execute a numbered node, request step/final review, search, learn, preview, or roll back. State-changing actions retain confirmation. Browser speech support is required. An optional macOS helper provides Chinese on-device background wake words.
- **Learn:** import files/folders or public GitHub repositories, highlight source code for explanations, and keep separate follow-up conversations. Includes syntax, data-structure, and execution-flow modules.
- **Explore:** research technical or artistic topics with verifiable sources, project/global scope, and concurrent search tabs. Drag references between all three modes.
- **Custom instructions and skills:** edit project `AGENTS.md` and `宪法.md` for subsequent requests. Add `SKILL.md` folders to the global workspace's `.agents/skills/`, `~/.agents/skills/`, or `~/.codex/skills/`; inspect them in Capabilities. Skill execution depends on harness support.
- **Plugins:** bundled DeepSeek Harness presets and plugin manifests; supported overrides affect LoopCanvas calls without rewriting the user's dsh profile. Codex plugins are listed read-only.
- **Project management:** isolated workspaces, pins, rename/archive/restore, drafts, checkpoints, redacted call logs, and interrupted-request recovery.

For the full architecture and limitations, see the [technical overview](https://github.com/zhoucy2009/loopcanvas/blob/main/docs/technical-overview.md).

## Custom smart routing

Settings lets you choose a model and reasoning effort independently for planning, learning, research, step review and final review. Expand Execution and source tracing to configure build, integration/delivery, risk/verification and source tracing. Options come from the local Codex catalog and are validated both before saving and before each call. Global `codexRoleModels` settings apply to subsequent calls. Restore defaults and save to return to the original role assignments. Changing models preserves role responsibilities, read-only restrictions and independent review.

## Codex updates

Codex discovery compares installed CLI and desktop-bundle versions and uses the newest one (desktop bundle wins a tie). Explicit `LOOPCANVAS_CODEX_EXECUTABLE` overrides remain pinned. The web launcher checks for standalone Codex updates at startup and every six hours while running, using Codex's native noninteractive updater. Subsequent Agent calls pick up the updated version; existing calls are not restarted. Update failures are logged and retried at the next interval. Desktop bundles and package-manager installations remain managed by their own updaters. Set `LOOPCANVAS_CODEX_AUTO_UPDATE=0` to disable background updates. Reopening Settings refreshes the model catalog and preserves a still-available model and reasoning choice. Model availability remains determined by the signed-in Codex account.

## Data and security

Default data path: `~/Library/Application Support/LoopCanvasWeb/`. Default deliverables root: `~/Documents/LoopCanvas/Deliverables/`. Override with `LOOPCANVAS_DATA_DIR` and `LOOPCANVAS_WORKSPACE`.

Each project derives a separate workspace directory. Explicit workspace paths must already exist. State is saved in `state.json`; call logs and diagnostics are local. Logs may contain project text even after credential redaction. Attachments allow 25 MiB per file and 100 MiB per intake batch.

The admin service listens only on `127.0.0.1`; writes require its random session token. Artifact path validation does not replace the selected runtime's own command/file sandbox.

## Optional Remote control

The admin listener (default `127.0.0.1:4317`) must remain local. The separate restricted Remote listener defaults to `127.0.0.1:4321`. Only the restricted listener is a reverse-proxy target.

Remote is off by default. Enable it with a real public HTTPS base URL:

```sh
dshwf-web --remote --remote-url https://remote.example.com
```

Pair a phone from the Remote panel with a one-time QR code (expires in five minutes). Device sessions can be revoked. Commands enter a local approval queue; arbitrary shell text is not accepted.

Webhook configuration can be injected through these environment variables:

```text
LOOPCANVAS_REMOTE_ENABLED
LOOPCANVAS_REMOTE_URL
LOOPCANVAS_WECHAT_TOKEN
LOOPCANVAS_WECHAT_OPENIDS
LOOPCANVAS_WHATSAPP_APP_SECRET
LOOPCANVAS_WHATSAPP_VERIFY_TOKEN
LOOPCANVAS_WHATSAPP_NUMBERS
```

WeChat uses service/test-account text callbacks with signature checks and an OpenID allowlist; encrypted AES callback mode is not implemented. WhatsApp uses Cloud API webhook signatures, verification tokens, and a number allowlist; proactive outbound replies are not implemented. These integrations are not personal-account automation.

Safari Handoff remains managed by Apple. The workbench does not enumerate Apple ID devices or read browsing history.

## Development and publishing

```sh
npm ci
npm run check
npm test
npm pack
```

Packaging copies the repository's plugin manifests into the npm archive and removes the temporary copy afterward. To publish to the registry, authenticate locally with `npm login`, then run `npm publish` in this directory. Do not put registry credentials in the repository.
