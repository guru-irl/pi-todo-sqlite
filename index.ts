/**
 * todo-sqlite — durable, project-scoped todo tool for pi.
 *
 * Unlike the bundled session-based todo, state lives in a real SQLite database
 * (~/.pi/agent/todos.db, via Node's built-in node:sqlite), so todos persist
 * across sessions and are scoped per project (git root, else cwd).
 *
 * Optional context-mode mirror (on by default; CTX_TODO_MIRROR=0 to disable):
 * after every change the current project's list is (re)indexed into
 * context-mode under source "todos", so `ctx_search` surfaces your todos as
 * searchable memory. `context-mode index` replaces a source, so this stays clean.
 *
 * Registers:
 *   - `todo` tool   (actions: list | add | toggle | clear)
 *   - `/todos` command (interactive viewer)
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

interface TodoDetails {
	action: "list" | "add" | "toggle" | "clear";
	project: string;
	todos: Todo[];
	error?: string;
}

const MIRROR = process.env.CTX_TODO_MIRROR !== "0";

// --- storage -------------------------------------------------------------
const DB_PATH = join(homedir(), ".pi", "agent", "todos.db");
mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
	CREATE TABLE IF NOT EXISTS todos (
		project    TEXT    NOT NULL,
		id         INTEGER NOT NULL,
		text       TEXT    NOT NULL,
		done       INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		PRIMARY KEY (project, id)
	);
`);

const projectKey = (cwd: string): string => {
	try {
		return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: ["ignore", "pipe", "ignore"] })
			.toString()
			.trim() || cwd;
	} catch {
		return cwd;
	}
};

const listTodos = (project: string): Todo[] =>
	(db.prepare("SELECT id, text, done FROM todos WHERE project = ? ORDER BY id").all(project) as any[]).map((r) => ({
		id: Number(r.id),
		text: String(r.text),
		done: !!r.done,
	}));

const addTodo = (project: string, text: string): Todo => {
	const now = Date.now();
	const row = db.prepare("SELECT COALESCE(MAX(id),0) AS m FROM todos WHERE project = ?").get(project) as any;
	const id = Number(row.m) + 1;
	db.prepare("INSERT INTO todos (project,id,text,done,created_at,updated_at) VALUES (?,?,?,0,?,?)").run(
		project,
		id,
		text,
		now,
		now,
	);
	return { id, text, done: false };
};

const toggleTodo = (project: string, id: number): Todo | undefined => {
	const cur = db.prepare("SELECT done FROM todos WHERE project = ? AND id = ?").get(project, id) as any;
	if (!cur) return undefined;
	const done = cur.done ? 0 : 1;
	db.prepare("UPDATE todos SET done = ?, updated_at = ? WHERE project = ? AND id = ?").run(done, Date.now(), project, id);
	const t = db.prepare("SELECT id,text,done FROM todos WHERE project = ? AND id = ?").get(project, id) as any;
	return { id: Number(t.id), text: String(t.text), done: !!t.done };
};

const clearTodos = (project: string): number => {
	const c = db.prepare("SELECT COUNT(*) AS n FROM todos WHERE project = ?").get(project) as any;
	db.prepare("DELETE FROM todos WHERE project = ?").run(project);
	return Number(c.n);
};

// --- context-mode mirror (best-effort, non-blocking) ---------------------
const mirror = (project: string): void => {
	if (!MIRROR) return;
	try {
		const todos = listTodos(project);
		const body =
			`# TODOs (${project})\n\n` +
			(todos.length
				? todos.map((t) => `- [${t.done ? "x" : " "}] #${t.id} ${t.text}`).join("\n")
				: "_(none)_") +
			"\n";
		const file = join(tmpdir(), `pi-todos-${Buffer.from(project).toString("hex").slice(0, 16)}.md`);
		writeFileSync(file, body);
		const child = execFile(
			"context-mode",
			["index", file, "--source", "todos", "--project", project],
			() => {},
		);
		child.unref?.();
	} catch {
		/* mirror is best-effort; never fail the tool */
	}
};

