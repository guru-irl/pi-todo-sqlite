/**
 * todo-sqlite — durable, project- and session-scoped todo tool for pi.
 *
 * Unlike the bundled session-based todo, state lives in a real SQLite database
 * (~/.pi/agent/todos.db, via Node's built-in node:sqlite), so todos persist
 * across restarts. Todos are scoped per project (git root, else cwd) AND per
 * session, so separate sessions keep separate lists. The AI can still VIEW
 * todos from other sessions (action "view"/"sessions") to take over work
 * started in a previous session.
 *
 * Optional context-mode mirror (on by default; CTX_TODO_MIRROR=0 to disable):
 * after every change the current project's full list (all sessions, grouped) is
 * (re)indexed into context-mode under source "todos", so `ctx_search` surfaces
 * your todos as searchable memory. `context-mode index` replaces a source, so
 * this stays clean.
 *
 * Registers:
 *   - `todo` tool   (actions: list | add | toggle | clear | sessions | view)
 *   - `/todos` command (interactive viewer; press "a" to toggle all sessions)
 */

import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface Todo {
	id: number;
	text: string;
	done: boolean;
}

interface SessionSummary {
	session: string;
	name?: string;
	total: number;
	done: number;
	current: boolean;
}

interface SessionGroup {
	session: string;
	name?: string;
	current: boolean;
	todos: Todo[];
}

interface TodoDetails {
	action: "list" | "add" | "toggle" | "clear" | "sessions" | "view";
	project: string;
	session: string;
	todos: Todo[];
	sessions?: SessionSummary[];
	groups?: SessionGroup[];
	error?: string;
}

const MIRROR = process.env.CTX_TODO_MIRROR !== "0";

// Rows migrated from the pre-session schema land under this sentinel session.
const LEGACY_SESSION = "(legacy)";
// Used when no session id is available (e.g. ephemeral/in-memory contexts).
const FALLBACK_SESSION = "(default)";

// --- storage -------------------------------------------------------------
const DB_PATH = join(homedir(), ".pi", "agent", "todos.db");
mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
const db = new DatabaseSync(DB_PATH);

const tableInfo = (table: string): Array<{ name: string }> => {
	try {
		return db.prepare(`PRAGMA table_info(${table})`).all() as any[];
	} catch {
		return [];
	}
};

// Create fresh / migrate the todos table to the project+session schema.
const initSchema = (): void => {
	const cols = tableInfo("todos");
	const exists = cols.length > 0;
	const hasSession = cols.some((c) => c.name === "session");

	if (exists && !hasSession) {
		// Migrate the legacy (project, id) schema → (project, session, id).
		// SQLite can't change a primary key in place, so rebuild the table and
		// park existing rows under LEGACY_SESSION (still viewable via "view").
		db.exec("BEGIN");
		try {
			db.exec("ALTER TABLE todos RENAME TO todos_legacy");
			db.exec(`
				CREATE TABLE todos (
					project    TEXT    NOT NULL,
					session    TEXT    NOT NULL,
					id         INTEGER NOT NULL,
					text       TEXT    NOT NULL,
					done       INTEGER NOT NULL DEFAULT 0,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					PRIMARY KEY (project, session, id)
				);
			`);
			db.prepare(
				`INSERT INTO todos (project, session, id, text, done, created_at, updated_at)
				 SELECT project, ?, id, text, done, created_at, updated_at FROM todos_legacy`,
			).run(LEGACY_SESSION);
			db.exec("DROP TABLE todos_legacy");
			db.exec("COMMIT");
		} catch (e) {
			db.exec("ROLLBACK");
			throw e;
		}
	} else if (!exists) {
		db.exec(`
			CREATE TABLE todos (
				project    TEXT    NOT NULL,
				session    TEXT    NOT NULL,
				id         INTEGER NOT NULL,
				text       TEXT    NOT NULL,
				done       INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY (project, session, id)
			);
		`);
	}

	// Display-name metadata per (project, session), refreshed on every call so
	// the cross-session viewer can show friendly session names.
	db.exec(`
		CREATE TABLE IF NOT EXISTS todo_sessions (
			project    TEXT NOT NULL,
			session    TEXT NOT NULL,
			name       TEXT,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (project, session)
		);
	`);
};

initSchema();

const projectKey = (cwd: string): string => {
	try {
		return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: ["ignore", "pipe", "ignore"] })
			.toString()
			.trim() || cwd;
	} catch {
		return cwd;
	}
};

