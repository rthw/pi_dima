---
name: tables
description: "Работа с Google Таблицами: найти таблицу, прочитать, посчитать, свести, заполнить, оформить, построить график, перенести Excel в Google. Читай всякий раз, когда речь о таблице, листе, ячейках, ссылке docs.google.com/spreadsheets, Excel/xlsx/csv, отчёте по данным, сводной, формулах."
---

# Google Таблицы

Тулы: `sheets_find`, `sheets_info`, `sheets_read`, `sheets_export` — читать;
`sheets_write`, `sheets_append`, `sheets_clear`, `sheets_create`, `sheets_import`, `sheets_update` — менять.

## Первый раз

1. Если тул говорит «нет файла ключа приложения» — ключ (`google_client.json`) присылает Макс.
   Найди его в Загрузках (`file_list ~/Downloads`) и положи: `mkdir -p ~/.config/pi_home && cp <файл> ~/.config/pi_home/google_client.json`.
2. «Нет входа в Google» — вызови `google_login`. Предупреди: откроется браузер, выбрать свой аккаунт;
   Google покажет «Приложение не проверено» — нажать «Дополнительно» → «Перейти…» и поставить все галочки доступа.
   Это нормально: приложение личное, его сделал Макс.

## Как работать

1. **Найти.** Дали ссылку — работай по ней. Назвали словами — `sheets_find` по части названия, покажи варианты, если их несколько.
2. **Понять устройство.** `sheets_info` (листы и размеры), затем `sheets_read` первых ~30 строк нужного листа:
   где заголовки, что в столбцах, единицы, формат дат. Если непонятно, что значит столбец, — спроси, не гадай.
3. **Посчитать.**
   - До ~500 строк — читай `sheets_read` и считай сам, но числа, на которые опирается вывод, перепроверяй.
   - Больше или нужна точность (суммы, группировки, сверка) — `sheets_export` в `work/<тема>/данные.csv`
     и считай `python3` (только стандартная библиотека: `csv`, `statistics`, `collections`, `datetime`).
     Скрипт клади рядом в `work/<тема>/` — его можно перезапустить на свежих данных.
   - Если результат должен жить в таблице и обновляться сам — пиши формулы (`=SUMIFS`, `=QUERY`, `=FILTER`,
     `=XLOOKUP`, `=UNIQUE`), а не готовые числа. Локаль таблиц русская: в формулах разделитель аргументов — `;`
     только при вводе руками; через API пиши с запятой `,` — Google сам переведёт.
4. **Записать.**
   - Результаты — на **новый лист** («Итоги», «Сводка ноябрь») или в новую таблицу, а не поверх данных.
   - Перед перезаписью, очисткой (`sheets_clear`) или удалением листа в чужих данных — спроси явно, что именно меняешь.
   - После записи — `sheets_read` записанного диапазона и ссылка пользователю.
   - Строки в журнал/учёт — `sheets_append`.
   - Большой CSV в таблицу — `sheets_write` с `from_csv`.
5. **Excel-файл.** `.xlsx` с диска → `sheets_import` (станет Google Таблицей), дальше как обычно.
6. **Объяснить.** Коротко: что нашёл, главные цифры, где лежит результат (ссылка). Важные выводы и где какая
   таблица — запиши в `memory/notes/` (например, `таблицы.md`: название, ссылка, что в ней).

## Адреса

- Диапазон: `'Лист 1'!A1:F100`, имя листа в одинарных кавычках. Весь столбец — `'Лист 1'!A:F`.
- `sheetId` в `sheets_update` = gid листа из `sheets_info` (или `#gid=` в ссылке).
- Индексы в `sheets_update` с нуля и конец не включается: строки 1–1 → `startRowIndex: 0, endRowIndex: 1`.

## Примеры `sheets_update`

Новый лист:
```json
[{"addSheet": {"properties": {"title": "Итоги"}}}]
```