// --- /todos viewer -------------------------------------------------------
class TodoListComponent {
	private cachedWidth?: number;
	private cachedLines?: string[];
	constructor(
		private todos: Todo[],
		private theme: Theme,
		private onClose: () => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.onClose();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const th = this.theme;
		const lines: string[] = [""];
		const title = th.fg("accent", " Todos ");
		lines.push(
			truncateToWidth(
				th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 10))),
				width,
			),
		);
		lines.push("");
		if (this.todos.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No todos for this project yet.")}`, width));
		} else {
			const done = this.todos.filter((t) => t.done).length;
			lines.push(truncateToWidth(`  ${th.fg("muted", `${done}/${this.todos.length} completed`)}`, width), "");
			for (const t of this.todos) {
				const check = t.done ? th.fg("success", "✓") : th.fg("dim", "○");
				const id = th.fg("accent", `#${t.id}`);
				const text = t.done ? th.fg("dim", t.text) : th.fg("text", t.text);
				lines.push(truncateToWidth(`  ${check} ${id} ${text}`, width));
			}
		}
		lines.push("", truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width), "");
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
	action: StringEnum(["list", "add", "toggle", "clear"] as const),
	text: Type.Optional(Type.String({ description: "Todo text (for add)" })),
	id: Type.Optional(Type.Number({ description: "Todo ID (for toggle)" })),
});

export default function (pi: ExtensionAPI) {
	let project = projectKey(process.cwd());
	const refreshProject = (ctx?: ExtensionContext) => {
		const cwd = (ctx as any)?.cwd ?? process.cwd();
		project = projectKey(cwd);
	};
	pi.on("session_start", async (_e, ctx) => refreshProject(ctx));
	pi.on("session_tree", async (_e, ctx) => refreshProject(ctx));

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Durable per-project todo list (SQLite-backed, persists across sessions). Actions: list, add (text), toggle (id), clear",
		parameters: TodoParams,

		async execute(_id, params) {
			switch (params.action) {
				case "add": {
					if (!params.text) {
						return {
							content: [{ type: "text", text: "Error: text required for add" }],
							details: { action: "add", project, todos: listTodos(project), error: "text required" } as TodoDetails,
						};
					}
					const t = addTodo(project, params.text);
					mirror(project);
					return {
						content: [{ type: "text", text: `Added todo #${t.id}: ${t.text}` }],
						details: { action: "add", project, todos: listTodos(project) } as TodoDetails,
					};
				}
				case "toggle": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text", text: "Error: id required for toggle" }],
							details: { action: "toggle", project, todos: listTodos(project), error: "id required" } as TodoDetails,
						};
					}
					const t = toggleTodo(project, params.id);
					if (!t) {
						return {
							content: [{ type: "text", text: `Todo #${params.id} not found` }],
							details: {
								action: "toggle",
								project,
								todos: listTodos(project),
								error: `#${params.id} not found`,
							} as TodoDetails,
						};
					}
					mirror(project);
					return {
						content: [{ type: "text", text: `Todo #${t.id} ${t.done ? "completed" : "uncompleted"}` }],
						details: { action: "toggle", project, todos: listTodos(project) } as TodoDetails,
					};
				}
				case "clear": {
					const n = clearTodos(project);
					mirror(project);
					return {
						content: [{ type: "text", text: `Cleared ${n} todos` }],
						details: { action: "clear", project, todos: [] } as TodoDetails,
					};
				}
				default: {
					const todos = listTodos(project);
					return {
						content: [
							{
								type: "text",
								text: todos.length
									? todos.map((t) => `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`).join("\n")
									: "No todos",
							},
						],
						details: { action: "list", project, todos } as TodoDetails,
					};
				}
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as TodoDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
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
		description: "Show durable todos for the current project",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}
			refreshProject(ctx);
			await ctx.ui.custom<void>((_tui, theme, _kb, done) => new TodoListComponent(listTodos(project), theme, () => done()));
		},
	});
}