const rememberSession = (project: string, session: string, name?: string): void => {
	db.prepare(
		`INSERT INTO todo_sessions (project, session, name, updated_at) VALUES (?,?,?,?)
		 ON CONFLICT(project, session) DO UPDATE SET
		   name = COALESCE(excluded.name, todo_sessions.name),
		   updated_at = excluded.updated_at`,
	).run(project, session, name ?? null, Date.now());
};

const sessionName = (project: string, session: string): string | undefined => {
	const r = db.prepare("SELECT name FROM todo_sessions WHERE project = ? AND session = ?").get(project, session) as any;
	return r?.name ? String(r.name) : undefined;
};

const listTodos = (project: string, session: string): Todo[] =>
	(db.prepare("SELECT id, text, done FROM todos WHERE project = ? AND session = ? ORDER BY id").all(project, session) as any[]).map(
		(r) => ({ id: Number(r.id), text: String(r.text), done: !!r.done }),
	);

const addTodo = (project: string, session: string, text: string): Todo => {
	const now = Date.now();
	const row = db.prepare("SELECT COALESCE(MAX(id),0) AS m FROM todos WHERE project = ? AND session = ?").get(project, session) as any;
	const id = Number(row.m) + 1;
	db.prepare("INSERT INTO todos (project,session,id,text,done,created_at,updated_at) VALUES (?,?,?,?,0,?,?)").run(
		project,
		session,
		id,
		text,
		now,
		now,
	);
	return { id, text, done: false };
};

const toggleTodo = (project: string, session: string, id: number): Todo | undefined => {
	const cur = db.prepare("SELECT done FROM todos WHERE project = ? AND session = ? AND id = ?").get(project, session, id) as any;
	if (!cur) return undefined;
	const done = cur.done ? 0 : 1;
	db.prepare("UPDATE todos SET done = ?, updated_at = ? WHERE project = ? AND session = ? AND id = ?").run(
		done,
		Date.now(),
		project,
		session,
		id,
	);
	const t = db.prepare("SELECT id,text,done FROM todos WHERE project = ? AND session = ? AND id = ?").get(project, session, id) as any;
	return { id: Number(t.id), text: String(t.text), done: !!t.done };
};

const clearTodos = (project: string, session: string): number => {
	const c = db.prepare("SELECT COUNT(*) AS n FROM todos WHERE project = ? AND session = ?").get(project, session) as any;
	db.prepare("DELETE FROM todos WHERE project = ? AND session = ?").run(project, session);
	return Number(c.n);
};

// All sessions in this project that have todos, most-recently-active first.
const listSessions = (project: string, current: string): SessionSummary[] =>
	(
		db
			.prepare(
				`SELECT t.session AS session, COUNT(*) AS total, SUM(t.done) AS done, s.name AS name, MAX(t.updated_at) AS last
				 FROM todos t
				 LEFT JOIN todo_sessions s ON s.project = t.project AND s.session = t.session
				 WHERE t.project = ?
				 GROUP BY t.session
				 ORDER BY last DESC`,
			)
			.all(project) as any[]
	).map((r) => ({
		session: String(r.session),
		name: r.name ? String(r.name) : undefined,
		total: Number(r.total),
		done: Number(r.done),
		current: String(r.session) === current,
	}));

// Resolve a user-supplied session selector (exact id, prefix, or name) to a
// concrete session key. Returns undefined if nothing matches.
const resolveSession = (project: string, selector: string): string | undefined => {
	const sessions = listSessions(project, "");
	const exact = sessions.find((s) => s.session === selector);
	if (exact) return exact.session;
	const byName = sessions.find((s) => s.name && s.name.toLowerCase() === selector.toLowerCase());
	if (byName) return byName.session;
	const prefix = sessions.filter((s) => s.session.startsWith(selector));
	if (prefix.length === 1) return prefix[0].session;
	return undefined;
};

const groupAllSessions = (project: string, current: string): SessionGroup[] =>
	listSessions(project, current).map((s) => ({
		session: s.session,
		name: s.name,
		current: s.current,
		todos: listTodos(project, s.session),
	}));

const shortId = (session: string): string =>
	session === LEGACY_SESSION || session === FALLBACK_SESSION ? session : session.slice(0, 8);

