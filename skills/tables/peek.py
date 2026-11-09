"""Обзор табличного файла: листы, размеры, столбцы (тип, пустые, примеры), первые строки.

    tpy peek.py ФАЙЛ [--sheet ИМЯ] [--rows N] [--header N]

Понимает .xlsx/.xlsm/.xls, .csv/.tsv/.txt (кодировку и разделитель угадывает), .ods.
"""

import argparse
import sys
from pathlib import Path

import pandas as pd

pd.set_option("display.width", 200)
pd.set_option("display.max_columns", 40)
pd.set_option("display.max_colwidth", 30)


def read_csv(path: Path, header):
    for enc in ("utf-8-sig", "cp1251", "latin-1"):
        try:
            return pd.read_csv(path, sep=None, engine="python", encoding=enc, header=header), enc
        except UnicodeDecodeError:
            continue
    raise SystemExit(f"не смог прочитать {path}: неизвестная кодировка")


def describe(df: pd.DataFrame, rows: int) -> None:
    print(f"  {len(df)} строк × {len(df.columns)} столбцов")
    for i, col in enumerate(df.columns):
        s = df[col]
        empty = int(s.isna().sum())
        sample = ", ".join(str(v)[:25] for v in s.dropna().unique()[:3])
        letter = ""
        n = i + 1
        while n:
            n, r = divmod(n - 1, 26)
            letter = chr(65 + r) + letter
        print(f"  {letter:>3} {str(col)[:40]!s:40} {str(s.dtype):10} пустых {empty:<6} напр.: {sample}")
    print(f"\n  первые {rows} строк:")
    print(df.head(rows).to_string(max_rows=rows))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--sheet")
    ap.add_argument("--rows", type=int, default=10)
    ap.add_argument("--header", type=int, default=0, help="номер строки заголовков (с 0); -1 — без заголовков")
    a = ap.parse_args()
    path = Path(a.file).expanduser()
    header = None if a.header < 0 else a.header
    ext = path.suffix.lower()

    if ext in (".csv", ".tsv", ".txt"):
        df, enc = read_csv(path, header)
        print(f"{path.name} (CSV, {enc})")
        describe(df, a.rows)
        return

    sheets = pd.read_excel(path, sheet_name=None, header=header)
    print(f"{path.name}: листов {len(sheets)} — " + ", ".join(f"«{n}» ({len(d)}×{len(d.columns)})" for n, d in sheets.items()))
    names = [a.sheet] if a.sheet else list(sheets)[:3]
    for name in names:
        if name not in sheets:
            sys.exit(f"нет листа «{name}»")
        print(f"\n== лист «{name}»")
        describe(sheets[name], a.rows)
    if not a.sheet and len(sheets) > 3:
        print(f"\n(показаны первые 3 листа; остальные — --sheet ИМЯ)")


if __name__ == "__main__":
    main()
