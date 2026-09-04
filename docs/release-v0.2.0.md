# LoopCanvas v0.2.0

A local workbench for agent workflows, live previews, source-level iteration, learning, and exploration.

## Highlights

- **English by default, Chinese on demand.** Settings now offers English / 中文 with immediate browser-persisted switching. Drafts and running tasks are retained; project text, source code, and agent output keep their original language.
- **Explicit agent workflows.** Read-only planning creates a real dependency graph. Scoped executors, independent step reviewers, and a final judge use separate roles and versioned context handoffs. Select sequential or parallel execution for eligible nodes.
- **Individual step rollback.** Reopen one node, revisit reusable checkpoints, recover interrupted results, or retry an independent review without rerunning successful execution. Rollback restores workflow state, not disk files.
- **Live preview and UI-to-source editing.** Inspect the current deliverable beside a persistent debug console. Cmd/Ctrl-click an element to trace its source and send targeted repair feedback. Press Shift to select, drag, or resize supported anchored objects; confirm exact geometry updates back to code.
- **Voice-directed agents.** English and Chinese browser commands support planning, numbered-step execution, step/final review, research, learning, preview, rollback, new requests, and gathering idle agents. Explicit state-changing actions retain confirmation. The optional macOS helper supports Chinese on-device background wake words.
- **Codex and DeepSeek Harness integration.** Codex App Server supports role routing with Sol, Terra, and Luna when available to the account. DeepSeek Harness retains its configured manual model workflow. Runtime credentials remain with each runtime.
- **Execute, Learn, Explore in one workspace.** Import local code or public GitHub repositories, explain highlighted code, continue snippet conversations, research technical/art topics across independent tabs, and drag references between modes.
- **Extensible skills and instructions.** Discover imported SKILL.md folders, edit project AGENTS.md and constitution instructions for subsequent calls, and enable supported bundled DeepSeek plugin overrides without rewriting the user's harness profile.
- **Local project and runtime management.** Isolated workspaces, pin/archive/restore, redacted call logs, runtime metrics, attachment intake, source boundaries, and optional locally approved Remote commands.

## Install with npm

Download the attached `dshwf-web-0.2.0.tgz`, then run:

```sh
npm install -g ./dshwf-web-0.2.0.tgz
dshwf-web
```

Requires Node.js 24+ and your own configured Codex or DeepSeek runtime. The CLI opens `http://127.0.0.1:4317` in your default browser. Add `--no-open` or `--port 4318` as needed.

The npm registry shortcut `npx dshwf-web@latest` remains pending the owner's npm authentication and first publication. This attached archive can already be installed using npm. Repository authorization is required while the repository remains private.

## Validation and boundaries

- JavaScript syntax checks passed.
- All 216 Node tests passed.
- Installed release archive and verified CLI startup, English shell, language assets, and 34 bundled plugin manifests.
- Browser checks covered English/Chinese switching, remembered preference, retained input, and a 320px settings layout without horizontal overflow.

No paid model execution or live microphone recording was needed for these checks. Model availability and native wake behavior depend on the user's account, browser, and machine. The optional native helper is source-only in this release; local ad-hoc builds are not notarized installers.

Full details: [README](https://github.com/zhoucy2009/loopcanvas#readme), [technical overview](https://github.com/zhoucy2009/loopcanvas/blob/main/docs/technical-overview.md), and [Web setup](https://github.com/zhoucy2009/loopcanvas/blob/main/web/README.md).
