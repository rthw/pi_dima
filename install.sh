#!/bin/bash
# Установка помощника на Mac — вставить в Терминал:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/rthw/pi_dima/main/install.sh)"
# Повторный запуск безопасен: уже сделанные шаги пропускаются.
# На втором компьютере тот же скрипт заберёт папку agent_home с GitHub.
set -euo pipefail

OWNER="${PI_HOME_OWNER:-rthw}"
PKG_REPO="pi_dima"
PKG_URL="https://github.com/$OWNER/$PKG_REPO"
HOME_REPO="agent_home"
HOME_DIR="$HOME/agent_home"
AUTH="$HOME/.pi/agent/auth.json"
PY_DIR="$HOME/.local/share/pi_home/py"
STEPS=9

export PATH="$HOME/.pi/agent/bin:$HOME/.local/bin:$PATH"

step() { printf '\n\033[1m▶ %s/%s %s\033[0m\n' "$1" "$STEPS" "$2"; }
say() { printf '  %s\n' "$@"; }
die() {
	printf '\n\033[31m✗ %s\033[0m\n' "$1"
	printf '  Когда будет готово — вставьте ту же команду ещё раз: сделанное повторно не делается.\n'
	exit 1
}
wait_enter() { read -r -p "  → $1 — нажмите Enter " _ </dev/tty; }

cat <<'EOF'

  Установка помощника для работы с таблицами (Excel, CSV) — минут 10–15.
  Понадобятся:
    • аккаунт на GitHub (бесплатный) — там будут храниться ваши записи;
    • ключ DeepSeek — «мозги» помощника, оплата по факту, обычно пара долларов в месяц.
  Скрипт сам скажет, что и где нажать. Пароль от Mac он не спрашивает.
EOF
wait_enter "Начинаем?"

step 1 "Инструменты разработчика Apple"
if ! xcode-select -p >/dev/null 2>&1; then
	xcode-select --install >/dev/null 2>&1 || true
	say "Появится окно «Установить инструменты разработчика»: нажмите «Установить» и «Принять»." \
		"Это займёт 5–10 минут."
	die "После окончания установки снова вставьте команду в Терминал."
fi
say "есть"

step 2 "pi — сам помощник"
if ! command -v pi >/dev/null 2>&1; then
	say "Если установщик что-то спросит — просто нажимайте Enter."
	# `| cat` — чтобы установщик не запускал pi посреди установки.
	curl -fsSL https://pi.dev/install.sh | sh | cat
	command -v pi >/dev/null 2>&1 || die "pi не нашёлся после установки. Закройте Терминал (Cmd+Q), откройте заново."
fi
say "есть"

step 3 "GitHub CLI"
if ! command -v gh >/dev/null 2>&1; then
	case "$(uname -m)" in arm64) arch=arm64 ;; *) arch=amd64 ;; esac
	url=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | grep -o "https://[^\"]*macOS_${arch}\.zip" | head -1 || true)
	[ -n "$url" ] || die "Не получилось скачать GitHub CLI — проверьте интернет."
	tmp=$(mktemp -d)
	curl -fsSL "$url" -o "$tmp/gh.zip"
	unzip -q "$tmp/gh.zip" -d "$tmp"
	mkdir -p "$HOME/.local/bin"
	cp "$tmp"/gh_*/bin/gh "$HOME/.local/bin/gh"
	rm -rf "$tmp"
fi
say "есть"

step 4 "Вход в GitHub"
if ! gh auth status >/dev/null 2>&1; then
	say "Если аккаунта на GitHub ещё нет — заведите: https://github.com/signup" \
		"(email, пароль, имя латиницей; GitHub пришлёт код на почту)." \
		"" \
		"Дальше Терминал покажет код вида ABCD-1234 и попросит нажать Enter:" \
		"  1. запомните или скопируйте код;" \
		"  2. нажмите Enter — откроется браузер;" \
		"  3. войдите в GitHub, вставьте код, нажмите «Continue» и «Authorize»;" \
		"  4. вернитесь в Терминал."
	wait_enter "Аккаунт есть, готовы войти?"
	gh auth login --hostname github.com --git-protocol https --web </dev/tty || die "Вход в GitHub не завершился."
fi
gh auth setup-git
GH_USER=$(gh api user -q .login)
say "вошли как $GH_USER"

step 5 "Рабочая папка ~/agent_home"
if [ -d "$HOME_DIR/.git" ]; then
	say "уже есть"
elif gh repo view "$GH_USER/$HOME_REPO" >/dev/null 2>&1; then
	gh repo clone "$GH_USER/$HOME_REPO" "$HOME_DIR"
	say "забрал с GitHub"