const sessionLabel = (s: { session: string; name?: string; current?: boolean }): string => {
	const id = shortId(s.session);
	const base = s.name ? `${s.name} (${id})` : id;
	return s.current ? `${base} ← current` : base;
};

// --- context-mode mirror (best-effort, non-blocking) ---------------------
// Mirrors the WHOLE project (every session, grouped) so ctx_search can surface
// todos from any session — handy when taking over previous work.
const mirror = (project: string): void => {
	if (!MIRROR) return;
	try {
		const groups = groupAllSessions(project, "");
		let body = `# TODOs (${project})\n`;
		if (!groups.length) {
			body += "\n_(none)_\n";
		} else {
			for (const g of groups) {
				body += `\n## Session: ${sessionLabel(g)}\n\n`;
				body += g.todos.length
					? g.todos.map((t) => `- [${t.done ? "x" : " "}] #${t.id} ${t.text}`).join("\n")
					: "_(none)_";
				body += "\n";
			}
		}
		const file = join(tmpdir(), `pi-todos-${Buffer.from(project).toString("hex").slice(0, 16)}.md`);
		writeFileSync(file, body);
		const child = execFile("context-mode", ["index", file, "--source", "todos", "--project", project], () => {});
		child.unref?.();
	} catch {
		/* mirror is best-effort; never fail the tool */
	}
};

// --- /todos viewer -------------------------------------------------------
class TodoViewer {
	private cachedWidth?: number;
	private cachedLines?: string[];
	private mode: "current" | "all" = "current";
	constructor(
		private project: string,
		private session: string,
		private theme: Theme,
		private onClose: () => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
			return;
		}
		if (data === "a" || data === "A") {
			this.mode = this.mode === "current" ? "all" : "current";
			this.invalidate();
		}
	}

	private header(width: number, label: string): string[] {
		const th = this.theme;
		const title = th.fg("accent", ` ${label} `);
		return [
			truncateToWidth(
				th.fg("borderMuted", "─".repeat(3)) +
					title +
					th.fg("borderMuted", "─".repeat(Math.max(0, width - label.length - 7))),
				width,
			),
		];
	}

	private renderTodoLines(todos: Todo[], width: number, indent = "  "): string[] {
		const th = this.theme;
		const lines: string[] = [];
		if (todos.length === 0) {
			lines.push(truncateToWidth(`${indent}${th.fg("dim", "No todos.")}`, width));
			return lines;
		}
		const done = todos.filter((t) => t.done).length;
		lines.push(truncateToWidth(`${indent}${th.fg("muted", `${done}/${todos.length} completed`)}`, width), "");
		for (const t of todos) {
			const check = t.done ? th.fg("success", "✓") : th.fg("dim", "○");
			const id = th.fg("accent", `#${t.id}`);
			const text = t.done ? th.fg("dim", t.text) : th.fg("text", t.text);
			lines.push(truncateToWidth(`${indent}${check} ${id} ${text}`, width));
		}
		return lines;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const th = this.theme;
		const lines: string[] = [""];

		if (this.mode === "current") {
			const label = sessionName(this.project, this.session);
			lines.push(...this.header(width, "Todos"));
			lines.push(
				"",
				truncateToWidth(
					`  ${th.fg("dim", "session: ")}${th.fg("muted", sessionLabel({ session: this.session, name: label, current: true }))}`,
					width,
				),
				"",
			);
			lines.push(...this.renderTodoLines(listTodos(this.project, this.session), width));
		} else {
			const groups = groupAllSessions(this.project, this.session);
			lines.push(...this.header(width, "Todos · all sessions"));
			lines.push("");
			if (!groups.length) {
				lines.push(truncateToWidth(`  ${th.fg("dim", "No todos in this project yet.")}`, width));
			} else {
				for (const g of groups) {
					lines.push(truncateToWidth(`  ${th.fg("accent", sessionLabel(g))}`, width));
					lines.push(...this.renderTodoLines(g.todos, width, "    "));
					lines.push("");
				}
			}
		}

		lines.push(
			"",
			truncateToWidth(
				`  ${th.fg("dim", `Press "a" to toggle ${this.mode === "current" ? "all sessions" : "current session"} · Escape to close`)}`,
				width,
			),
			"",
		);
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "toggle", "clear", "sessions", "view"] as const),
	text: Type.Optional(Type.String({ description: "Todo text (for add)" })),
	id: Type.Optional(Type.Number({ description: "Todo ID (for toggle)" })),
	session: Type.Optional(
		Type.String({
			description:
				"For action 'view': which other session's todos to read (session id, id prefix, name, or 'all'). View-only; does not change your own list.",
		}),
	),
});

