/**
 * Поиск в интернете и чтение страниц.
 *
 * web_search — Search API DeepSeek (тот же ключ, что у модели), при сбое — DuckDuckGo без ключа.
 * web_fetch  — Fetch API DeepSeek (страница → Markdown), при сбое — обычный HTTP + вырезание тегов.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const API = "https://api.deepseek.com/v1/tools";
const MAX_PAGE_CHARS = 30_000;

interface Hit {
	title: string;
	url: string;
	text: string;
	date?: string | null;
}

async function deepseekKey(ctx: ExtensionContext): Promise<string | undefined> {
	const model = ctx.modelRegistry.getAll().find((m) => m.provider === "deepseek");
	if (!model) return process.env.DEEPSEEK_API_KEY;
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	return (auth.ok && auth.apiKey) || process.env.DEEPSEEK_API_KEY;
}

async function deepseek(path: string, key: string, body: object, signal?: AbortSignal): Promise<any> {
	const response = await fetch(`${API}/${path}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});
	if (response.status === 402) throw new Error("DeepSeek: закончился баланс, нужно пополнить");
	if (!response.ok) throw new Error(`DeepSeek ${path}: HTTP ${response.status}`);
	return response.json();
}

function stripHtml(html: string): string {
	return html
		.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
		.replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&quot;/g, '"')
		.replace(/&#x27;|&#39;|&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.replace(/[ \t]+/g, " ")
		.replace(/\n\s*\n+/g, "\n\n")
		.trim();
}

async function searchDuckDuckGo(query: string, limit: number, signal?: AbortSignal): Promise<Hit[]> {
	const url = new URL("https://html.duckduckgo.com/html/");
	url.searchParams.set("q", query);
	const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (pi_home)" }, signal });
	if (!response.ok) throw new Error(`DuckDuckGo: HTTP ${response.status}`);
	const html = await response.text();
	const titles = [...html.matchAll(/<a rel="nofollow" class="result__a" href="([^"]+)">([\s\S]*?)<\/a>/g)];
	const snippets = [...html.matchAll(/<a class="result__snippet" href="[^"]+">([\s\S]*?)<\/a>/g)];
	const hits: Hit[] = [];
	for (let i = 0; i < titles.length && hits.length < limit; i++) {
		const target = new URL(titles[i][1], "https://duckduckgo.com").searchParams.get("uddg");
		if (!target) continue;
		hits.push({ title: stripHtml(titles[i][2]), url: target, text: stripHtml(snippets[i]?.[1] ?? "") });
	}
	if (hits.length === 0) throw new Error("DuckDuckGo: пустая выдача");
	return hits;
}

function formatHits(hits: Hit[]): string {
	return hits
		.map((h, i) => `[${i + 1}] ${h.title}${h.date ? ` (${h.date})` : ""}\n${h.url}\n${h.text}`)
		.join("\n\n");
}

function cut(text: string): string {
	return text.length > MAX_PAGE_CHARS
		? `${text.slice(0, MAX_PAGE_CHARS)}\n\n[…обрезано, всего ${text.length} символов]`
		: text;
}

export default function web(pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Поиск",
		description:
			"Поиск в интернете. Возвращает список результатов: заголовок, ссылка, краткое содержание. " +
			"Поддерживает операторы в запросе: site:домен, \"точная фраза\", -site:, after:2026-01-01.",
		promptSnippet: "Поиск в интернете (новости, факты, цены, инструкции)",
		promptGuidelines: [
			"Для вопросов о фактах, новостях, ценах, расписаниях и всём, что могло измениться, используй web_search, а не память модели.",
			"Если краткого содержания мало — открой 1–3 лучшие ссылки через web_fetch.",
			"В ответе пользователю указывай источники ссылками.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Короткий поисковый запрос (до 128 символов)" }),
			question: Type.Optional(Type.String({ description: "Исходный вопрос пользователя целиком — улучшает ранжирование" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 15, description: "Сколько результатов (по умолчанию 6)" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const limit = params.limit ?? 6;
			const notes: string[] = [];
			const key = await deepseekKey(ctx);
			if (key) {
				try {
					const data = await deepseek(
						"search",
						key,
						{ query: params.query.slice(0, 128), count: limit, ...(params.question ? { ori_question: params.question } : {}) },
						signal,
					);
					const hits: Hit[] = (data.results ?? []).map((r: any) => ({
						title: r.title ?? "",
						url: r.url ?? r.URL ?? "",
						text: String(r.summary ?? r.snippet ?? "").slice(0, 1200),
						date: r.date,
					}));
					if (hits.length > 0) {
						return { content: [{ type: "text", text: formatHits(hits) }], details: { source: "deepseek", count: hits.length } };
					}
					notes.push("DeepSeek: пустая выдача");
				} catch (err) {
					notes.push(err instanceof Error ? err.message : String(err));
				}
			} else {
				notes.push("нет ключа DeepSeek");
			}
			const hits = await searchDuckDuckGo(params.query, limit, signal);
			return {
				content: [{ type: "text", text: `${formatHits(hits)}\n\n[через DuckDuckGo: ${notes.join("; ")}]` }],
				details: { source: "duckduckgo", count: hits.length },
			};
		},
	});

	pi.registerTool({
		name: "web_fetch",
		label: "Открыть страницу",
		description: "Скачать веб-страницу по ссылке и вернуть её текст (Markdown). Длинные страницы обрезаются.",
		promptSnippet: "Прочитать страницу по ссылке",
		parameters: Type.Object({
			url: Type.String({ description: "Полная ссылка http(s)://…" }),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const notes: string[] = [];
			const key = await deepseekKey(ctx);
			if (key) {
				try {
					const data = await deepseek("fetch", key, { url: params.url }, signal);
					if (data.content) {
						const title = data.title ? `# ${data.title}\n\n` : "";
						return { content: [{ type: "text", text: cut(title + data.content) }], details: { source: "deepseek" } };
					}
					notes.push("DeepSeek: пустая страница");
				} catch (err) {
					notes.push(err instanceof Error ? err.message : String(err));
				}
			}
			const response = await fetch(params.url, { headers: { "User-Agent": "Mozilla/5.0 (pi_home)" }, signal });
			if (!response.ok) throw new Error(`HTTP ${response.status} (${notes.join("; ")})`);
			const type = response.headers.get("content-type") ?? "";
			const raw = await response.text();
			const text = type.includes("html") ? stripHtml(raw) : raw;
			return { content: [{ type: "text", text: cut(text) }], details: { source: "http" } };
		},
	});
}
