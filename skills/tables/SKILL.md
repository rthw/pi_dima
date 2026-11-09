---
name: tables
description: "Работа с таблицами-файлами: Excel (.xlsx/.xls), CSV, .ods — посмотреть, посчитать, свести, почистить дубли, объединить, построить график, сделать отчёт в Excel. Читай всякий раз, когда речь о таблице, листе, столбцах, Excel, csv, выгрузке, отчёте по данным, сводной, формулах."
---

# Таблицы (файлы)

Считать — Python с pandas. Команда `tpy` — это Python, где уже стоят `pandas`, `openpyxl`, `xlsxwriter`, `matplotlib`.
Обычный `python3` их не имеет — всегда `tpy`. Если `tpy` нет — скажи пользователю перезапустить установку
(команда из README pi_dima), сам ничего не ставь.

## Как работать

1. **Найти файл.** Назвал — ищи в Загрузках, Документах, на Рабочем столе (`file_list ~/Downloads`,
   `find ~/Documents ~/Desktop ~/Downloads -iname '*имя*' -newermt '-60 days'`). Несколько похожих — покажи и спроси.
2. **Не трогать оригинал.** Скопируй его в `work/<тема>/` и работай с копией. Оригинал пользователя не перезаписывай никогда.
3. **Понять устройство:**
   ```sh
   tpy <папка навыка>/peek.py "work/<тема>/файл.xlsx"            # листы, столбцы, типы, примеры, первые строки
   tpy <папка навыка>/peek.py файл.xlsx --sheet "Лист2" --header 2  # заголовки не в первой строке
   ```
   Шапка в несколько строк, объединённые ячейки, итоги внизу, пустые строки-разделители — частое дело:
   найди, где настоящие заголовки и данные. Если смысл столбца неясен — спроси, не гадай.
4. **Посчитать скриптом**, не в уме. Скрипт клади в `work/<тема>/расчёт.py` — его можно перезапустить,
   когда придёт новый месяц. Ключевые числа перепроверь вторым способом (например, общая сумма до и после группировки).
5. **Отдать результат** новым файлом `work/<тема>/<что>_<ГГГГ-ММ-ДД>.xlsx` и открыть его: `open <файл>`.
   Скажи коротко: что нашёл, главные цифры, где лежит файл.
6. Важное — в память: `memory/notes/таблицы.md` (какие файлы бывают, что в каких столбцах, как их считали).

## Приёмы pandas

```python
import pandas as pd
df = pd.read_excel("файл.xlsx", sheet_name="Лист1", header=0)        # sheet_name=None — все листы словарём
df = pd.read_csv("файл.csv", sep=None, engine="python", encoding="utf-8-sig")  # 1С/банки часто cp1251 и «;»

# чистка
df.columns = df.columns.astype(str).str.strip()
df = df.dropna(how="all")                                             # пустые строки
df["Сумма"] = pd.to_numeric(df["Сумма"].astype(str).str.replace(r"[\s ₽р.]", "", regex=True).str.replace(",", "."), errors="coerce")
df["Дата"] = pd.to_datetime(df["Дата"], dayfirst=True, errors="coerce")
df = df.drop_duplicates()                                            # или subset=["ИНН", "Дата"]

# свести
df["Месяц"] = df["Дата"].dt.strftime("%Y-%m")                         # столбец, а не выражение — иначе margins падает
pv = df.pivot_table(index="Менеджер", columns="Месяц", values="Сумма", aggfunc="sum", fill_value=0, margins=True, margins_name="Итого")
top = df.groupby("Клиент", as_index=False)["Сумма"].sum().sort_values("Сумма", ascending=False)

# объединить
all_ = pd.concat([pd.read_excel(f) for f in files], ignore_index=True)
m = a.merge(b, on="Артикул", how="left", indicator=True)               # _merge == "left_only" — нет во второй
```

## Красивый Excel на выходе

```python
with pd.ExcelWriter(out, engine="xlsxwriter") as xw:
    for name, t in {"Сводка": pv, "Данные": df}.items():
        t.to_excel(xw, sheet_name=name, index=name == "Сводка")
        ws, wb = xw.sheets[name], xw.book
        ws.freeze_panes(1, 0)
        ws.autofilter(0, 0, len(t), len(t.columns) - (name != "Сводка"))
        money = wb.add_format({"num_format": "# ##0.00 ₽"})
        for i, col in enumerate(t.columns, start=int(name == "Сводка")):
            width = min(max(len(str(col)), t[col].astype(str).str.len().max() if len(t) else 0) + 2, 50)
            ws.set_column(i, i, width, money if pd.api.types.is_float_dtype(t[col]) else None)
    # график прямо в Excel
    ch = wb.add_chart({"type": "column"})
    ch.add_series({"name": "Сумма", "categories": ["Сводка", 1, 0, len(pv) - 1, 0], "values": ["Сводка", 1, 1, len(pv) - 1, 1]})
    xw.sheets["Сводка"].insert_chart("H2", ch)
```

- Формулы, если пользователь будет менять данные сам: `ws.write_formula("D2", "=B2*C2")` — иначе просто числа.
- Условное выделение: `ws.conditional_format("D2:D500", {"type": "cell", "criteria": "<", "value": 0, "format": red})`.
- Картинка-график (для письма/мессенджера) — `matplotlib`, `savefig("work/<тема>/график.png", dpi=150)`.
- Дописать лист в существующую книгу, не трогая остальные: `pd.ExcelWriter(path, engine="openpyxl", mode="a", if_sheet_exists="replace")` — только для копии в `work/`.

## Подводные камни

- Excel хранит даты числами (45000 и т.п.) — `pd.to_datetime(x, unit="D", origin="1899-12-30")`.
- Числа текстом с пробелами и запятой — чистить, как выше, иначе сумма будет неверной молча.
- `read_excel` читает значения формул, сохранённые Excel'ем; файл, созданный не в Excel, может отдать пустоту вместо результатов формул — скажи об этом.
- `.xls` (старый формат) — если не читается, попроси пересохранить в .xlsx.
- Numbers (`.numbers`) не читается: попроси «Файл → Экспортировать → Excel».
