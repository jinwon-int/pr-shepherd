# Security

Do not put GitHub tokens, OpenClaw secrets, SSH keys, or webhook secrets in config files, state files, logs, issues, or pull requests.

This tool is designed to fail closed:

- no plain `git push --force`
- `--force-with-lease` only
- no automatic repair for CI failures
- unsupported conflicts escalate to a human
- merged PRs disable future runs
- state and lock files should live outside the repository

Report security issues through the private `jinwon-int` operational channel.
