/**
 * Автосинхронизация рабочей папки с GitHub.
 *
 * Включается только в git-репозитории, где в корне лежит файл `.autosync`.
 * При старте сессии — `git pull`, после каждого ответа агента — commit + push.
 * Команда /sync — синхронизировать сейчас и показать результат.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await run("git", args, { cwd, timeout: 60_000 });
	return stdout.trim();
}

async function repoRoot(cwd: string): Promise<string | undefined> {
	try {
		const root = await git(cwd, "rev-parse", "--show-toplevel");
		return existsSync(path.join(root, ".autosync")) ? root : undefined;
	} catch {
		return undefined;
	}
}

function errText(err: unknown): string {
	const e = err as { stderr?: string; message?: string };
	return (e.stderr || e.message || String(err)).trim().split("\n").slice(-3).join(" ");
}

export default function sync(pi: ExtensionAPI) {
	let root: string | undefined;
	let queue: Promise<unknown> = Promise.resolve();

	// Операции git идут строго по очереди, даже если ответы агента следуют быстро.
	const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
		const next = queue.then(job, job);
		queue = next.catch(() => undefined);
		return next;
	};

	const pull = (dir: string) => git(dir, "pull", "--rebase", "--autostash", "--quiet");

	const push = async (dir: string): Promise<string> => {
		if (!(await git(dir, "status", "--porcelain"))) return "изменений нет";
		await git(dir, "add", "-A");
		const stamp = new Date().toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
		await git(dir, "commit", "--quiet", "-m", `записи ${stamp}`);
		try {
			await git(dir, "push", "--quiet");
		} catch {
			await pull(dir);
			await git(dir, "push", "--quiet");
		}
		return "отправлено на GitHub";
	};

	const warn = (ctx: ExtensionContext, err: unknown) =>
		ctx.hasUI && ctx.ui.notify(`Синхронизация не удалась: ${errText(err)}. Скажи агенту «почини синхронизацию».`, "warning");

	pi.on("session_start", async (_event, ctx) => {
		root = await repoRoot(ctx.cwd);
		if (root) {
			const dir = root;
			void enqueue(() => pull(dir)).catch((err) => warn(ctx, err));
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!root) return;
		const dir = root;
		void enqueue(() => push(dir)).catch((err) => warn(ctx, err));
	});

	pi.on("session_shutdown", async () => {
		if (!root) return;
		const dir = root;
		await enqueue(() => push(dir)).catch(() => undefined);
	});

	pi.registerCommand("sync", {
		description: "Синхронизировать рабочую папку с GitHub сейчас",
		handler: async (_args, ctx) => {
			const dir = root ?? (await repoRoot(ctx.cwd));
			if (!dir) {
				ctx.ui.notify("Здесь нет автосинхронизации (нужен git-репозиторий с файлом .autosync)", "warning");
				return;
			}
			try {
				const result = await enqueue(async () => {
					await pull(dir);
					return push(dir);
				});
				ctx.ui.notify(`Синхронизировано: ${result}`, "info");
			} catch (err) {
				warn(ctx, err);
			}
		},
	});
}