export default function (pi: ExtensionAPI) {
	let project = projectKey(process.cwd());
	let session = FALLBACK_SESSION;

	const refresh = (ctx?: ExtensionContext): void => {
		const cwd = (ctx as any)?.cwd ?? process.cwd();
		project = projectKey(cwd);
		const sm = (ctx as any)?.sessionManager;
		const sid = sm?.getSessionId?.();
		session = sid ? String(sid) : FALLBACK_SESSION;
		try {
			rememberSession(project, session, sm?.getSessionName?.());
		} catch {
			/* metadata is best-effort */
		}
	};

	pi.on("session_start", async (_e, ctx) => refresh(ctx));
	pi.on("session_tree", async (_e, ctx) => refresh(ctx));

	const renderSessionsText = (sessions: SessionSummary[]): string => {
		if (!sessions.length) return "No sessions with todos in this project yet.";
		return [
			`${sessions.length} session(s) with todos in this project:`,
			...sessions.map((s) => `- ${sessionLabel(s)} — ${s.done}/${s.total} done`),
			'',
			'Use action "view" with session set to an id/prefix/name (or "all") to read another session\'s todos.',
		].join("\n");
	};

	const renderGroupsText = (groups: SessionGroup[]): string => {
		if (!groups.length) return "No todos found.";
		return groups
			.map((g) => {
				const head = `# ${sessionLabel(g)}`;
				const body = g.todos.length
					? g.todos.map((t) => `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`).join("\n")
					: "(none)";
				return `${head}\n${body}`;
			})
			.join("\n\n");
	};

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Durable todo list (SQLite-backed, persists across restarts), scoped per project AND per session — each session has its own list. " +
			"Actions: list (this session), add (text), toggle (id), clear (this session), sessions (overview of all sessions in this project that have todos), " +
			"view (read another session's todos by session id/prefix/name, or 'all', e.g. to take over work from a previous session — view-only).",
		parameters: TodoParams,

		async execute(_id, params, _signal, _onUpdate, ctx) {
			refresh(ctx as ExtensionContext | undefined);
			switch (params.action) {
				case "add": {
					if (!params.text) {
						return {
							content: [{ type: "text", text: "Error: text required for add" }],
							details: { action: "add", project, session, todos: listTodos(project, session), error: "text required" } as TodoDetails,
						};
					}
					const t = addTodo(project, session, params.text);
					mirror(project);
					return {
						content: [{ type: "text", text: `Added todo #${t.id}: ${t.text}` }],
						details: { action: "add", project, session, todos: listTodos(project, session) } as TodoDetails,
					};
				}
				case "toggle": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text", text: "Error: id required for toggle" }],
							details: { action: "toggle", project, session, todos: listTodos(project, session), error: "id required" } as TodoDetails,
						};
					}
					const t = toggleTodo(project, session, params.id);
					if (!t) {
						return {
							content: [{ type: "text", text: `Todo #${params.id} not found` }],
							details: {
								action: "toggle",
								project,
								session,
								todos: listTodos(project, session),
								error: `#${params.id} not found`,
							} as TodoDetails,
						};
					}
					mirror(project);
					return {
						content: [{ type: "text", text: `Todo #${t.id} ${t.done ? "completed" : "uncompleted"}` }],
						details: { action: "toggle", project, session, todos: listTodos(project, session) } as TodoDetails,
					};
				}
				case "clear": {
					const n = clearTodos(project, session);
					mirror(project);
					return {
						content: [{ type: "text", text: `Cleared ${n} todos (this session)` }],
						details: { action: "clear", project, session, todos: [] } as TodoDetails,
					};
				}
				case "sessions": {
					const sessions = listSessions(project, session);
					return {
						content: [{ type: "text", text: renderSessionsText(sessions) }],
						details: { action: "sessions", project, session, todos: [], sessions } as TodoDetails,
					};
				}
				case "view": {
					const selector = (params.session ?? "all").trim();
					if (selector === "all" || selector === "") {
						const groups = groupAllSessions(project, session);
						return {
							content: [{ type: "text", text: renderGroupsText(groups) }],
							details: { action: "view", project, session, todos: [], groups } as TodoDetails,
						};
					}
					const target = resolveSession(project, selector);
					if (!target) {
						const sessions = listSessions(project, session);
						return {
							content: [
								{
									type: "text",
									text: `No session matched "${selector}".\n\n${renderSessionsText(sessions)}`,
								},
							],
							details: {
								action: "view",
								project,
								session,
								todos: [],
								sessions,
								error: `no session matched "${selector}"`,
							} as TodoDetails,
						};
					}
					const groups: SessionGroup[] = [
						{ session: target, name: sessionName(project, target), current: target === session, todos: listTodos(project, target) },
					];
					return {
						content: [{ type: "text", text: renderGroupsText(groups) }],
						details: { action: "view", project, session, todos: groups[0].todos, groups } as TodoDetails,
					};
				}
				default: {
					const todos = listTodos(project, session);
					return {
						content: [
							{
								type: "text",
								text: todos.length
									? todos.map((t) => `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`).join("\n")
									: "No todos (this session)",
							},
						],
						details: { action: "list", project, session, todos } as TodoDetails,
					};
				}
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if (args.session) text += ` ${theme.fg("accent", String(args.session))}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as TodoDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.error && details.action !== "view") return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			const todoList = details.todos;
			switch (details.action) {
				case "add": {
					const added = todoList[todoList.length - 1];
					return new Text(
						theme.fg("success", "✓ Added ") + theme.fg("accent", `#${added.id}`) + " " + theme.fg("muted", added.text),
						0,
						0,
					);
				}
				case "toggle":
				case "clear": {
					const text = result.content[0];
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", text?.type === "text" ? text.text : ""), 0, 0);
				}
				case "sessions": {
					const sessions = details.sessions ?? [];
					if (!sessions.length) return new Text(theme.fg("dim", "No sessions with todos yet"), 0, 0);
					let txt = theme.fg("muted", `${sessions.length} session(s) with todos:`);
					for (const s of sessions) {
						const marker = s.current ? theme.fg("success", " ← current") : "";
						txt += `\n${theme.fg("accent", sessionLabel({ session: s.session, name: s.name }))} ${theme.fg("muted", `${s.done}/${s.total}`)}${marker}`;
					}
					return new Text(txt, 0, 0);
				}
				case "view": {
					const groups = details.groups ?? [];
					if (!groups.length || groups.every((g) => g.todos.length === 0)) {
						const text = result.content[0];
						return new Text(theme.fg("muted", text?.type === "text" ? text.text : "No todos"), 0, 0);
					}
					let txt = theme.fg("muted", "viewing other session(s):");
					for (const g of groups) {
						txt += `\n${theme.fg("accent", sessionLabel(g))}`;
						const display = expanded ? g.todos : g.todos.slice(0, 5);
						for (const t of display) {
							const check = t.done ? theme.fg("success", "✓") : theme.fg("dim", "○");
							const itemText = t.done ? theme.fg("dim", t.text) : theme.fg("muted", t.text);
							txt += `\n  ${check} ${theme.fg("accent", `#${t.id}`)} ${itemText}`;
						}
						if (!expanded && g.todos.length > 5) txt += `\n  ${theme.fg("dim", `... ${g.todos.length - 5} more`)}`;
					}
					return new Text(txt, 0, 0);
				}
				default: {
					if (todoList.length === 0) return new Text(theme.fg("dim", "No todos"), 0, 0);
					let listText = theme.fg("muted", `${todoList.length} todo(s):`);
					const display = expanded ? todoList : todoList.slice(0, 5);
					for (const t of display) {
						const check = t.done ? theme.fg("success", "✓") : theme.fg("dim", "○");
						const itemText = t.done ? theme.fg("dim", t.text) : theme.fg("muted", t.text);
						listText += `\n${check} ${theme.fg("accent", `#${t.id}`)} ${itemText}`;
					}
					if (!expanded && todoList.length > 5) listText += `\n${theme.fg("dim", `... ${todoList.length - 5} more`)}`;
					return new Text(listText, 0, 0);
				}
			}
		},
	});

	pi.registerCommand("todos", {
		description: "Show durable todos for the current session (press 'a' for all sessions)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}
			refresh(ctx);
			await ctx.ui.custom<void>((_tui, theme, _kb, done) => new TodoViewer(project, session, theme, () => done()));
		},
	});
}
