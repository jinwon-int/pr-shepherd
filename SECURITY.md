# Security

Do not put GitHub tokens, OpenClaw secrets, SSH keys, or webhook secrets in config files, state files, logs, issues, or pull requests.

This tool is designed to fail closed:

- no plain `git push --force`
- `--force-with-lease` only
- no automatic repair for CI failures
- unsupported conflicts escalate to a human
- merged PRs disable future runs
- state and lock files should live outside the repository

Report security issues by opening a minimal maintainer-contact issue with no sensitive details, or by using an already established private maintainer channel. Share secrets, exploit details, or private logs only after a private route is confirmed.


## Visibility and release boundary

Public source visibility, release/tag/package publication, production deployment, provider or Telegram sends, database mutation, credential movement, and history rewrite are separate approval-gated actions.
