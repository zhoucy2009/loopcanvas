# LoopCanvas 0.2.0 — technical overview

LoopCanvas is a local orchestration and inspection layer over Codex App Server and DeepSeek Harness. Its primary product is a browser workbench that joins agent execution, source-code learning, and public-source exploration.

## Workflow and role separation

The Node.js service owns workflow mutations and agent dispatch. The browser renders real project state instead of treating chat output as an authoritative execution engine. Smart routing builds a graph of 1–12 nodes, including a single-node graph for small tasks. Nodes declare dependencies, write scopes, risk, acceptance criteria, decisions, and results.

| Role | Current Codex route | Responsibility |
| --- | --- | --- |
| Planner | Sol high; xhigh when configured for the relevant planning phase | Read-only planning; no implementation or self-declared delivery |
| Executor | Luna high for low-risk builds; Terra high for integration/delivery; Sol low for higher-risk or verification nodes | Implement and verify the current node within its scope |
| Step reviewer | Sol high | Independently inspect evidence and return pass, repair, or blocked |
| Final judge | Sol xhigh | Check the original request, final artifact, and latest step reviews |
| Learning / research | Luna low, displayed as light | Explain material or research sources |
| Source tracer | Sol low | Locate source among supplied candidates using observable evidence |

These routes are implemented in `web/src/smart-routing.js`. Actual model availability comes from the user's Codex runtime/account. DeepSeek manual mode uses its configured model and does not impersonate the Codex role routes.

A versioned workflow context contract carries the original goal, hard constraints, delivery specification, transitive dependency results, explicit user decisions, and verification evidence. Roles use separate sessions and do not rely on implicit memory from another role. Executors cannot approve their own results. Direction questions pause affected nodes; independent, non-conflicting writes can be scheduled in parallel after an explicit choice.

## Checkpoints, rollback, and recovery

Fixed checkpoints are saved before decisions and significant execution. Each project retains up to 40. Restoring changes workflow state without consuming checkpoints or generating a new checkpoint merely for rollback. Reopening an upstream node reopens affected downstream state. Failed independent review can be retried without rerunning an already completed executor.

State rollback does not reverse filesystem writes. The product exposes rollback notes and repair paths; use version control when file-level restoration is required.

Atomic, serialized state writes avoid concurrent mutation loss. Project drafts and response ownership checks keep late responses from overwriting newer state or changing the active project. Runtime polling can reconcile a completed call when the original response is delayed. Refresh/recovery alone does not authorize another paid execution. Parallel calls settle as a group without discarding successful sibling results when another node fails.

## Preview, tracing, and source changes

The preview surface supports inline HTML, Markdown/text reading, and supported runtime previews. The main deliverable has a locked entry point and separate preview ownership; intermediate specifications and reports remain attached to their producing node. Preview viewport hints and a marked product root allow a canvas to fit the available window while long documents remain scrollable.

Cmd/Ctrl-click sends an element selection to source tracing. Stable DOM identifiers and registered object metadata provide deterministic anchors where possible; an agent can assess bounded source candidates when needed. The debug console presents local source, confidence, evidence, original requirements, and the responsible completed step. Targeted feedback reopens the relevant workflow location and repairs the same deliverable.

Shift enters geometry editing. Pointer handles and keyboard nudges change the live preview before confirmation. Exact bounds and source anchors are submitted to `web/src/geometry-edit.js` for source updates. Custom geometry adapters expose picking, commit behavior, and inspected interaction regions. Three.js raycasting metadata can map a rendered object back to an authored group. Unsupported transforms, missing anchors, stale source, or unacknowledged interaction regions block changes.

The full-source drawer is read-only. The product does not claim to be an unrestricted embedded source editor or to map every canvas object automatically.

## Voice and agent presence

Browser speech recognition selects `en-US` or `zh-CN` from the interface preference. Anchored command parsing recognizes explicit actions, optional wake phrases, and numbered steps; quoted mentions and negated commands do not become writing actions. Requests are associated with their project/step and processed in order. Writing and state-changing voice commands retain confirmation.

Users can address planning, execution, step review, or final review independently. New-task and gather actions update the interface without waiting for a running agent. Four lightweight agent indicators combine local requests with server-reported activity and retain the last known state during connection loss.

