#!/bin/bash
# Анализ неучтённой электроэнергии. При первом запуске ставит библиотеки Python в ~/.cache/pi_home/elektro_venv
# (одна-две минуты, нужен интернет), дальше запускается сразу.
#   bash run.sh ТАБЛИЦА.csv ПАПКА_ДЛЯ_ОТЧЁТА [--lat 47.22 --lon 39.72] [--head-codes ТП,РГ] [--title "…"]
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
VENV="$HOME/.cache/pi_home/elektro_venv"
if ! "$VENV/bin/python" -c "import pandas, matplotlib, statsmodels" >/dev/null 2>&1; then
	echo "Первый запуск: ставлю библиотеки для расчёта (pandas, matplotlib, statsmodels)…"
	mkdir -p "$(dirname "$VENV")"
	python3 -m venv --clear "$VENV"
	"$VENV/bin/python" -m pip install -q --upgrade pip
	"$VENV/bin/python" -m pip install -q numpy pandas matplotlib statsmodels
fi
exec "$VENV/bin/python" -I "$DIR/analyze.py" "$@"
