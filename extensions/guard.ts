/**
 * Подтверждение перед опасными действиями.
 *
 * Спрашивает «Разрешить?» перед командами, которые удаляют без Корзины, работают с правами
 * администратора, стирают диски или историю git, и перед записью файлов вне рабочей папки.
 * Без экрана (pi -p) такие действия просто запрещены.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import path from "node:path";

const DANGEROUS: Array<[RegExp, string]> = [
	[/(^|[\s;&|(`])(rm|rmdir|unlink|shred|srm)\s/, "удаление мимо Корзины"],
	[/\bfind\b[^\n]*\s-(delete|exec\s+rm)\b/, "массовое удаление через find"],
	[/(^|[\s;&|(`])sudo\s/, "команда с правами администратора"],
	[/\b(diskutil|mkfs|fdisk|dd)\s/, "работа с дисками"],
	[/\b(chmod|chown)\s+-R\b/, "смена прав на всё дерево"],
	[/\bgit\s+(push\s+[^\n]*(-f\b|--force)|reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s)/, "необратимая операция git"],
	[/\bmv\s[^\n]*\s\/dev\/null\b/, "удаление через /dev/null"],
	[/\bmv\s[^\n]*(\.Trash|\/Trash\/)/, "перенос в Корзину в обход file_trash"],
	[/(^|[\s;&|(`])(curl|wget)\s[^\n]*\|\s*(sh|bash|zsh)\b/, "запуск скрипта из интернета"],
];

function dangerOf(command: string): string | undefined {
	return DANGEROUS.find(([re]) => re.test(command))?.[1];
}

function outsideCwd(ctx: ExtensionContext, file: string): boolean {
	const expanded = file.startsWith("~/") ? path.join(homedir(), file.slice(2)) : file;
	const rel = path.relative(ctx.cwd, path.resolve(ctx.cwd, expanded));
	return rel.startsWith("..") || path.isAbsolute(rel);
}

async function ask(ctx: ExtensionContext, title: string, detail: string) {
	if (!ctx.hasUI) return { block: true, reason: `${title}: запрещено без подтверждения пользователя` };
	const choice = await ctx.ui.select(`⚠️  ${title}\n\n  ${detail}\n\nРазрешить?`, ["Нет", "Да"]);
	if (choice === "Да") return undefined;
	return {
		block: true,
		reason: `Пользователь не разрешил (${title}). Не пытайся сделать то же обходным путём; для удаления есть file_trash.`,
	};
}

export default function guard(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "bash") {
			const command = String(event.input.command ?? "");
			const danger = dangerOf(command);
			return danger ? ask(ctx, danger, command) : undefined;
		}
		if (event.toolName === "write" || event.toolName === "edit") {
			const file = String(event.input.path ?? event.input.file_path ?? "");
			if (file && outsideCwd(ctx, file)) return ask(ctx, "запись вне рабочей папки", file);
		}
		return undefined;
	});
}
