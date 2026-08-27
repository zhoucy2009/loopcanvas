---
name: loopcanvas-ui
description: Design, review, or refine LoopCanvas product UI with a calm, efficient, low-fatigue visual system and restrained functional motion. Use for changes to web/public/index.html, web/public/styles.css, web/public/app-v2.js, UI components, layout, typography, color, interaction states, responsive behavior, accessibility, animation, or visual quality. Prioritize sustained professional use over decorative impact.
---

# LoopCanvas Quiet UI

Treat LoopCanvas as a serious workbench used for long sessions. Make the interface feel clear, fast, stable, and quietly polished. Do not optimize for demos, landing-page drama, or novelty.

## Priority order

Resolve every decision in this order:

1. Preserve correctness, safety, and accessibility.
2. Reduce time and attention needed to complete the task.
3. Reduce visual and motion fatigue during sustained use.
4. Improve hierarchy, consistency, and perceived quality.
5. Add delight only when it does not compete with work.

Let explicit user instructions and existing product constraints override this skill. Let this skill override generic advice to make a UI bolder, more cinematic, more animated, or more decorative.

## Establish evidence first

Before changing UI:

1. Inspect the existing HTML, CSS variables, interaction code, and relevant states.
2. Inspect the rendered interface when runtime behavior or visual appearance determines the result.
3. Identify the primary task, high-frequency controls, supported viewport, and current design conventions.
4. Separate verified observations from design hypotheses.
5. Prefer a small coherent correction over a broad restyle.

Do not introduce a framework, component library, animation package, font dependency, or build step unless the existing stack cannot meet a verified requirement and the user approves the added complexity.

## Visual direction

- Preserve a compact, calm working surface with clear hierarchy.
- Use one accent family per view. Reserve it for selection, focus, progress, and primary actions.
- Prefer tinted dark neutrals over pure black, and softened light text over pure white.
- Separate surfaces primarily through spacing, tone, and borders. Use shadows sparingly.
- Avoid nested cards, excessive rounding, large glows, decorative gradients, glass layers, and ornamental badges.
- Keep background effects static and subtle. Remove any effect that competes with content after several minutes.
- Keep icons simple and consistent. Do not use emoji as interface icons.
- Preserve density where it improves scanning; do not turn every group into a large padded panel.

System UI fonts are acceptable and often preferred for long-session product surfaces. Use distinctive display fonts only for rare brand moments, never for dense controls, logs, tables, or task text.

## Typography and information density

- Establish a small, explicit type scale and consistent line heights.
- Keep body and control text comfortably readable; avoid body text below 13px.
- Use weight, spacing, and tone before increasing font size.
- Keep line lengths moderate and align labels, values, and actions to a visible grid.
- Use tabular numerals for durations, counts, prices, percentages, and timestamps.
- Make secondary text quieter without dropping below accessible contrast.
- Prefer progressive disclosure to hiding essential context or flooding the screen.
- Preserve user context during refreshes, mode switches, and state changes.

## Motion policy

Animate only to explain state, preserve spatial continuity, confirm input, or prevent a jarring change. If the reason is merely “it looks good,” omit it on working surfaces.

| Frequency or event | Default treatment |
| --- | --- |
| Keyboard action or 100+ uses/day | Instant; no animation |
| Navigation, tabs, list selection, repeated hover | Instant or 80–120ms local feedback |
| Button press and state confirmation | 80–140ms, subtle opacity or scale |
| Tooltip and small popover | 120–180ms, only on first opening |
| Modal, drawer, or occasional context change | 160–220ms |
| Onboarding or rare success moment | Up to 260ms when it adds clarity |

- Keep ordinary interaction motion under 220ms.
- Animate `transform` and `opacity`; avoid layout and large paint animations.
- Never use bounce, elastic, parallax, cursor-following, or looping decorative motion in the core workflow.
- Never delay input, navigation, focus, or content availability until animation completes.
- Do not stagger repeated work items. If a rare reveal uses stagger, keep the total under 200ms and allow immediate interaction.
- Avoid animating blur and large `backdrop-filter` surfaces.
- Use CSS transitions for predictable UI states and the Web Animations API only when interruption or programmatic control is necessary.
- Keep loading indicators honest. Do not imply measurable progress without measurable progress.
- Pause nonessential animation when the document is hidden or the element is off-screen.

Always provide reduced-motion behavior. Do not rely on a global blanket rule alone; define a reduced-motion alternative next to each meaningful motion pattern. Remove position and scale motion while retaining brief opacity or color feedback when it aids comprehension.

## Interaction states

Implement and verify every state the affected control can enter:

- default, hover where supported, active, focus-visible, selected, disabled;
- loading, empty, success, warning, and error where applicable;
- narrow viewport, long text, large text, and overflow;
- keyboard-only and reduced-motion use.

Keep focus indicators visible and distinct from hover. Do not encode status using color alone. Put errors and recovery actions near the control that caused them. Preserve stable geometry where possible so state changes do not make the interface jump.

## Review and implementation workflow

1. State the primary user task and the visual or interaction problem.
2. Rank findings by task impact, repetition frequency, fatigue, and reach.
3. Define the smallest token or shared-rule changes that solve the systemic causes.
4. Implement in the existing vanilla HTML/CSS/JavaScript idiom.
5. Compare before and after at the same viewport and state.
6. Verify keyboard flow, visible focus, reduced motion, 200% zoom, 320px width, loading, empty, and error states relevant to the change.
7. Check that the result remains calm after repeated use, not just attractive in one screenshot.

For reviews, report verified issues with exact file locations. Distinguish visual evidence, source evidence, and unverified runtime behavior. Reject attractive changes that reduce scan speed, increase latency, weaken contrast, or add persistent visual competition.

## Completion standard

Finish only when:

- the primary task is faster or clearer;
- hierarchy works without decorative effects;
- repeated actions feel immediate;
- motion has a stated functional purpose and a reduced-motion alternative;
- keyboard, focus, contrast, zoom, overflow, and relevant states are verified;
- no unnecessary dependency or visual system was introduced;
- remaining uncertainty and untested states are reported explicitly.
