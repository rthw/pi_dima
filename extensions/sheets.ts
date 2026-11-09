/**
 * Google Таблицы через API: найти, прочитать, записать, оформить.
 *
 * Вход — один раз: команда /google (или тул google_login) открывает браузер, токен ложится
 * в ~/.config/pi_home/google_token.json. OAuth-клиент (google_client.json) кладётся туда же вручную.
 *
 * sheets_find, sheets_info, sheets_read, sheets_export — чтение;
 * sheets_write, sheets_append, sheets_clear, sheets_create, sheets_import, sheets_update — запись.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, platform } from "node:os";
import path from "node:path";
import { Type } from "typebox";

const CONFIG_DIR = path.join(homedir(), ".config", "pi_home");
const CLIENT_FILE = path.join(CONFIG_DIR, "google_client.json");
const TOKEN_FILE = path.join(CONFIG_DIR, "google_token.json");
const SCOPES = [
	"https://www.googleapis.com/auth/spreadsheets",
	"https://www.googleapis.com/auth/drive.metadata.readonly",
	"https://www.googleapis.com/auth/drive.file",
];
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const DRIVE = "https://www.googleapis.com/drive/v3/files";
const MAX_CHARS = 40_000;

interface Client {
	client_id: string;
	client_secret: string;
}
interface Token {
	access_token: string;
	refresh_token: string;
	expires_at: number;
}

function text(t: string) {
	return { content: [{ type: "text" as const, text: t }], details: undefined };
}

function expand(p: string, cwd: string): string {
	return path.resolve(cwd, p.startsWith("~/") ? path.join(homedir(), p.slice(2)) : p);
}

async function loadClient(): Promise<Client> {
	let raw: string;
	try {
		raw = await readFile(CLIENT_FILE, "utf8");
	} catch {
		throw new Error(
			`Нет файла ключа приложения Google: ${CLIENT_FILE}. Его присылает Макс (файл google_client.json) — ` +
				"найди его в Загрузках и скопируй в эту папку (mkdir -p ~/.config/pi_home), затем /google.",
		);
	}
	const json = JSON.parse(raw);
	const c = json.installed ?? json.web ?? json;
	if (!c.client_id || !c.client_secret) throw new Error(`${CLIENT_FILE}: нет client_id/client_secret`);
	return { client_id: c.client_id, client_secret: c.client_secret };
}

async function saveToken(t: Token): Promise<void> {
	await mkdir(CONFIG_DIR, { recursive: true });
	await writeFile(TOKEN_FILE, JSON.stringify(t, null, 2));
	await chmod(TOKEN_FILE, 0o600);
}

async function tokenRequest(body: Record<string, string>): Promise<any> {
	const r = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(body),
	});
	const json: any = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(`Google вход: ${json.error ?? r.status} ${json.error_description ?? ""}`.trim());
	return json;
}

function openBrowser(url: string): void {
	const cmd = platform() === "darwin" ? "open" : platform() === "win32" ? "explorer" : "xdg-open";
	execFile(cmd, [url], () => undefined);
}

/** Вход через браузер: локальный сервер на 127.0.0.1 ловит код, PKCE. */
async function login(signal?: AbortSignal, notify?: (msg: string) => void): Promise<string> {
	const client = await loadClient();
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	const state = randomBytes(16).toString("hex");

	const server = createServer();
	await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
	const port = (server.address() as { port: number }).port;
	const redirect = `http://127.0.0.1:${port}`;

	const code = await new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("Вход не завершён за 5 минут")), 5 * 60_000);
		signal?.addEventListener("abort", () => reject(new Error("Вход отменён")));
		server.on("request", (req, res) => {
			const url = new URL(req.url ?? "/", redirect);
			const got = url.searchParams.get("code");
			const err = url.searchParams.get("error");
			if (!got && !err) {
				res.writeHead(404).end();
				return;
			}
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(
				`<h2 style="font-family:sans-serif">${err ? "Вход не удался: " + err : "Готово — можно закрыть вкладку и вернуться в Терминал."}</h2>`,
			);
			clearTimeout(timer);
			if (err) reject(new Error(`Google вход: ${err}`));
			else if (url.searchParams.get("state") !== state) reject(new Error("Google вход: неверный state"));
			else resolve(got!);
		});
		const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
		auth.search = new URLSearchParams({
			client_id: client.client_id,
			redirect_uri: redirect,
			response_type: "code",
			scope: SCOPES.join(" "),
			access_type: "offline",
			prompt: "consent",
			code_challenge: challenge,
			code_challenge_method: "S256",
			state,
		}).toString();
		notify?.(`Открываю браузер для входа в Google. Если не открылся — ссылка:\n${auth}`);
		openBrowser(auth.toString());
	}).finally(() => server.close());

	const json = await tokenRequest({
		code,
		client_id: client.client_id,
		client_secret: client.client_secret,
		redirect_uri: redirect,
		grant_type: "authorization_code",
		code_verifier: verifier,
	});
	if (!json.refresh_token) throw new Error("Google не выдал refresh_token — повторите /google");
	await saveToken({
		access_token: json.access_token,
		refresh_token: json.refresh_token,
		expires_at: Date.now() + (json.expires_in - 60) * 1000,
	});
	const me = await api("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)");
	return me.user?.emailAddress ?? "?";
}

