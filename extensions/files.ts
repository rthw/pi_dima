/**
 * Разбор папок с файлами вместе с пользователем.
 *
 * file_list  — таблица файлов папки (№, имя, размер, дата).
 * file_show  — собрать выбранные файлы в папку «_показ» с номерами и открыть её в Finder.
 * file_move  — переложить файлы в другую папку (без перезаписи).
 * file_trash — отправить файлы в системную Корзину (их можно вернуть), с записью в журнал.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { appendFile, lstat, mkdir, readdir, rename, rm, stat, symlink } from "node:fs/promises";
import { homedir, platform } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";

const run = promisify(execFile);
const MAC = platform() === "darwin";
const SHOW_DIR = "_показ";
const MAX_ROWS = 300;

function resolve(cwd: string, p: string): string {
	const expanded = p.startsWith("~/") ? path.join(homedir(), p.slice(2)) : p;
	return path.resolve(cwd, expanded);
}

function size(bytes: number): string {
	if (bytes < 1024) return `${bytes} Б`;
	const units = ["КБ", "МБ", "ГБ", "ТБ"];
	let value = bytes / 1024;
	let i = 0;
	while (value >= 1024 && i < units.length - 1) {
		value /= 1024;
		i++;
	}
	return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

async function dirSize(dir: string): Promise<{ bytes: number; files: number }> {
	let bytes = 0;
	let files = 0;
	for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			const sub = await dirSize(full);
			bytes += sub.bytes;
			files += sub.files;
		} else if (entry.isFile()) {
			bytes += (await stat(full).catch(() => ({ size: 0 }))).size;
			files++;
		}
	}
	return { bytes, files };
}

async function openInFileManager(target: string): Promise<void> {
	if (MAC) await run("open", [target]);
	else await run("xdg-open", [target]).catch(() => undefined);
}

/** На APFS `cp -c` делает мгновенную копию без лишнего места; не вышло — ссылка. */
async function placeCopy(src: string, dest: string): Promise<void> {
	try {
		if (MAC) await run("cp", ["-c", src, dest]);
		else await run("cp", ["--reflink=auto", src, dest]);
	} catch {
		await symlink(src, dest);
	}
}

async function toTrash(file: string): Promise<void> {
	if (MAC) {
		try {
			await run("/usr/bin/trash", [file]);
		} catch {
			await run("osascript", ["-e", `tell application "Finder" to delete (POSIX file ${JSON.stringify(file)})`]);
		}
	} else {
		await run("gio", ["trash", file]);
	}
}

