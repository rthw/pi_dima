#!/bin/bash
# Установка домашнего агента на Mac:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/rthw/pi_dima/main/install.sh)"
# Повторный запуск безопасен: уже сделанные шаги пропускаются.
# На втором компьютере тот же скрипт заберёт папку agent_home с GitHub.
set -euo pipefail

OWNER="${PI_HOME_OWNER:-rthw}"
PKG_REPO="pi_dima"
PKG_URL="https://github.com/$OWNER/$PKG_REPO"
HOME_REPO="agent_home"
HOME_DIR="$HOME/agent_home"

export PATH="$HOME/.pi/agent/bin:$HOME/.local/bin:$PATH"

step() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }
die() { printf '\n\033[31m✗ %s\033[0m\n' "$1"; exit 1; }

step "1/8 Инструменты разработчика Apple (git)"
if ! xcode-select -p >/dev/null 2>&1; then
	xcode-select --install || true
	die "В открывшемся окне нажмите «Установить», дождитесь конца и запустите эту команду ещё раз."
fi
echo "есть"

step "2/8 pi (сам агент)"
if ! command -v pi >/dev/null 2>&1; then
	echo "На вопросы установщика отвечайте Enter."
	# `| cat` — чтобы установщик не запускал pi посреди установки.
	curl -fsSL https://pi.dev/install.sh | sh | cat
	command -v pi >/dev/null 2>&1 || die "pi не нашёлся после установки — закройте Терминал, откройте заново и повторите."
fi
echo "есть: $(command -v pi)"

step "3/8 GitHub CLI (gh)"
if ! command -v gh >/dev/null 2>&1; then
	case "$(uname -m)" in arm64) arch=arm64 ;; *) arch=amd64 ;; esac
	url=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | grep -o "https://[^\"]*macOS_${arch}\.zip" | head -1 || true)
	[ -n "$url" ] || die "не нашёл gh для macOS ($arch) на GitHub — запустите команду ещё раз"
	tmp=$(mktemp -d)
	curl -fsSL "$url" -o "$tmp/gh.zip"
	unzip -q "$tmp/gh.zip" -d "$tmp"
	mkdir -p "$HOME/.local/bin"
	cp "$tmp"/gh_*/bin/gh "$HOME/.local/bin/gh"
	rm -rf "$tmp"
fi
echo "есть: $(command -v gh)"

step "4/8 Вход в GitHub"
if ! gh auth status >/dev/null 2>&1; then
	echo "Сейчас откроется браузер: войдите в GitHub и вставьте код, который покажет терминал."
	gh auth login --hostname github.com --git-protocol https --web
fi
gh auth setup-git
GH_USER=$(gh api user -q .login)
echo "вошли как $GH_USER"

step "5/8 Рабочая папка $HOME_DIR"
if [ -d "$HOME_DIR/.git" ]; then
	echo "уже есть"
elif gh repo view "$GH_USER/$HOME_REPO" >/dev/null 2>&1; then
	gh repo clone "$GH_USER/$HOME_REPO" "$HOME_DIR"
else
	tmp=$(mktemp -d)
	git clone -q --depth 1 "$PKG_URL" "$tmp/pi_home"
	mkdir -p "$HOME_DIR"
	cp -R "$tmp/pi_home/template/." "$HOME_DIR/"
	rm -rf "$tmp"
	git -C "$HOME_DIR" init -q -b main
	git -C "$HOME_DIR" add -A
	git -C "$HOME_DIR" -c user.name="$GH_USER" -c user.email="$GH_USER@users.noreply.github.com" commit -q -m "начало"
	gh repo create "$HOME_REPO" --private --source "$HOME_DIR" --push
fi
git -C "$HOME_DIR" config user.name "$GH_USER"
git -C "$HOME_DIR" config user.email "$GH_USER@users.noreply.github.com"

step "6/8 Навыки и инструменты агента"
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

step "7/8 Команда «agent»"
if ! grep -q "# pi_home" "$HOME/.zshrc" 2>/dev/null; then
	cat >>"$HOME/.zshrc" <<'EOF'

# pi_home: «agent» — открыть помощника в рабочей папке
export PATH="$HOME/.pi/agent/bin:$HOME/.local/bin:$PATH"
agent() { cd "$HOME/agent_home" && pi "$@"; }
EOF
fi

cat <<EOF

✓ Готово.

Осталось один раз ввести ключ DeepSeek:
  1. Закройте Терминал и откройте заново.
  2. Наберите: agent
  3. В pi наберите: /login  → выберите DeepSeek → вставьте ключ.

Дальше просто: открыть Терминал, набрать agent и писать по-русски.
EOF
