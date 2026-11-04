# Contributing to SignaVis

Thanks for your interest in contributing! Issues and pull requests are welcome on
[GitHub](https://github.com/LimitlessGreen/SignaVis).

## Getting started

See [DEVELOPER.md](DEVELOPER.md) for the full local setup (install, git hooks, versioning,
release process, Tauri desktop build).

```bash
npm ci
npm run dev          # Vite dev server, labeling app at /demo/labeling-app.html
npm run typecheck
npm test
```

## Before opening a pull request

- Run `npm run typecheck` and `npm test` locally (also enforced by the `pre-push` git hook).
- Keep changes focused and add/update tests where it makes sense.
- Update [CHANGELOG.md](CHANGELOG.md) for user-facing changes.
- Follow the existing code style; there is no separate linter config beyond `tsc`.

## Reporting issues

Please include steps to reproduce, expected vs. actual behavior, and browser/OS/Node
versions where relevant. For bugs in the desktop (Tauri) app, include the OS and
installer version.

## License

By contributing, you agree that your contributions will be licensed under the
project's [AGPL-3.0 license](LICENSE).
