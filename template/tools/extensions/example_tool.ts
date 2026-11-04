/**
 * Образец своего инструмента. Скопируйте файл, поменяйте имя, описание, параметры и execute,
 * затем в pi наберите /reload — агент сразу сможет им пользоваться.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		// Имя, по которому агент вызывает инструмент: латиница и подчёркивания.
		name: "currency_rate",
		label: "Курс валют",
		// По описанию модель решает, когда звать инструмент, — пишите понятно.
		description: "Официальный курс валюты ЦБ РФ на сегодня. Например: USD, EUR, CNY.",
		// Что агент должен передать.
		parameters: Type.Object({
			code: Type.String({ description: "Код валюты, например USD" }),
		}),
		// Что инструмент делает. Возвращает текст, который прочитает агент.
		async execute(_id, params, signal) {
			const response = await fetch("https://www.cbr-xml-daily.ru/daily_json.js", { signal });
			const data = await response.json();
			const valute = data.Valute[params.code.toUpperCase()];
			if (!valute) throw new Error(`Не знаю валюту ${params.code}`);
			const text = `${valute.Nominal} ${valute.Name} = ${valute.Value} ₽ (на ${data.Date.slice(0, 10)})`;
			return { content: [{ type: "text", text }], details: undefined };
		},
	});
}