export default function files(pi: ExtensionAPI) {
	pi.registerTool({
		name: "file_list",
		label: "Список файлов",
		description:
			"Таблица содержимого папки: №, имя, размер, дата изменения. Подпапки — одной строкой с числом файлов и общим размером. " +
			"Скрытые файлы (с точки) пропускаются.",
		promptSnippet: "Таблица файлов папки для разбора",
		parameters: Type.Object({
			path: Type.String({ description: "Папка (можно ~/…)" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const dir = resolve(ctx.cwd, params.path);
			const entries = (await readdir(dir, { withFileTypes: true }))
				.filter((e) => !e.name.startsWith(".") && e.name !== SHOW_DIR)
				.sort((a, b) => a.name.localeCompare(b.name, "ru"));
			const rows: string[] = ["№ | имя | размер | дата"];
			let n = 0;
			for (const entry of entries.slice(0, MAX_ROWS)) {
				n++;
				const full = path.join(dir, entry.name);
				const info = await lstat(full);
				const date = info.mtime.toISOString().slice(0, 10);
				if (entry.isDirectory()) {
					const sub = await dirSize(full);
					rows.push(`${n} | ${entry.name}/ | ${size(sub.bytes)}, ${sub.files} файлов | ${date}`);
				} else {
					rows.push(`${n} | ${entry.name} | ${size(info.size)} | ${date}`);
				}
			}
			const more = entries.length > MAX_ROWS ? `\n…и ещё ${entries.length - MAX_ROWS}. Разбирай по частям.` : "";
			return { content: [{ type: "text", text: `${dir}\n\n${rows.join("\n")}${more}` }], details: { dir, count: entries.length } };
		},
	});

	pi.registerTool({
		name: "file_show",
		label: "Показать файлы",
		description:
			`Показать файлы пользователю: копии кладутся в папку «${SHOW_DIR}» в рабочей папке под номерами 01_, 02_ … в заданном порядке ` +
			"и папка открывается в Finder (пробел — быстрый просмотр, стрелки — листать). Прошлый показ стирается. " +
			"Сам ты содержимое не видишь — картинку смотри инструментом read.",
		promptSnippet: "Открыть пользователю выбранные файлы в Finder под номерами",
		promptGuidelines: [
			"Перед вопросами о файлах покажи их через file_show и в вопросах ссылайся на номера показа (01, 02 …).",
		],
		parameters: Type.Object({
			paths: Type.Array(Type.String(), { minItems: 1, maxItems: 40, description: "Файлы в порядке показа" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const showDir = path.join(ctx.cwd, SHOW_DIR);
			await rm(showDir, { recursive: true, force: true });
			await mkdir(showDir, { recursive: true });
			const lines: string[] = [];
			for (const [i, p] of params.paths.entries()) {
				const src = resolve(ctx.cwd, p);
				const label = String(i + 1).padStart(2, "0");
				await placeCopy(src, path.join(showDir, `${label}_${path.basename(src)}`));
				lines.push(`${label} — ${src}`);
			}
			await openInFileManager(showDir);
			return { content: [{ type: "text", text: `Открыто в Finder (${showDir}):\n${lines.join("\n")}` }], details: { showDir } };
		},
	});

	pi.registerTool({
		name: "file_move",
		label: "Переложить файлы",
		description: "Переложить файлы или папки в другую папку (создаётся, если нет). Существующие файлы не перезаписываются.",
		parameters: Type.Object({
			paths: Type.Array(Type.String(), { minItems: 1 }),
			to: Type.String({ description: "Папка назначения" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const dest = resolve(ctx.cwd, params.to);
			await mkdir(dest, { recursive: true });
			const moved: string[] = [];
			const skipped: string[] = [];
			for (const p of params.paths) {
				const src = resolve(ctx.cwd, p);
				const target = path.join(dest, path.basename(src));
				if (await lstat(target).catch(() => undefined)) {
					skipped.push(`${src} (в ${dest} уже есть такой)`);
					continue;
				}
				try {
					await rename(src, target);
				} catch (err: any) {
					if (err?.code !== "EXDEV") throw err;
					await run("mv", [src, target]); // другой диск
				}
				moved.push(src);
			}
			const text = [`Перенесено в ${dest}: ${moved.length}`, ...skipped.map((s) => `пропущено: ${s}`)].join("\n");
			return { content: [{ type: "text", text }], details: { moved, skipped } };
		},
	});

	pi.registerTool({
		name: "file_trash",
		label: "В Корзину",
		description:
			"Удалить файлы или папки в системную Корзину (пользователь может их вернуть). Единственный разрешённый способ удаления. " +
			"Удаляй только то, на что пользователь явно ответил «удалить».",
		parameters: Type.Object({
			paths: Type.Array(Type.String(), { minItems: 1 }),
			reason: Type.String({ description: "Почему удаляется — пишется в журнал" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const done: string[] = [];
			const failed: string[] = [];
			for (const p of params.paths) {
				const target = resolve(ctx.cwd, p);
				try {
					await toTrash(target);
					done.push(target);
				} catch (err) {
					failed.push(`${target}: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
				}
			}
			const log = path.join(ctx.cwd, "memory", "trash_log.md");
			const stamp = new Date().toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
			if (done.length) {
				await appendFile(log, done.map((f) => `- ${stamp} ${f} — ${params.reason}\n`).join("")).catch(() => undefined);
			}
			const lines = [`В Корзине: ${done.length}`, ...done];
			if (failed.length) {
				lines.push(
					`Не удалось: ${failed.length}`,
					...failed,
					"Не удаляй эти файлы другим способом (rm, mv в Корзину вручную) — скажи пользователю, что они остались, и почему.",
				);
			}
			return { content: [{ type: "text", text: lines.join("\n") }], details: { done, failed }, isError: done.length === 0 };
		},
	});
}
