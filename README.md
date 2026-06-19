# pi-todo-sqlite

A durable, project-scoped todo tool for [pi](https://github.com/earendil-works/pi-mono), backed by a real SQLite database and mirrored into [context-mode](https://www.npmjs.com/package/context-mode) so your todos are searchable session memory.

Unlike the bundled session-based todo, state lives in `~/.pi/agent/todos.db` (via Node's built-in `node:sqlite`), so todos **persist across sessions** and are **scoped per project** (git root, else cwd).

## Install

```bash
pi install git:github.com/guru-irl/pi-todo-sqlite
```

This clones the package, registers it in your pi settings, and loads the `todo` tool plus the `/todos` viewer.

To update later:

```bash
pi update --extensions
```

## Features

- **`todo` tool** — actions: `list`, `add` (text), `toggle` (id), `clear`.
- **Durable** — stored in SQLite at `~/.pi/agent/todos.db`; survives restarts and new sessions.
- **Per-project** — todos are keyed by git root (falls back to cwd), so each repo has its own list.
- **`/todos` viewer** — interactive list of the current project's todos.
- **context-mode mirror** — after every change, the current project's list is re-indexed into context-mode under source `todos`, so `ctx_search` surfaces it. `context-mode index` replaces a source, so the mirror stays clean. Disable with `CTX_TODO_MIRROR=0`.

## Requirements

- **Node ≥ 22.5** — for the built-in `node:sqlite` module. The extension imports it at load; on older Node, pi logs a load error for this extension only and keeps everything else working.
- **context-mode** on `PATH` (optional) — only needed for the searchable mirror. Without it, the mirror step is silently skipped and SQLite remains the source of truth.

## How it works

- Source of truth: a single SQLite table keyed by `(project, id)`, with a per-project sequential id so you get friendly `#1`, `#2` references.
- The mirror writes the list to a temp markdown file and runs `context-mode index <file> --source todos --project <git-root>` (best-effort, non-blocking).

## License

MIT © guru-irl