Шапка жирная, серый фон, закрепить первую строку, ширина по содержимому:
```json
[
 {"repeatCell": {"range": {"sheetId": 0, "startRowIndex": 0, "endRowIndex": 1},
   "cell": {"userEnteredFormat": {"textFormat": {"bold": true}, "backgroundColor": {"red": 0.9, "green": 0.9, "blue": 0.9}}},
   "fields": "userEnteredFormat(textFormat,backgroundColor)"}},
 {"updateSheetProperties": {"properties": {"sheetId": 0, "gridProperties": {"frozenRowCount": 1}}, "fields": "gridProperties.frozenRowCount"}},
 {"autoResizeDimensions": {"dimensions": {"sheetId": 0, "dimension": "COLUMNS", "startIndex": 0, "endIndex": 10}}}
]
```

Формат чисел (рубли) в столбце C:
```json
[{"repeatCell": {"range": {"sheetId": 0, "startRowIndex": 1, "startColumnIndex": 2, "endColumnIndex": 3},
  "cell": {"userEnteredFormat": {"numberFormat": {"type": "NUMBER", "pattern": "#,##0.00 ₽"}}},
  "fields": "userEnteredFormat.numberFormat"}}]
```

Фильтр на диапазон и сортировка по столбцу B по убыванию:
```json
[
 {"setBasicFilter": {"filter": {"range": {"sheetId": 0, "startRowIndex": 0, "endRowIndex": 500, "startColumnIndex": 0, "endColumnIndex": 6}}}},
 {"sortRange": {"range": {"sheetId": 0, "startRowIndex": 1, "endRowIndex": 500, "startColumnIndex": 0, "endColumnIndex": 6},
   "sortSpecs": [{"dimensionIndex": 1, "sortOrder": "DESCENDING"}]}}
]
```

Подсветить красным отрицательные в D:
```json
[{"addConditionalFormatRule": {"index": 0, "rule": {
  "ranges": [{"sheetId": 0, "startRowIndex": 1, "startColumnIndex": 3, "endColumnIndex": 4}],
  "booleanRule": {"condition": {"type": "NUMBER_LESS", "values": [{"userEnteredValue": "0"}]},
    "format": {"textFormat": {"foregroundColor": {"red": 0.8, "green": 0, "blue": 0}}}}}}}]
```

Сводная таблица (сумма столбца C по значениям A) на лист с gid 123, источник — лист gid 0:
```json
[{"updateCells": {"start": {"sheetId": 123, "rowIndex": 0, "columnIndex": 0}, "fields": "pivotTable",
  "rows": [{"values": [{"pivotTable": {
    "source": {"sheetId": 0, "startRowIndex": 0, "endRowIndex": 1000, "startColumnIndex": 0, "endColumnIndex": 5},
    "rows": [{"sourceColumnOffset": 0, "showTotals": true, "sortOrder": "ASCENDING"}],
    "values": [{"summarizeFunction": "SUM", "sourceColumnOffset": 2}]}}]}]}}]
```

График (столбцы: подписи из A, значения из B, строки 1–13) на лист gid 123:
```json
[{"addChart": {"chart": {"spec": {"title": "Продажи по месяцам", "basicChart": {
   "chartType": "COLUMN", "legendPosition": "NO_LEGEND", "headerCount": 1,
   "domains": [{"domain": {"sourceRange": {"sources": [{"sheetId": 0, "startRowIndex": 0, "endRowIndex": 13, "startColumnIndex": 0, "endColumnIndex": 1}]}}}],
   "series": [{"series": {"sourceRange": {"sources": [{"sheetId": 0, "startRowIndex": 0, "endRowIndex": 13, "startColumnIndex": 1, "endColumnIndex": 2}]}}}]}},
  "position": {"overlayPosition": {"anchorCell": {"sheetId": 123, "rowIndex": 0, "columnIndex": 4}}}}}}]
```
`chartType`: `COLUMN`, `BAR`, `LINE`, `AREA`; для круговой — `pieChart` вместо `basicChart`.

## Ошибки

- «Не найдено / нет доступа» — таблица чужая и не расшарена на аккаунт, под которым вошли. Попроси владельца
  дать доступ или открыть её в браузере под нужным аккаунтом.
- «Нужно войти заново» — `google_login`.
- `Unable to parse range` — имя листа с пробелами без кавычек или лист называется иначе: проверь `sheets_info`.
