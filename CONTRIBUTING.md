# Contributing to claude-rotator

Thanks for your interest in this project. A quick heads-up: `claude-rotator`
is maintained on a best-effort basis as a personal/small project — there's no
guaranteed SLA for triage, review, or fixes. That said, issues and pull
requests are genuinely welcome.

## Development Setup

- Node.js `>=18.10.0` (see `engines` in [package.json](./package.json)).
- Clone the repo and you're ready to go:

  ```bash
  git clone https://github.com/taskbrain/claude-rotator.git
  cd claude-rotator
  ```

  There is no `npm install` step. [package.json](./package.json) has no
  `dependencies` and no `devDependencies` — the project only uses Node's
  standard library, so the working tree is runnable as-is.

## Running Tests and Lint

The canonical check is:

```bash
npm run check
```

which runs `npm run lint` (`node scripts/lint.js`) followed by `npm test`
(`node --test`). You can also run either step on its own:

```bash
npm test
npm run lint
```

### Keychain-touching tests (opt-in)

Some tests in `test/secret-store.test.js` and
`test/native-claude-refresher.test.js` exercise the real macOS Keychain and
are **skipped by default**. They only run when
`CLAUDE_ROTATOR_REAL_KEYCHAIN=1` is set:

```bash
CLAUDE_ROTATOR_REAL_KEYCHAIN=1 npm test
```

CI enables this automatically on the macOS job (see
[`.github/workflows/ci.yml`](.github/workflows/ci.yml)), but Ubuntu runs
without it since `security` doesn't exist there. If you set this locally on
macOS, be aware it **writes to your actual login Keychain** and may pop up a
Keychain authentication dialog. Only opt in if you understand and accept
that.

### What CI verifies

GitHub Actions runs `npm run check` on the matrix `ubuntu-latest` /
`macos-latest` × Node `20` / `22`. That matrix is the source of truth for
cross-platform correctness — you don't need to reproduce all four
combinations locally before opening a PR.

## Submitting a Pull Request

1. Fork the repo, create a branch, and open a PR against `main`.
2. **Keep each PR focused on one purpose.** This project's convention is one
   branch / one PR / one goal — please avoid bundling unrelated fixes or
   refactors into the same PR.
3. Before opening the PR, please make sure `npm run check` passes locally.
4. Commit messages follow a Conventional-Commits-style prefix, e.g.
   `fix(scope): ...`, `feat: ...`, `docs: ...`, `test: ...`, `chore: ...`.
   The description after the prefix can be in **either Japanese or English**
   — both appear throughout the history — so write it in whichever language
   you're comfortable with.

## Filing an Issue

For bug reports, please include:

- Your OS and version (macOS or Linux, with version)
- Your Node.js version
- The output of `claude-rotator doctor`
- Steps to reproduce

**Important: never paste OAuth access/refresh tokens, the contents of
`~/.claude/.credentials.json`, or actual Keychain item values into an issue,
PR, or log attachment.** If you attach logs, mask any token-like strings
first. This matches the policy in [SECURITY.md](./SECURITY.md).

If you believe you've found a security vulnerability rather than a regular
bug, please do not open a public issue — use the private reporting flow
described in [SECURITY.md](./SECURITY.md) instead.

## Language

Issues and PRs can be written in **Japanese or English** — either is fine.
The maintainer is a native Japanese speaker, and the code and docs in this
repo are bilingual.

## A Note on AGENTS.md

You may notice an `AGENTS.md` file in this repo. It documents internal
conventions for AI coding agents used by the maintainer's team and is not
something external contributors need to follow.
