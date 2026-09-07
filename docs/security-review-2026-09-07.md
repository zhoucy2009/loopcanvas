# Public repository review — 2026-09-07

Scope: tracked files, new publication candidates, all Git branches and tags,
commit identity metadata, the existing v0.2.0 release archive and checksum,
a newly packed npm archive, and existing GitHub CI logs and repository surfaces.

## Findings and changes

- Gitleaks 8.30.1 initially reported two synthetic keys in diagnostic redaction
  tests. Both were inspected and allowlisted by exact value AND file path.
  Scans with that configuration found no other secrets in history or source.
  Both npm archives also passed scanning. Scanner downloads were checksum-verified.
- Added ignore rules for common credentials, runtime databases, workflow output,
  browser evidence, and local agent configuration. Application data should
  remain outside the checkout, including when overriding its default directory.
- Static preview documents now receive `sandbox allow-scripts` in their HTTP
  Content Security Policy, including secondary HTML files and direct navigation.
  This prevents generated scripts from sharing the admin page's origin.
- Preview file serving now resolves symlinks before checking the project boundary.
  Declaring a symlink in an artifact manifest cannot expose an outside file.
- Personal author email metadata is replaced with the owner's GitHub noreply
  identity; personal checkout paths are replaced with generic examples throughout
  rewritten history. The existing version tag follows its rewritten commit.
  Old CI records referencing the previous history are removed during publication.
- CI now scans full fetched history and source and checks npm vulnerability
  advisories. See [SECURITY.md](../SECURITY.md) for the trust model and commands.

## Validation

- `npm audit`: zero known vulnerabilities in the locked npm dependency graph.
- `npm run check` and `git diff --check`: passed.
- `LOOPCANVAS_TEST_BROWSER=1 npm test`: 295 passed, zero failures or skips.
  This includes a real isolated Chromium render and actual browser enforcement
  of the preview origin boundary, plus HTTP symlink escape regression coverage.
- `swift test`: 59 passed, zero failures.
- `npm pack`: completed; the resulting archive was independently scanned.

## Limits

The repository remains private after this update. These checks support source
publication; they do not certify an internet-facing service or prove the absence
of unknown vulnerabilities. External agent installations and optional Python
model runtimes are outside the npm dependency audit. Existing v0.2.0 binary
attachments are historical packages and do not include the current fixes.

Rewriting branches and tags cannot erase someone else's clone or independently
guarantee removal of GitHub's cached/unreachable objects. Do not merge old history
back into the cleaned repository; existing clones should be replaced or carefully
realigned. No live credentials were identified that require rotation.

The package remains `UNLICENSED`; this review does not select an open-source
license or establish redistribution rights for reference-derived artwork.
