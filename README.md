# pi-todo-sqlite

A durable, project- and session-scoped todo tool for [pi](https://github.com/earendil-works/pi-mono), backed by a real SQLite database and mirrored into [context-mode](https://www.npmjs.com/package/context-mode) so your todos are searchable session memory.

Unlike the bundled session-based todo, state lives in `~/.pi/agent/todos.db` (via Node's built-in `node:sqlite`), so todos **persist across restarts**. Todos are **scoped per project** (git root, else cwd) **and per session**, so each session keeps its own list — and the AI can still **view** todos from other sessions to take over previous work.

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

- **`todo` tool** — actions:
  - `list` — the **current session's** todos.
  - `add` (text) / `toggle` (id) / `clear` — operate on the current session's list.
  - `sessions` — overview of every session in this project that has todos (id, name, done/total), so you can discover work to take over.
  - `view` (session) — **read-only** view of another session's todos. Pass a session id, id prefix, session name, or `"all"` to dump every session grouped.
- **Durable** — stored in SQLite at `~/.pi/agent/todos.db`; survives restarts.
- **Per-project + per-session** — todos are keyed by `(git root | cwd, session id)`, with a friendly per-session sequential id (`#1`, `#2`, …).
- **Takeover-friendly** — a new session starts empty, but `sessions` / `view` let the AI inspect and continue todos a previous session left behind.
- **`/todos` viewer** — interactive list of the current session's todos; press **`a`** to toggle an all-sessions view grouped by session.
- **context-mode mirror** — after every change, the project's **full list (all sessions, grouped)** is re-indexed into context-mode under source `todos`, so `ctx_search` surfaces todos from any session. `context-mode index` replaces a source, so the mirror stays clean. Disable with `CTX_TODO_MIRROR=0`.

## Requirements

- **Node ≥ 22.5** — for the built-in `node:sqlite` module. The extension imports it at load; on older Node, pi logs a load error for this extension only and keeps everything else working.
- **context-mode** on `PATH` (optional) — only needed for the searchable mirror. Without it, the mirror step is silently skipped and SQLite remains the source of truth.

## How it works

- Source of truth: a single SQLite table keyed by `(project, session, id)`, with a per-session sequential id so you get friendly `#1`, `#2` references. A companion `todo_sessions` table tracks each session's display name for the cross-session views.
- The session key is pi's session UUID (`sessionManager.getSessionId()`); ephemeral/in-memory contexts fall back to `(default)`.
- The mirror writes every session's list to a temp markdown file and runs `context-mode index <file> --source todos --project <git-root>` (best-effort, non-blocking).

## Migration

Upgrading from a pre-session version migrates automatically: existing rows are rebuilt under the `(legacy)` session and remain reachable via `todo view (legacy)` or the `/todos` all-sessions view. No data is lost.

## License

MIT © guru-irl
