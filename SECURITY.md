# Security

LoopCanvas is a local, single-user workbench. Publishing this repository does
not make the admin server suitable for internet-facing or multi-user hosting.
Keep the admin listener on loopback. Only expose the separately authenticated
Remote listener when explicitly configured with HTTPS and device/channel access.

Agents and imported workflows can run commands and edit files with the access
granted to their runtime. Review imported instructions and use workspaces and
runtime permissions appropriate to the task. Runtime previews execute project
code; they are not an operating-system sandbox.

Never commit runtime authentication, environment secrets, recordings, uploads,
conversation histories, databases, browser evidence, or generated deliverables.
The default application data directory is outside this repository. If you
override it with `LOOPCANVAS_DATA_DIR`, keep that directory outside the checkout.
Git ignore rules help with common local files but do not remove tracked files
or replace a secret scan.

## Checks before sharing

Run Gitleaks 8.30.1 or later from the repository root:

```sh
gitleaks git . --log-opts=--all --config .gitleaks.toml --redact
gitleaks dir . --config .gitleaks.toml --redact
cd web
npm audit --audit-level=low
npm run check
npm test
```

CI scans the full fetched history and working tree and checks npm advisories.
Only two exact, synthetic redaction-test values are allowlisted; their files
remain scanned. Inspect release archives separately from Git history. A clean
scan means no detected secrets or known dependency advisories at that time;
it does not establish that the software has no vulnerabilities.

## Reporting

Report suspected vulnerabilities privately to the repository owner through
GitHub's private vulnerability reporting feature when available. Do not include
live credentials or private user data in public issues. If a secret was exposed,
revoke or rotate it before attempting history cleanup.

## Licensing

The package currently declares `UNLICENSED`. Public visibility alone does not
grant an open-source license. Third-party tools, models, and reference-derived
artwork retain their respective rights and terms.