let cached: Token | undefined;
async function accessToken(): Promise<string> {
	if (!cached) {
		try {
			cached = JSON.parse(await readFile(TOKEN_FILE, "utf8"));
		} catch {
			throw new Error("Нет входа в Google. Вызови google_login (откроется браузер) или попроси набрать /google.");
		}
	}
	if (cached!.expires_at > Date.now()) return cached!.access_token;
	const client = await loadClient();
	let json: any;
	try {
		json = await tokenRequest({
			client_id: client.client_id,
			client_secret: client.client_secret,
			refresh_token: cached!.refresh_token,
			grant_type: "refresh_token",
		});
	} catch (err) {
		cached = undefined;
		throw new Error(`${(err as Error).message}. Нужно войти заново: google_login или /google.`);
	}
	cached = { ...cached!, access_token: json.access_token, expires_at: Date.now() + (json.expires_in - 60) * 1000 };
	await saveToken(cached);
	return cached.access_token;
}

async function api(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<any> {
	const headers: Record<string, string> = { Authorization: `Bearer ${await accessToken()}` };
	if (init.body && typeof init.body === "string") headers["Content-Type"] = "application/json";
	const r = await fetch(url, { ...init, headers: { ...headers, ...(init.headers as any) }, signal });
	const json: any = await r.json().catch(() => ({}));
	if (!r.ok) {
		const msg = json.error?.message ?? r.statusText;
		if (r.status === 404) throw new Error(`Не найдено (нет доступа или неверная ссылка): ${msg}`);
		if (r.status === 403) throw new Error(`Нет доступа: ${msg}`);
		throw new Error(`Google API ${r.status}: ${msg}`);
	}
	return json;
}

/** Ссылка или ID → ID таблицы и gid листа из ссылки. */
function parseRef(ref: string): { id: string; gid?: number } {
	const m = ref.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
	const id = m ? m[1] : ref.trim();
	const g = ref.match(/[#&?]gid=(\d+)/);
	return { id, gid: g ? Number(g[1]) : undefined };
}

interface SheetProps {
	sheetId: number;
	title: string;
	gridProperties?: { rowCount: number; columnCount: number; frozenRowCount?: number };
}

async function sheetList(id: string, signal?: AbortSignal): Promise<{ title: string; sheets: SheetProps[] }> {
	const j = await api(`${SHEETS}/${id}?fields=properties.title,sheets.properties`, {}, signal);
	return { title: j.properties.title, sheets: j.sheets.map((s: any) => s.properties) };
}

function quote(title: string): string {
	return `'${title.replace(/'/g, "''")}'`;
}

/** Диапазон по умолчанию: лист из gid ссылки или первый лист. Лист без диапазона — весь лист. */
async function resolveRange(ref: string, range: string | undefined, signal?: AbortSignal): Promise<{ id: string; range: string }> {
	const { id, gid } = parseRef(ref);
	if (range) return { id, range };
	const { sheets } = await sheetList(id, signal);
	const sheet = (gid !== undefined && sheets.find((s) => s.sheetId === gid)) || sheets[0];
	return { id, range: quote(sheet.title) };
}

function colLetter(n: number): string {
	let s = "";
	for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
	return s;
}

/** Номер первой строки и столбца диапазона «Лист!B3:F» → (2, 3). */
function origin(a1: string): { col: number; row: number } {
	const cell = a1.split("!").pop()!.split(":")[0].replace(/\$/g, "");
	const m = cell.match(/^([A-Z]*)(\d*)$/i);
	if (!m) return { col: 0, row: 1 };
	let col = 0;
	for (const ch of m[1].toUpperCase()) col = col * 26 + ch.charCodeAt(0) - 64;
	return { col: Math.max(col - 1, 0), row: m[2] ? Number(m[2]) : 1 };
}

function csvCell(v: unknown): string {
	const s = v == null ? "" : String(v);
	return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function parseCsv(src: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let q = false;
	const delim = (src.split("\n")[0].match(/;/g)?.length ?? 0) > (src.split("\n")[0].match(/,/g)?.length ?? 0) ? ";" : ",";
	for (let i = 0; i < src.length; i++) {
		const c = src[i];
		if (q) {
			if (c === '"' && src[i + 1] === '"') {
				cell += '"';
				i++;
			} else if (c === '"') q = false;
			else cell += c;
		} else if (c === '"') q = true;
		else if (c === delim) {
			row.push(cell);
			cell = "";
		} else if (c === "\n" || c === "\r") {
			if (c === "\r" && src[i + 1] === "\n") i++;
			row.push(cell);
			rows.push(row);
			row = [];
			cell = "";
		} else cell += c;
	}
	if (cell || row.length) {
		row.push(cell);
		rows.push(row);
	}
	return rows;
}

const ref = Type.String({ description: "Ссылка на Google Таблицу или её ID" });
const values = Type.Array(Type.Array(Type.Any()), {
	description: "Строки значений: [[\"Имя\",\"Сумма\"],[\"Иван\",100]]. Формулы — строкой с =, например \"=SUM(B2:B10)\"",
});

export default function (pi: ExtensionAPI) {
	pi.registerCommand("google", {
		description: "Войти в Google (доступ к Таблицам) — откроется браузер",
		handler: async (_args, ctx) => {
			try {
				const email = await login(undefined, (m) => ctx.ui.notify(m, "info"));
				ctx.ui.notify(`Google: вошли как ${email}`, "info");
			} catch (err) {
				ctx.ui.notify((err as Error).message, "error");
			}
		},
	});

	pi.registerTool({
		name: "google_login",
		label: "Вход в Google",
		description:
			"Войти в Google для работы с Таблицами: открывает браузер, пользователь выбирает аккаунт и разрешает доступ. Звать, когда другие sheets_* говорят «нет входа» или просят войти заново.",
		parameters: Type.Object({}),
		async execute(_id, _p, signal, _u, ctx) {
			const email = await login(signal, (m) => ctx.ui.notify(m, "info"));
			return text(`Вошли в Google как ${email}.`);
		},
	});

	pi.registerTool({
		name: "sheets_find",
		label: "Найти таблицы",
		description: "Найти Google Таблицы пользователя по части названия (пусто — последние изменённые). Возвращает названия, даты и ссылки.",
		parameters: Type.Object({ query: Type.Optional(Type.String({ description: "Часть названия" })) }),
		async execute(_id, p, signal) {
			let q = "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false";
			if (p.query) q += ` and name contains '${p.query.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
			const url = new URL(DRIVE);
			url.search = new URLSearchParams({
				q,
				orderBy: "modifiedTime desc",
				pageSize: "30",
				fields: "files(id,name,modifiedTime,webViewLink,owners(displayName))",
				includeItemsFromAllDrives: "true",
				supportsAllDrives: "true",
			}).toString();
			const j = await api(url.toString(), {}, signal);
			if (!j.files?.length) return text("Ничего не нашлось.");
			const lines = j.files.map(
				(f: any, i: number) => `${i + 1}. ${f.name} — изм. ${f.modifiedTime.slice(0, 10)}, ${f.owners?.[0]?.displayName ?? ""}\n   ${f.webViewLink}`,
			);
			return text(lines.join("\n"));
		},
	});

	pi.registerTool({
		name: "sheets_info",
		label: "Устройство таблицы",
		description: "Название таблицы и её листы: имя, gid, размер, закреплённые строки. Звать первым, чтобы узнать имена листов.",
		parameters: Type.Object({ spreadsheet: ref }),
		async execute(_id, p, signal) {
			const { id } = parseRef(p.spreadsheet);
			const { title, sheets } = await sheetList(id, signal);
			const lines = sheets.map((s) => {
				const g = s.gridProperties;
				return `- ${quote(s.title)} (gid ${s.sheetId}): ${g?.rowCount ?? "?"} строк × ${g?.columnCount ?? "?"} столбцов${g?.frozenRowCount ? `, закреплено строк: ${g.frozenRowCount}` : ""}`;
			});
			return text(`«${title}»\nhttps://docs.google.com/spreadsheets/d/${id}/edit\n${lines.join("\n")}`);
		},
	});

	pi.registerTool({
		name: "sheets_read",
		label: "Прочитать таблицу",
		description:
			"Прочитать значения из Google Таблицы. Вывод — строки с номерами и буквами столбцов, чтобы потом точно адресовать ячейки. Для больших таблиц (тысячи строк) — sheets_export в CSV и считать скриптом.",
		parameters: Type.Object({
			spreadsheet: ref,
			range: Type.Optional(
				Type.String({ description: "Диапазон A1: 'Лист1'!A1:F50, или просто имя листа. Пусто — лист из ссылки (gid) или первый" }),
			),
			formulas: Type.Optional(Type.Boolean({ description: "Показать формулы вместо результатов" })),
		}),
		async execute(_id, p, signal) {
			const { id, range } = await resolveRange(p.spreadsheet, p.range, signal);
			const url = `${SHEETS}/${id}/values/${encodeURIComponent(range)}?valueRenderOption=${p.formulas ? "FORMULA" : "FORMATTED_VALUE"}`;
			const j = await api(url, {}, signal);
			const rows: any[][] = j.values ?? [];
			if (!rows.length) return text(`${j.range}: пусто`);
			const o = origin(j.range);
			const width = Math.max(...rows.map((r) => r.length));
			const head = ["#", ...Array.from({ length: width }, (_, i) => colLetter(o.col + i))].join("\t");
			const out = [`${j.range} — ${rows.length} строк`, head];
			let size = 0;
			for (let i = 0; i < rows.length; i++) {
				const line = `${o.row + i}\t${rows[i].map((v) => String(v).replace(/[\t\n]/g, " ")).join("\t")}`;
				size += line.length;
				if (size > MAX_CHARS) {
					out.push(`… обрезано на строке ${o.row + i} из ${o.row + rows.length - 1}. Читай частями (range) или sheets_export.`);
					break;
				}
				out.push(line);
			}
			return text(out.join("\n"));
		},
	});

	pi.registerTool({
		name: "sheets_export",
		label: "Таблица → CSV",
		description: "Сохранить лист или диапазон Google Таблицы в CSV-файл на диске — для расчётов скриптом (python3) над большими данными.",
		parameters: Type.Object({
			spreadsheet: ref,
			range: Type.Optional(Type.String({ description: "Диапазон или имя листа; пусто — лист из ссылки или первый" })),
			path: Type.String({ description: "Куда сохранить, например work/продажи/данные.csv" }),
		}),
		async execute(_id, p, signal, _u, ctx) {
			const { id, range } = await resolveRange(p.spreadsheet, p.range, signal);
			const j = await api(`${SHEETS}/${id}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`, {}, signal);
			const rows: any[][] = j.values ?? [];
			const file = expand(p.path, ctx.cwd);
			await mkdir(path.dirname(file), { recursive: true });
			await writeFile(file, rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n");
			return text(`${j.range}: ${rows.length} строк → ${file}`);
		},
	});

	pi.registerTool({
		name: "sheets_write",
		label: "Записать в таблицу",
		description:
			"Записать значения в Google Таблицу начиная с ячейки диапазона (перезаписывает то, что там было). Формулы пишутся строкой с «=». Можно взять данные из CSV-файла (from_csv) вместо values.",
		parameters: Type.Object({
			spreadsheet: ref,
			range: Type.String({ description: "Куда: 'Итоги'!A1 (левый верхний угол) или полный диапазон" }),
			values: Type.Optional(values),
			from_csv: Type.Optional(Type.String({ description: "Путь к CSV-файлу на диске — записать его целиком" })),
			raw: Type.Optional(Type.Boolean({ description: "true — писать как есть, не распознавать числа/даты/формулы" })),
		}),
		async execute(_id, p, signal, _u, ctx) {
			const { id } = parseRef(p.spreadsheet);
			const rows = p.from_csv ? parseCsv(await readFile(expand(p.from_csv, ctx.cwd), "utf8")) : p.values;
			if (!rows?.length) throw new Error("Нужны values или from_csv");
			const url = `${SHEETS}/${id}/values/${encodeURIComponent(p.range)}?valueInputOption=${p.raw ? "RAW" : "USER_ENTERED"}`;
			const j = await api(url, { method: "PUT", body: JSON.stringify({ values: rows }) }, signal);
			return text(`Записано: ${j.updatedRange} (${j.updatedCells ?? 0} ячеек)`);
		},
	});

	pi.registerTool({
		name: "sheets_append",
		label: "Добавить строки",
		description: "Дописать строки в конец таблицы на листе (после последней заполненной строки). Для журналов и учёта.",
		parameters: Type.Object({
			spreadsheet: ref,
			range: Type.String({ description: "Лист или диапазон столбцов таблицы, например 'Расходы'!A:E" }),
			values,
		}),
		async execute(_id, p, signal) {
			const { id } = parseRef(p.spreadsheet);
			const url = `${SHEETS}/${id}/values/${encodeURIComponent(p.range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
			const j = await api(url, { method: "POST", body: JSON.stringify({ values: p.values }) }, signal);
			return text(`Добавлено: ${j.updates?.updatedRange} (${j.updates?.updatedRows ?? 0} строк)`);
		},
	});

	pi.registerTool({
		name: "sheets_clear",
		label: "Очистить диапазон",
		description: "Стереть значения в диапазоне (оформление остаётся). Только после явного согласия пользователя.",
		parameters: Type.Object({ spreadsheet: ref, range: Type.String({ description: "Диапазон A1" }) }),
		async execute(_id, p, signal) {
			const { id } = parseRef(p.spreadsheet);
			const j = await api(`${SHEETS}/${id}/values/${encodeURIComponent(p.range)}:clear`, { method: "POST", body: "{}" }, signal);
			return text(`Очищено: ${j.clearedRange}`);
		},
	});

	pi.registerTool({
		name: "sheets_create",
		label: "Новая таблица",
		description: "Создать новую Google Таблицу (в корне Диска пользователя). Возвращает ссылку.",
		parameters: Type.Object({
			title: Type.String(),
			sheets: Type.Optional(Type.Array(Type.String(), { description: "Имена листов; по умолчанию один «Лист1»" })),
		}),
		async execute(_id, p, signal) {
			const body: any = { properties: { title: p.title, locale: "ru_RU" } };
			if (p.sheets?.length) body.sheets = p.sheets.map((t) => ({ properties: { title: t } }));
			const j = await api(SHEETS, { method: "POST", body: JSON.stringify(body) }, signal);
			return text(`Создана «${p.title}»: ${j.spreadsheetUrl}`);
		},
	});

	pi.registerTool({
		name: "sheets_import",
		label: "Файл → Google Таблица",
		description: "Загрузить Excel (.xlsx/.xls), .ods или .csv с диска в новую Google Таблицу (конвертация Google). Возвращает ссылку.",
		parameters: Type.Object({
			path: Type.String({ description: "Путь к файлу" }),
			title: Type.Optional(Type.String({ description: "Название новой таблицы; по умолчанию имя файла" })),
		}),
		async execute(_id, p, signal, _u, ctx) {
			const file = expand(p.path, ctx.cwd);
			const data = await readFile(file);
			const ext = path.extname(file).toLowerCase();
			const mime =
				{
					".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
					".xls": "application/vnd.ms-excel",
					".ods": "application/vnd.oasis.opendocument.spreadsheet",
					".csv": "text/csv",
				}[ext] ?? "application/octet-stream";
			const meta = { name: p.title ?? path.basename(file, ext), mimeType: "application/vnd.google-apps.spreadsheet" };
			const boundary = `pi${randomBytes(8).toString("hex")}`;
			const body = Buffer.concat([
				Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`),
				Buffer.from(`--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`),
				data,
				Buffer.from(`\r\n--${boundary}--`),
			]);
			const j = await api(
				"https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink",
				{ method: "POST", body, headers: { "Content-Type": `multipart/related; boundary=${boundary}` } },
				signal,
			);
			return text(`Загружено «${j.name}»: ${j.webViewLink}`);
		},
	});

	pi.registerTool({
		name: "sheets_update",
		label: "Оформление и структура",
		description:
			"spreadsheets.batchUpdate Google Sheets API: requests — массив запросов (addSheet, deleteSheet, repeatCell для формата, updateBorders, autoResizeDimensions, setBasicFilter, sortRange, addChart, updateSheetProperties для закрепления строк, addConditionalFormatRule, сводные таблицы через updateCells/pivotTable и т.д.). sheetId — это gid листа (см. sheets_info). Примеры — в навыке tables.",
		parameters: Type.Object({
			spreadsheet: ref,
			requests: Type.Array(Type.Any(), { description: "Запросы batchUpdate" }),
		}),
		async execute(_id, p, signal) {
			const { id } = parseRef(p.spreadsheet);
			const j = await api(`${SHEETS}/${id}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests: p.requests }) }, signal);
			const replies = (j.replies ?? []).map((r: any) => JSON.stringify(r)).filter((s: string) => s !== "{}");
			return text(`Готово: ${p.requests.length} запрос(ов).${replies.length ? "\n" + replies.join("\n").slice(0, 4000) : ""}`);
		},
	});
}