else
	tmp=$(mktemp -d)
	git clone -q --depth 1 "$PKG_URL" "$tmp/pkg"
	mkdir -p "$HOME_DIR"
	cp -R "$tmp/pkg/template/." "$HOME_DIR/"
	rm -rf "$tmp"
	git -C "$HOME_DIR" init -q -b main
	git -C "$HOME_DIR" add -A
	git -C "$HOME_DIR" -c user.name="$GH_USER" -c user.email="$GH_USER@users.noreply.github.com" commit -q -m "начало"
	gh repo create "$HOME_REPO" --private --source "$HOME_DIR" --push >/dev/null
	say "создана; копия — в закрытом (приватном) репозитории $GH_USER/$HOME_REPO, видите её только вы"
fi
git -C "$HOME_DIR" config user.name "$GH_USER"
git -C "$HOME_DIR" config user.email "$GH_USER@users.noreply.github.com"

step 6 "Навыки помощника"
pi install "git:github.com/$OWNER/$PKG_REPO"
pi install "$HOME_DIR/tools"
python3 - "$HOME/.pi/agent/settings.json" <<'EOF'
import json, os, sys
path = sys.argv[1]
settings = json.load(open(path)) if os.path.exists(path) else {}
settings.update(defaultProvider="deepseek", defaultModel="deepseek-flash", quietStartup=True)
settings.setdefault("enabledModels", ["deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"])
json.dump(settings, open(path, "w"), ensure_ascii=False, indent=2)
EOF
say "есть"

step 7 "Python для таблиц (Excel, CSV, графики)"
if ! command -v uv >/dev/null 2>&1; then
	curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR="$HOME/.local/bin" INSTALLER_NO_MODIFY_PATH=1 sh >/dev/null
fi
[ -x "$PY_DIR/bin/python" ] || uv venv -q --python 3.12 "$PY_DIR"
uv pip install -q --python "$PY_DIR/bin/python" pandas openpyxl xlsxwriter xlrd odfpy matplotlib
mkdir -p "$HOME/.local/bin"
rm -f "$HOME/.local/bin/tpy"
printf '#!/bin/sh\nexec "%s/bin/python" "$@"\n' "$PY_DIR" >"$HOME/.local/bin/tpy"
chmod +x "$HOME/.local/bin/tpy"
tpy -c "import pandas, openpyxl, xlsxwriter, matplotlib" || die "Python для таблиц не собрался."
say "есть"

step 8 "Ключ DeepSeek"
key_ok() {
	curl -fsS -o /dev/null -H "Authorization: Bearer $1" https://api.deepseek.com/user/balance 2>/dev/null
}
if [ -f "$AUTH" ] && grep -q '"deepseek"' "$AUTH"; then
	say "уже введён"
else
	say "1. Откройте https://platform.deepseek.com и зарегистрируйтесь (почта или телефон)." \
		"2. Слева «Top up» — пополните баланс (хватит \$2–5, карта или PayPal)." \
		"3. Слева «API keys» → «Create new API key» → любое имя → «Create»." \
		"4. Скопируйте ключ (начинается с sk-) — его покажут один раз." \
		"5. Вставьте сюда (Cmd+V) и нажмите Enter. Символы не отображаются — так и надо."
	while :; do
		read -r -s -p "  Ключ: " key </dev/tty
		echo
		key=$(printf '%s' "$key" | tr -d '[:space:]')
		[ -n "$key" ] || die "Ключ не введён."
		if key_ok "$key"; then break; fi
		say "DeepSeek этот ключ не принял — скопируйте ещё раз (целиком, с sk-) и вставьте."
	done
	mkdir -p "$(dirname "$AUTH")"
	KEY="$key" python3 - "$AUTH" <<'EOF'
import json, os, sys
path = sys.argv[1]
auth = json.load(open(path)) if os.path.exists(path) else {}
auth["deepseek"] = {"type": "api_key", "key": os.environ["KEY"]}
json.dump(auth, open(path, "w"), indent=2)
os.chmod(path, 0o600)
EOF
	unset key
	say "ключ принят и сохранён"
fi

step 9 "Команда «agent»"
# Терминал на старых маках запускает bash, на новых — zsh: прописываем в оба.
for rc in "$HOME/.zshrc" "$HOME/.bash_profile"; do
	grep -q "# pi_home" "$rc" 2>/dev/null && continue
	cat >>"$rc" <<'EOF'

# pi_home: «agent» — открыть помощника в рабочей папке
export PATH="$HOME/.pi/agent/bin:$HOME/.local/bin:$PATH"
agent() { cd "$HOME/agent_home" && pi "$@"; }
EOF
done
say "есть"

cat <<'EOF'

✓ Готово! Как пользоваться:

  1. Закройте Терминал (Cmd+Q) и откройте снова.
  2. Наберите  agent  и нажмите Enter.
  3. Пишите по-русски, как человеку. Например:
       «В Загрузках выгрузка продаж — посчитай по менеджерам за октябрь, сделай Excel с графиком»
       «Сведи три файла из папки Отчёты в один и убери дубли»
       «Сравни остатки в двух таблицах — чего нет во второй?»
     Ваши файлы помощник не портит: работает с копиями, результат — новым файлом.
  4. Выход — Ctrl+C два раза. Новый разговор — /new.

  Если что-то сломалось — вставьте установочную команду ещё раз.
EOF
