# LoopCanvas

**Plan, execute, inspect, learn, and explore in one local agent workbench.**

LoopCanvas turns a goal into an agent workflow with explicit dependencies, independent reviews, reusable checkpoints, and a live preview. Select a specific agent or step, inspect the result, trace a UI element back to its source, and continue editing the same deliverable.

The browser interface opens in **English** by default. Choose **English / 中文** in **Settings → Interface language**. The preference is saved in your browser and applies immediately without restarting the service, resubmitting tasks, or translating your project content.

[中文说明](README.zh-CN.md) · [Technical overview](docs/technical-overview.md) · [Web setup and operations](web/README.md) · [Releases](https://github.com/zhoucy2009/loopcanvas/releases)

## Get started

Requirements: **Node.js 20+**, npm, and a configured local **Codex** or **DeepSeek Harness** runtime. Agent usage is handled by your runtime account.

### Install the release with npm

Download `dshwf-web-0.2.0.tgz` from the [v0.2.0 release](https://github.com/zhoucy2009/loopcanvas/releases/tag/v0.2.0), then run:

```sh
npm install -g ./dshwf-web-0.2.0.tgz
dshwf-web
```

Or, using the GitHub CLI:

```sh
gh release download v0.2.0 --repo zhoucy2009/loopcanvas --pattern 'dshwf-web-*.tgz'
npm install -g ./dshwf-web-0.2.0.tgz
dshwf-web
```

Repository access is required while this repository is private. The release archive is an npm package with the Web UI and bundled plugin manifests; it does not require a Swift build.

The launcher opens your default browser at `http://127.0.0.1:4317`. To use another port or avoid opening a browser:

```sh
dshwf-web --port 4318 --no-open
```

### Run from source

```sh
git clone https://github.com/zhoucy2009/loopcanvas.git
cd loopcanvas/web
npm ci
npm start
```

### npm registry entry

The package name is **`dshwf-web`**. Registry publication is pending the owner's npm login and first publish. Until then, use the release archive or source installation above. Once published, the registry shortcut is:

```sh
npx dshwf-web@latest
```

### Connect an agent

Open **Settings**, choose a runtime, and use **Detect local agents** to check the installation.

- **Codex App Server:** uses your locally installed, signed-in Codex runtime over stdio. Model choices are read from its catalog. Enable smart routing for separate planner, executor, reviewer, and final judge sessions.
- **DeepSeek Harness:** configure your own harness, for example with `npx @deepseek-ai/dsh web`, then leave the executable path blank for detection or enter its full path. Keep smart routing disabled for the DeepSeek manual-model workflow.

LoopCanvas does not ask for or store your runtime API keys. Connecting Codex does not automatically import the Codex desktop app's tools, approvals, or conversation memory.

## What makes LoopCanvas different

### An explicit agent workflow

Smart routing creates a real graph of **1–12 nodes**, even for a one-step task. The planner works read-only, executors operate within each node's write scope, independent reviewers check the evidence, and a final judge checks the complete deliverable against the original request. A versioned handoff contract carries requirements, user decisions, dependency results, and acceptance criteria between roles.

Dependencies determine execution order. Independent nodes with non-conflicting write scopes can run in parallel after your choice. Direction decisions pause the affected nodes for your answer. Global and per-node caution levels control how much verification is requested.

### Roll back each step independently

Reopen or roll back a specific node, revisit a checkpoint, retry a failed execution, or retry only its independent review while retaining an already generated result. Downstream workflow state is reopened when an upstream decision changes. Checkpoints remain reusable: restoring one does not consume it or generate another rollback checkpoint.

**Rollback restores LoopCanvas workflow state. It does not automatically restore files already written to disk.** Use the recorded rollback instructions or your version-control system for file recovery. Up to 40 checkpoints are retained per project.

### A live preview beside the workflow

Inspect HTML and supported runtime previews alongside a persistent debug console. New previewable results pause automatic execution for inspection or an explicit skip. Markdown and text artifacts are readable in the workbench. Intermediate reports remain attached to their nodes; the primary deliverable keeps its own preview and entry point.

### From UI to source, and back to the preview

- **Cmd-click on macOS / Ctrl-click elsewhere:** select a UI element, locate the corresponding source fragment, inspect the evidence and originating step, and submit a targeted change request. The agent repairs the same deliverable and returns to preview.
- **Press Shift:** enter the visual layout editor. Select an anchored element, drag or resize it, preview the geometry immediately, and confirm to write the exact change back to source.
- Stable element anchors support deterministic DOM tracing. Registered geometry adapters support custom canvas / Three.js objects and associated interaction regions. Unsupported transforms or missing anchors stop the edit instead of silently guessing.

The source drawer is read-only. Code changes are made through targeted feedback or the confirmed geometry editor.

### Voice commands and individual agent dispatch

Browser speech recognition follows the selected interface language and routes explicit commands to supported actions. Examples:

| Say | Action |
| --- | --- |
| `Plan a dashboard` / `帮我策划一个看板` | Plan a goal |
| `Execute step 3` / `执行第三步` | Run one selected workflow node |
| `Review step 3` / `审核第三步` | Invoke the step reviewer |
| `Final review` / `最终审核一下` | Invoke the final judge |
| `Search for state machines` / `帮我搜状态机` | Open a research request |
| `Learn about closures` / `我需要学闭包` | Open learning with a topic |
| `Open preview` / `打开预览` | Inspect the current artifact |
| `Roll back to step 3` / `回退到第三步` | Restore node workflow state |
| `New task` / `开一个新需求` | Start a separate request |
| `Gather` / `集合` | Gather idle agent indicators |

Say `plan`, `execute`, or `review`, optionally after `hey`, to address that role directly. Execution and state-changing voice actions retain their confirmation flow. The four agent indicators show intake, planning, execution, and review activity; gathering idle agents does not interrupt working agents.

An optional **LoopCanvas Wake** macOS menu-bar app supports Chinese on-device wake words even when the Web page is closed. It requires microphone and Speech permissions and is built separately. Browser recognition availability and processing depend on the browser; the native helper requires on-device recognition. See [macOS wake setup](docs/macos-wake.md).

### Execute, Learn, Explore

**Execute** manages the goal, graph, changes, acceptance, and delivery. **Learn** opens local files, imported code folders, and public GitHub repositories; highlight code for an explanation or continue a conversation about the same snippet. Modules cover explanation, syntax, data structures, and execution flow. **Explore** researches technical and artistic topics using public sources, with project-aware or global scope, source credibility, and multiple concurrent search tabs.

Drag artifacts, code snippets, and research references between modes. Imported learning materials are read-only, and learning/research agent requests run in temporary directories rather than the project's writable workspace. Browsing source files does not itself submit an agent call; explanations and research consume runtime usage.

### Bring your skills and update your instructions

Import a skill by placing its folder and `SKILL.md` in `<global workspace>/.agents/skills/`, `~/.agents/skills/`, or `~/.codex/skills/`. Open **Capabilities → Skills** to inspect discovered skills. Actual execution depends on the selected harness and its skill/plugin support; discovery alone does not install a skill into every runtime.

Edit **Project instructions** to update the project's `AGENTS.md` and `宪法.md` instruction documents. They are injected into subsequent harness requests, so goals, constraints, and operating rules can evolve without rebuilding the application. **Capabilities → AGENTS.md** also exposes the applicable workspace instruction file. These are user-editable instructions; internal routing contracts and review safeguards remain application logic.

The package includes four DeepSeek Harness agent presets and 30 plugin manifests. Supported plugin overrides apply to subsequent LoopCanvas dsh headless calls without rewriting your `~/.dsh` profile. Local Codex plugins are also visible as a read-only catalog.

## Local architecture and operational features

- Vanilla HTML/CSS/JavaScript client, Node.js HTTP server, and local JSON persistence; no frontend build step.
- Per-project workspaces, rename/pin/archive/restore, independent agent sessions, persistent drafts, and recovery after interrupted requests.
- Redacted request/output logs, decision history, verification evidence, runtime activity, and usage metrics when supplied by the runtime.
- Image, PDF, text, and file attachments: 25 MiB per file, 100 MiB per intake batch, with content deduplication and long-paste conversion.
- Local admin service bound to `127.0.0.1`, localhost Host checks, session-token-protected writes, and artifact/source path validation.
- Optional Remote listener for one-time QR pairing, revocable browser-device sessions, and allowlisted WeChat/WhatsApp webhook commands with local approval. Remote is disabled by default.
- Optional macOS SwiftUI application and menu-bar wake helper; the Web workbench is the primary entry point.

The workbench's path validation is an application boundary, not an operating-system sandbox. Runtime isolation and tool access depend on the selected harness. See the [technical overview](docs/technical-overview.md) for implementation details and supported boundaries.

## Development and release

```sh
cd web
npm ci
npm run check
npm test
npm pack
```

The package lifecycle includes bundled plugin manifests in the archive. Release artifacts are attached to GitHub Releases. For npm registry publication, the owner runs `npm login` and `npm publish` from `web/` after verification.

Native builds require macOS and Swift; `swift test` requires an Xcode installation that includes XCTest. The current app packaging scripts produce local ad-hoc-signed builds, not notarized public installers.