The optional Swift menu-bar helper uses Apple Speech with on-device recognition required. It recognizes Chinese wake words, reuses an existing workbench browser tab where supported, and submits an expiring one-time local wake event. It does not record audio to disk, send ordinary conversation transcripts to the harness, or wake a sleeping computer. Browser speech behavior is distinct and depends on the browser's implementation.

## Execute, Learn, Explore

Execution artifacts, code excerpts, and research sources share a transferable reference format. Users can drag a reference into learning for analysis or into execution as shared project context.

Learning supports project sources, explicitly imported local files/folders, and public GitHub repositories. Highlighting a fragment can request an explanation, and each fragment can become an independent follow-up conversation. File-level data-structure and execution-flow explanations include source ranges. Importing and browsing do not themselves invoke a model. Learning requests execute in temporary directories rather than the writable project workspace.

Exploration supports project-aware and global technical/art research with source credibility and project relevance. Each search tab owns its draft, pending request, result, error, and scroll position. Searches can complete in the background without selecting the tab. Search tools and verifiable sources are required; unavailable tools or missing sources produce a failure rather than a fabricated research record. Pinterest is an external search handoff, not a connected account or authoritative source.

## Skills, instructions, and plugins

`SKILL.md` discovery scans the global workspace's `.agents/skills/`, `~/.agents/skills/`, and `~/.codex/skills/`. Import consists of adding a skill folder to a supported location and refreshing the capability catalog. The selected harness determines whether and how it can execute the skill; catalog visibility is not universal runtime installation.

Project `AGENTS.md` and `宪法.md` documents are editable and injected into subsequent requests. They carry goals, constraints, operating rules, and project-level system instructions. The UI also edits the applicable workspace `AGENTS.md`. Internal role prompts, routing contracts, and review safeguards are application code rather than arbitrary settings fields.

Four DeepSeek Harness presets and 30 official plugin manifests describe purpose, capabilities, audience, and runtime applicability. Verified headless overrides are applied per LoopCanvas call; they do not rewrite the user's dsh profile. Plugin enablement is persisted locally. Custom manifests can override bundled IDs in the data directory. Codex plugins are shown read-only.

## Runtime transport and storage

- **Client:** vanilla HTML/CSS/ES modules; no framework or frontend bundling requirement. Authored UI text uses a bilingual catalog. Template chunks are translated before interpolation, leaving user content, source code, IDs, and URLs untouched. English is the default; the browser stores language choice.
- **Server:** Node.js 24+ HTTP service with localhost binding, Host validation, token-protected mutations, local state, artifact validation, and scoped source browsing.
- **Codex:** local stdio App Server transport, model discovery, isolated role sessions, and structured results. General desktop client-tool forwarding, approval forwarding, and full desktop session memory are not implemented. Image attachment support does not imply image-pixel input parity with the Codex desktop app.
- **DeepSeek:** local executable discovery and headless calls. Output streams to disk; parsing tolerates surrounding explanatory text and some incomplete JSON endings. A 256 MiB safety limit produces an explicit error.
- **Persistence:** schema-versioned multi-project `state.json`, per-project workspaces, redacted request/output records, diagnostics, and separate Remote state. The historical native app uses a separate data store.
- **Attachments:** images, PDFs, text, ordinary files, content deduplication, and reversible long-paste attachment conversion. Intake limits are 25 MiB per file and 100 MiB per batch.

## Optional Remote surface

The local admin API and restricted Remote listener are separate. Only the restricted listener is suitable for an explicitly configured HTTPS reverse proxy. One-time pairing codes expire after five minutes, device sessions are revocable, and incoming commands require local approval. WeChat and WhatsApp handlers verify signatures and sender allowlists. WeChat AES callback decryption and proactive WhatsApp replies are outside the current implementation.

## Packaging and validation

The Web app ships as an npm tarball with CLI, server, static assets, documentation, and bundled plugin manifests. `npm pack` produces the release artifact without including project state, credentials, node_modules, or local deliverables. GitHub Releases provide the tarball for installation using npm; registry publication requires the owner's npm authentication.

Validation includes JavaScript syntax checks and Node tests covering workflow contracts, dependency/review behavior, state recovery, preview/source boundaries, geometry edits, voice parsing/lifecycle, language interpolation, and runtime transports. Real model availability, paid model calls, microphone recognition quality, and native wake behavior still depend on the target machine and account.
