"""Неучтённая электроэнергия: кто из потребителей связан с разницей «головной счётчик − сумма счётчиков».

Вход — CSV-выгрузка сводной таблицы показаний (строка заголовка с месяцами вида «янв.22», «мая22»;
в строках: № п/п, № счётчика, год, код юр. лица, помещение, коэф. трансформации, коэф. надбавки, …, показания по месяцам).
Выход — папка с report.html, report.pdf (если есть чем напечатать), summary.md и summary.json.

Запуск: run.sh ТАБЛИЦА.csv ПАПКА_ДЛЯ_ОТЧЁТА [--lat 47.22 --lon 39.72] [--head-codes ТП,РГ]
"""
import argparse, csv, json, os, re, shutil, subprocess, sys, urllib.request, warnings
from datetime import date

warnings.filterwarnings('ignore')
import numpy as np
import pandas as pd
import statsmodels.api as sm
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.dates as mdates

MONTHS = [('янв', 1), ('фев', 2), ('мар', 3), ('апр', 4), ('мая', 5), ('май', 5), ('июн', 6), ('июл', 7),
          ('авг', 8), ('сен', 9), ('окт', 10), ('ноя', 11), ('дек', 12)]


def num(s):
    s = (s or '').replace('\xa0', '').replace(' ', '').replace(' ', '').replace('₽', '').replace(',', '.').strip()
    try:
        return float(s)
    except ValueError:
        return np.nan


def month_of(cell):
    c = cell.strip().lower()
    m = re.match(r'^([а-я]+)\.?\s*(\d{2}|\d{4})$', c)
    if not m:
        return None
    for pre, mo in MONTHS:
        if m.group(1).startswith(pre):
            y = int(m.group(2))
            return pd.Period(year=y + 2000 if y < 100 else y, month=mo, freq='M')
    return None


# ---------------------------------------------------------------- чтение таблицы
def read_sheet(path, head_codes):
    rows = list(csv.reader(open(path, encoding='utf-8-sig')))
    hdr_i = next(i for i, r in enumerate(rows) if sum(month_of(c) is not None for c in r) >= 6)
    hdr = rows[hdr_i]
    mcols = [(j, month_of(c)) for j, c in enumerate(hdr) if month_of(c) is not None]
    tariff = {}
    for r in rows[:hdr_i]:
        if any(c.strip().lower() == 'тариф' for c in r):
            for j, p in mcols:
                if j < len(r) and not np.isnan(num(r[j])):
                    tariff[p] = num(r[j])
    meters = []
    for r in rows[hdr_i + 1:]:
        if not r or not re.match(r'^\d+$', r[0].strip()):
            continue
        reads = pd.Series({p: (num(r[j]) if j < len(r) else np.nan) for j, p in mcols})
        code, name = r[3].strip(), r[4].strip()
        is_head = (code.upper() in head_codes) or ('головн' in name.lower()) or ('ргэс' in name.lower())
        meters.append(dict(no=int(r[0]), serial=r[1].strip(), year=r[2].strip(), ent=code or name, name=name,
                           ktr=num(r[5]) if not np.isnan(num(r[5])) else 1.0,
                           k=num(r[6]) if not np.isnan(num(r[6])) else 1.0, reads=reads, head=is_head))
    if not meters:
        sys.exit('Не нашёл строк со счётчиками (первая колонка — номер п/п).')
    heads = [m for m in meters if m['head']]
    if not heads:
        sys.exit('Не нашёл головной счётчик: нужна строка с «головной» или «РГЭС» в названии, или укажите --head-codes.')
    # период: от первого до последнего месяца, где у головного есть показания
    hv = pd.concat([m['reads'] for m in heads], axis=1).dropna(how='all')
    idx = pd.period_range(hv.index.min(), hv.index.max(), freq='M')
    for m in meters:
        m['reads'] = m['reads'].reindex(idx)
        m['cons'] = (m['reads'].diff() * m['ktr']).iloc[1:]
    names = {}
    codes = set(m['ent'] for m in meters)
    for r in rows:
        for c in r:
            mm = re.match(r'^\s*(.+?)\s*\(([^()]{1,4})\)\s*$', c)
            if mm and mm.group(2).strip() in codes:
                nm_ = mm.group(1).strip(' "')
                if nm_.count('«') > nm_.count('»'):
                    nm_ = nm_.replace('«', '', 1).strip()
                names.setdefault(mm.group(2).strip(), nm_)
    for m in meters:
        if not m['head']:
            names.setdefault(m['ent'], m['name'].strip(' «»"'))
    return meters, idx[1:], pd.Series(tariff), names


def weather(idx, lat, lon):
    start = idx[0].to_timestamp().strftime('%Y-%m-%d')
    end = min(idx[-1].to_timestamp(how='end').date(), date.today()).strftime('%Y-%m-%d')
    url = (f'https://archive-api.open-meteo.com/v1/archive?latitude={lat}&longitude={lon}'
           f'&start_date={start}&end_date={end}&daily=temperature_2m_mean&timezone=Europe%2FMoscow')
    try:
        d = json.load(urllib.request.urlopen(url, timeout=30))['daily']
        t = pd.Series(d['temperature_2m_mean'], index=pd.to_datetime(d['time'])).astype(float)
        try:
            rs = lambda z: z.resample('ME').sum()
            rs(t)
        except ValueError:
            rs = lambda z: z.resample('M').sum()
        W = pd.DataFrame({'HDD': rs((18 - t).clip(lower=0)), 'CDD': rs((t - 22).clip(lower=0))})
        W.index = W.index.to_period('M')
        return W.reindex(idx).fillna(0.0), True
    except Exception:
        return pd.DataFrame({'HDD': 0.0, 'CDD': 0.0}, index=idx), False


def agg(x, k):
    g = np.arange(len(x)) // k
    o = x.groupby(g).sum()
    return o.iloc[:len(x) // k]


def ols(y, X, hac=True):
    X = sm.add_constant(X, has_constant='add')
    m = sm.OLS(np.asarray(y, float), np.asarray(X, float))
    return m.fit(cov_type='HAC', cov_kwds={'maxlags': 2}) if hac else m.fit()


def resid(y, X0):
    return y - X0 @ np.linalg.lstsq(X0, y, rcond=None)[0]


# ---------------------------------------------------------------- анализ
def analyze(meters, idx, tariff, W, has_w, names):
    heads = [m for m in meters if m['head']]
    tenants = [m for m in meters if not m['head']]
    hc = pd.DataFrame({f"{m['no']} {m['name']}": m['cons'] for m in heads}).fillna(0.0)
    ref = hc.iloc[:, 0].sum()
    scale = {c: (ref / hc[c].sum() if hc[c].sum() > 0 else 1.0) for c in hc}
    H = (hc * pd.Series(scale)).mean(axis=1)
    ent = pd.DataFrame({m['no']: m['cons'] for m in tenants}).fillna(0.0)
    ent = ent.T.groupby([m['ent'] for m in tenants]).sum().T
    ent = ent.loc[:, ent.sum() > 0]
    S = ent.sum(axis=1)
    L = H - S
    n = len(L)
    recent = L.index > L.index[-1] - 12
    wcols = ['CDD', 'HDD'] if has_w else []
    res = dict(n_months=n, period=(str(L.index[0]), str(L.index[-1])), heads=list(hc.columns), weather=has_w)

    # итоги
    res['L_mean'] = L.mean(); res['L_pct'] = 100 * L.sum() / H.sum()
    res['L_recent'] = L[recent].mean(); res['L_recent_pct'] = 100 * L[recent].sum() / H[recent].sum()
    res['kw_recent'] = res['L_recent'] / 730
    if len(hc.columns) > 1:
        res['heads_ratio'] = {c: hc[c].sum() / ref for c in hc}
        res['heads_month_diff'] = float((hc.iloc[:, 0] - hc.iloc[:, 1] * scale[hc.columns[1]]).abs().median())
    kk = pd.DataFrame({m['no']: m['cons'] * m['k'] for m in tenants}).fillna(0.0).sum(axis=1)
    hk = [m for m in heads if abs(m['k'] - 1) < 1e-6] or heads
    pay = pd.concat([m['cons'] for m in hk], axis=1).fillna(0).mean(axis=1) - kk
    t = tariff.reindex(L.index)
    if t.notna().sum() >= n // 2:
        t = t.ffill().bfill()
        res['money_recent_month'] = float((pay * t)[recent].mean()); res['money_total'] = float((pay * t).sum())
    res['pay_gap_recent'] = float(pay[recent].mean())

    # погода у неучтённого
    if has_w:
        m = ols(L, W[wcols])
        base = m.params[0]
        res['L_summer_pct'] = 100 * (W['CDD'].groupby(W.index.month).mean().max() * m.params[1]) / base if base > 0 else np.nan
        res['L_summer_t'] = float(m.tvalues[1])

    # ---- события замены счётчиков
    act = {}
    for mt in tenants:
        on = mt['cons'][mt['cons'] > 0]
        if len(on):
            act[mt['no']] = (on.index.min(), on.index.max())
    swaps = {}
    for e in ent.columns:
        ms = [mt for mt in tenants if mt['ent'] == e and mt['no'] in act]
        olds = [mt for mt in ms if act[mt['no']][1] <= L.index[-1] - 2]
        news = [mt for mt in ms if act[mt['no']][0] > L.index[0] + 2]
        for o in olds:
            for nw in news:
                if nw is not o and abs((act[nw['no']][0] - act[o['no']][1]).n) <= 3:
                    sw = act[nw['no']][0]
                    if e not in swaps or sw < swaps[e]:
                        swaps[e] = sw
    swap_res = {}
    for e, sw in swaps.items():
        x = ent[e]
        pre, post = x[(x.index >= sw - 12) & (x.index < sw)], x[(x.index >= sw) & (x.index < sw + 12)]
        if len(pre) < 6 or len(post) < 4 or pre.mean() <= 0:
            continue
        yoy = [x[p] / x[p - 12] for p in post.index if (p - 12) in x.index and x[p - 12] > 0]
        xpre = x.where(x.index < sw, 0.0)
        best = None
        for k in (1, 2):
            X = pd.concat([agg(W[c], k) for c in wcols] + [agg(xpre, k)], axis=1)
            mm = ols(agg(L, k), X)
            th, tt = mm.params[-1], mm.tvalues[-1]
            if best is None or tt > best[1]:
                best = (th, tt)
        swap_res[e] = dict(xpre=xpre, swap=str(sw), pre=pre.mean(), post=post.mean(), jump=post.mean() / pre.mean(),
                           yoy=float(np.median(yoy)) if yoy else np.nan, theta=best[0], t=best[1],
                           flag=bool(best[0] > 0.15 and best[1] > 2 and post.mean() / pre.mean() > 1.3))
    res['swaps'] = {e: {k: v for k, v in d_.items() if k != 'xpre'} for e, d_ in swap_res.items()}

    # ---- остановки потребителей (≥3 месяцев почти ноль после активной работы)
    stops = {}
    big = 0.05 * S.mean()
    Lr = L - (ols(L, W[wcols], hac=False).fittedvalues - L.mean() if wcols else 0)
    Lr = pd.Series(np.asarray(Lr, float), index=L.index)
    for e_, sr in swap_res.items():  # убрать уже найденный эффект старых счётчиков
        if sr['flag']:
            Lr = Lr - sr['theta'] * (sr['xpre'] - sr['xpre'].mean())
    for e in ent.columns:
        x = ent[e]
        for i in range(6, n - 2):
            before = x.iloc[i - 6:i].mean()
            after = x.iloc[i:i + 6]
            if before > big and (after < 0.1 * before).all() and len(after) >= 3 and x.iloc[i - 1] > 0.1 * before:
                Lb, La = Lr.iloc[max(0, i - 7):i - 1], Lr.iloc[i:i + 6]
                dx = before - after.mean()
                dL = Lb.mean() - La.mean()
                se = np.sqrt(Lb.var() / len(Lb) + La.var() / len(La))
                stops[e] = dict(month=str(x.index[i]), dx=dx, dL=dL, se=se, ratio=dL / dx)
                break
    res['stops'] = stops

    # ---- показания не меняются
    frozen = {}
    for mt in tenants:
        r = mt['reads'].dropna()
        if len(r) < 8:
            continue
        c = mt['cons']
        last_on = c[c > 0].index.max() if (c > 0).any() else None
        if last_on is None or last_on > L.index[-1] - 2:
            continue
        prior = c[c.index <= last_on].iloc[-6:].mean()
        replaced = any(o is not mt and o['ent'] == mt['ent'] and o['no'] in act and abs((act[o['no']][0] - last_on).n) <= 3
                       for o in tenants)
        if prior > 50 and not replaced:
            frozen.setdefault(mt['ent'], []).append(dict(no=mt['no'], name=mt['name'], since=str(last_on + 1), prior=prior))
    res['frozen'] = frozen

    # ---- ошибки данных
    errs = []
    for mt in meters:
        neg = mt['cons'][mt['cons'] < 0]
        for p, v in neg.items():
            errs.append(f"Показания идут назад: счётчик {mt['serial']} ({mt['name']}), {p.strftime('%m.%Y')}: {v:+.0f} кВт·ч")
    ser = pd.Series([m['serial'] for m in meters if m['serial']])
    for s_ in ser[ser.duplicated()].unique():
        who = [f"{m['ent']} «{m['name']}»" for m in meters if m['serial'] == s_]
        errs.append(f"Один номер счётчика {s_} на нескольких строках: " + '; '.join(who))
    hk_scaled = set(round(m['k'], 3) for m in heads)
    if len(hk_scaled) > 1:
        errs.append('У головных счётчиков разные коэффициенты надбавки (' + ', '.join(f"{m['name']}: {m['k']}" for m in heads) +
                    '): разница между ними в таблице искажена. В отчёте всё считается без надбавки.')
    res['errors'] = errs

    # ---- каждый потребитель по отдельности
    rows = []
    for e in ent.columns:
        r = dict(e=e, mean=ent[e].mean(), share=100 * ent[e].sum() / S.sum())
        betas = {}
        for k in (1, 2, 3):
            y = agg(L, k).values
            X0 = np.column_stack([np.ones(len(y))] + [agg(W[c], k).values for c in wcols])
            x = agg(ent[e], k).values
            if x.std() == 0:
                betas[k] = 0.0; continue
            betas[k] = np.linalg.lstsq(np.column_stack([X0, x]), y, rcond=None)[0][-1]
            if k == 2:
                ry = resid(y, X0); rx = resid(x, X0)
                r['r'] = float(np.corrcoef(y, x)[0, 1]); r['rp'] = float(np.corrcoef(ry, rx)[0, 1])
                rr = [np.corrcoef(ry, resid(np.roll(x, s), X0))[0, 1] for s in range(2, len(x) - 1)]
                r['p'] = float((np.sum(np.array(rr) >= r['rp']) + 1) / (len(rr) + 1))
                r['beta'] = float(betas[k])
        r['consistent'] = all(betas[k] > 0 for k in (1, 2, 3))
        if has_w:
            on = ent[e] > 0.05 * ent[e].mean()
            if on.sum() >= 12:
                m = ols(ent[e][on], W[wcols][on], hac=False)
                cmax = W['CDD'].groupby(W.index.month).mean().max()
                r['summer'] = 100 * cmax * m.params[1] / m.params[0] if m.params[0] > 0 else np.nan
        rows.append(r)
    cand = pd.DataFrame(rows).set_index('e')

    # ---- вердикты
    verdict = {}
    for e, r in cand.iterrows():
        notes = []
        tag, level = 'Связи нет', 'cool'
        sw = swap_res.get(e)
        st = stops.get(e)
        if sw and sw['flag']:
            tag, level = f"Старый счётчик занижал (до {pd.Period(sw['swap'], 'M').strftime('%m.%Y')})", 'hot'
            notes.append(f"После замены учтённое выросло в {sw['jump']:.1f} раза. Модель: старый счётчик видел ≈{100 / (1 + sw['theta']):.0f}% "
                         f"(t={sw['t']:.1f}). Сейчас это уже исправлено.")
        elif st and st['dx'] > 2 * st['se'] and abs(st['ratio']) < 0.25:
            tag, level = 'Не виноват', 'cool'
            notes.append(f"С {pd.Period(st['month'], 'M').strftime('%m.%Y')} почти не потребляет (−{f0(st['dx'])} кВт·ч/мес), "
                         f"а неучтённое не изменилось.")
        elif st and st['ratio'] > 0.5 and st['dL'] > 2 * st['se']:
            tag, level = 'Подозрение', 'hot'
            notes.append(f"Когда с {pd.Period(st['month'], 'M').strftime('%m.%Y')} перестал потреблять, неучтённое упало на "
                         f"{f0(st['dL'])} кВт·ч/мес (с поправкой на погоду).")
        elif r.get('p', 1) < 0.05 and r['consistent'] and r['beta'] > 0:
            tag, level = 'Подозрение', 'hot'
            notes.append(f"Неучтённое растёт вместе с его потреблением: +{r['beta']:.2f} кВт·ч на каждый учтённый, "
                         f"при любой разбивке по месяцам (p={r['p']:.2f}).")
        elif r.get('p', 1) < 0.15 and r['consistent'] and r['beta'] > 0:
            tag, level = 'Слабая связь', 'warm'
            notes.append(f"Положительная связь при любой разбивке, но слабая (p={r['p']:.2f}).")
        elif r.get('r', 0) >= 0.3:
            tag, level = 'Ложный след', 'cool'
            notes.append('Простая корреляция высокая, но после поправки на погоду и проверки на случайность связь не держится. '
                         'Скорее всего, просто похожий сезонный профиль.')
        if e in frozen:
            fz = frozen[e][0]
            if level == 'cool' and tag == 'Связи нет':
                tag, level = 'Уточнить', 'warm'
            notes.append(f"Показания «{fz['name']}» не меняются с {pd.Period(fz['since'], 'M').strftime('%m.%Y')}: съехали или счётчик не снимают?")
        if (has_w and res.get('L_summer_t', 0) > 2 and r.get('summer', 99) < 10 and r['share'] > 8 and level != 'hot'
                and not (st and tag == 'Не виноват')):
            if tag in ('Связи нет', 'Ложный след'):
                tag, level = 'Проверить', 'warm'
            notes.append(f"Летом учтённое почти не растёт (+{r['summer']:.0f}%), а неучтённое растёт заметно: "
                         'проверить, не подключены ли кондиционеры мимо счётчика.')
        if not notes:
            notes.append('Устойчивой связи с неучтённым нет.')
        verdict[e] = (tag, level, ' '.join(notes))
    cand['tag'] = [verdict[e][0] for e in cand.index]
    cand['level'] = [verdict[e][1] for e in cand.index]
    cand['note'] = [verdict[e][2] for e in cand.index]

    # ---- итоговая модель и разложение
    terms = {}
    for e in cand.index[cand['level'] == 'hot']:
        if e in swap_res and swap_res[e]['flag']:
            sw = pd.Period(swap_res[e]['swap'], 'M')
            terms[f'{names.get(e, e)}: старый счётчик'] = ent[e].where(ent.index < sw, 0.0)
        elif cand.loc[e, 'tag'] in ('Подозрение', 'Слабая связь'):
            terms[names.get(e, e)] = ent[e]
    while True:
        X = pd.concat([W[wcols]] + [v.rename(k) for k, v in terms.items()], axis=1) if (wcols or terms) else pd.DataFrame(index=L.index)
        Xc = sm.add_constant(X, has_constant='add')
        fm = sm.OLS(L, Xc).fit(cov_type='HAC', cov_kwds={'maxlags': 2})
        neg = [k for k in terms if fm.params[k] < 0]
        if not neg:
            break
        del terms[min(neg, key=lambda k: fm.tvalues[k])]
    contrib = Xc * fm.params
    parts = {'Постоянная нагрузка': (contrib['const'].mean(), contrib['const'][recent].mean(), fm.tvalues['const'])}
    if wcols:
        parts['Погода (жара и холод)'] = ((contrib['CDD'] + contrib['HDD']).mean(), (contrib['CDD'] + contrib['HDD'])[recent].mean(),
                                          fm.tvalues['CDD'])
    for k in terms:
        parts[k] = (contrib[k].mean(), contrib[k][recent].mean(), fm.tvalues[k])
    res['parts'] = parts
    res['const_kw'] = fm.params['const'] / 730
    return res, dict(H=H, S=S, L=L, ent=ent, hc=hc, scale=scale, cand=cand, W=W)


# ---------------------------------------------------------------- графики
def setup_plt():
    from matplotlib import font_manager
    have = set(f.name for f in font_manager.fontManager.ttflist)
    fam = next((f for f in ('Arial', 'Helvetica Neue', 'Noto Sans', 'DejaVu Sans') if f in have), 'DejaVu Sans')
    plt.rcParams.update({
        'font.family': fam, 'font.size': 9,
        'axes.edgecolor': '#bdbcb7', 'axes.linewidth': 0.6, 'axes.labelcolor': '#52514e',
        'xtick.color': '#52514e', 'ytick.color': '#52514e', 'xtick.major.size': 0, 'ytick.major.size': 0,
        'axes.grid': True, 'grid.color': '#e6e5e0', 'grid.linewidth': 0.6,
        'axes.spines.top': False, 'axes.spines.right': False, 'axes.spines.left': False,
        'legend.frameon': False, 'legend.fontsize': 8.5, 'svg.fonttype': 'none'})


BLUE, ORANGE, RED, INK, GRAY = '#2a78d6', '#eb6834', '#e34948', '#0b0b0b', '#8a8983'


def kfmt(ax):
    ax.yaxis.set_major_formatter(matplotlib.ticker.FuncFormatter(lambda v, _: f'{v / 1000:.0f}'))


def to_svg(fig):
    # PNG внутри HTML: одинаково выглядит в любом браузере и при печати в PDF
    import io, base64
    b = io.BytesIO()
    fig.savefig(b, format='png', dpi=200, bbox_inches='tight', pad_inches=0.05, facecolor='white')
    plt.close(fig)
    return '<img src="data:image/png;base64,' + base64.b64encode(b.getvalue()).decode() + '">'


def charts(res, d, names):
    setup_plt()
    H, S, L, ent, hc, cand, W = d['H'], d['S'], d['L'], d['ent'], d['hc'], d['cand'], d['W']
    x = L.index.to_timestamp()
    out = {}
    fig, ax = plt.subplots(figsize=(7.2, 2.7))
    ax.fill_between(x, S, H, where=H >= S, color=RED, alpha=0.22, linewidth=0, label='Неучтённое (разница)')
    ax.plot(x, H, color=INK, lw=1.6, label='Головной счётчик' + (' (среднее)' if hc.shape[1] > 1 else ''))
    ax.plot(x, S, color=BLUE, lw=1.6, label='Сумма счётчиков потребителей')
    kfmt(ax); ax.set_ylabel('тыс. кВт·ч в месяц'); ax.set_ylim(0, H.max() * 1.1)
    ax.legend(loc='lower left'); ax.xaxis.set_major_formatter(mdates.DateFormatter('%Y'))
    out['balance'] = to_svg(fig)

    fig, ax = plt.subplots(figsize=(7.2, 2.6))
    ax.bar(x, L, width=22, color=RED, alpha=0.55, label='Неучтённое за месяц')
    ax.plot(x, L.rolling(12).mean(), color=INK, lw=2, label='Среднее за 12 месяцев')
    ax.axhline(0, color='#bdbcb7', lw=0.8); kfmt(ax); ax.set_ylabel('тыс. кВт·ч в месяц')
    ax.legend(loc='lower left', bbox_to_anchor=(0, 1.0), ncol=2); ax.xaxis.set_major_formatter(mdates.DateFormatter('%Y'))
    out['loss'] = to_svg(fig)

    if hc.shape[1] > 1:
        tail = L.index > L.index[-1] - 14
        fig, ax = plt.subplots(figsize=(7.2, 2.4))
        cols = [BLUE, ORANGE, '#1baf7a']
        for i, c in enumerate(hc.columns[:3]):
            Lc = hc[c] * d['scale'][c] - S
            ax.plot(L.index[tail].to_timestamp(), Lc[tail], color=cols[i], lw=1.6, marker='o', ms=3.5, label=f'Считая по «{c.split(" ", 1)[1][:28]}»')
        ax.plot(L.index[tail].to_timestamp(), L[tail], color=INK, lw=2.2, label='Среднее')
        ax.axhline(0, color='#bdbcb7', lw=0.8); kfmt(ax); ax.set_ylabel('тыс. кВт·ч в месяц')
        ax.legend(loc='lower left', bbox_to_anchor=(0, 1.0), ncol=3); ax.xaxis.set_major_formatter(mdates.DateFormatter('%m.%y'))
        out['heads'] = to_svg(fig)

    parts = res['parts']
    fig, ax = plt.subplots(figsize=(7.2, 0.5 + 0.38 * len(parts)))
    labs = list(parts)[::-1]; vals = [parts[k][0] for k in labs]
    pal = [RED, ORANGE, '#c98500', INK, '#6250d6', '#1baf7a']
    bars = ax.barh(labs, vals, color=pal[:len(labs)][::-1], height=0.55)
    for b_, v in zip(bars, vals):
        ax.text(max(v, 0) + max(vals) * 0.01, b_.get_y() + b_.get_height() / 2, f'{v:,.0f}'.replace(',', ' '), va='center', fontsize=8.5)
    ax.set_xlim(min(0, min(vals)), max(vals) * 1.15); ax.grid(axis='y', visible=False)
    ax.set_xlabel('кВт·ч в месяц, в среднем за весь период')
    out['decomp'] = to_svg(fig)

    mo = L.groupby(L.index.month).mean()
    fig, ax = plt.subplots(figsize=(7.2, 2.1))
    nm = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
    top = mo.nlargest(2).index
    ax.bar([nm[m - 1] for m in mo.index], mo.values, color=[RED if m in top else '#f0a3a2' for m in mo.index], width=0.65)
    kfmt(ax); ax.set_ylabel('тыс. кВт·ч'); ax.grid(axis='x', visible=False)
    out['season'] = to_svg(fig)

    ev = []
    for e, sw in res['swaps'].items():
        if sw['flag']:
            p = pd.Period(sw['swap'], 'M')
            fig, ax = plt.subplots(figsize=(7.2, 2.2))
            ax.plot(x, ent[e], color=ORANGE, lw=1.8)
            ax.axvline(p.to_timestamp(), color=INK, lw=1, ls='--')
            ax.text(p.to_timestamp(), ent[e].max() * 1.02, 'замена счётчика  ', fontsize=8, color='#52514e', ha='right', va='top')
            kfmt(ax); ax.set_ylabel('тыс. кВт·ч в месяц'); ax.set_ylim(0, ent[e].max() * 1.1)
            ax.xaxis.set_major_formatter(mdates.DateFormatter('%Y'))
            ev.append((f'{names.get(e, e)} ({e}): замена счётчика', to_svg(fig),
                       f"Среднее за 12 месяцев до замены — {sw['pre']:,.0f}, после — {sw['post']:,.0f} кВт·ч/мес.".replace(',', ' ')))
    for e, st in res['stops'].items():
        p = pd.Period(st['month'], 'M')
        w = (L.index >= p - 8) & (L.index <= p + 8)
        fig, axs = plt.subplots(2, 1, figsize=(7.2, 2.8), sharex=True)
        fig.subplots_adjust(hspace=0.5)
        axs[0].bar(L.index[w].to_timestamp(), ent[e][w], width=20, color=BLUE)
        axs[0].set_title(f'{names.get(e, e)}, учтено', loc='left', fontsize=9)
        axs[1].bar(L.index[w].to_timestamp(), L[w], width=20, color=RED, alpha=0.7)
        axs[1].set_title('Неучтённое', loc='left', fontsize=9)
        top_ = max(ent[e][w].max(), L[w].max()) * 1.1
        for a in axs:
            kfmt(a); a.set_ylim(min(0, L[w].min()), top_)
        axs[1].xaxis.set_major_formatter(mdates.DateFormatter('%m.%y'))
        ev.append((f'{names.get(e, e)} ({e}): перестал потреблять в {p.strftime("%m.%Y")}', to_svg(fig),
                   f"Потребитель убрал {st['dx']:,.0f} кВт·ч/мес; неучтённое (с поправкой на погоду) изменилось на {-st['dL']:+,.0f} кВт·ч/мес.".replace(',', ' ')))
    out['events'] = ev[:4]
    return out


# ---------------------------------------------------------------- отчёт
def f0(v):
    return f'{v:,.0f}'.replace(',', ' ')


def f2(v):
    return '' if v is None or (isinstance(v, float) and np.isnan(v)) else f'{v:.2f}'.replace('.', ',')


def esc(s):
    return str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def lead_text(res, cand, names):
    hot = cand[cand['level'] == 'hot']
    const_share = 100 * res['parts']['Постоянная нагрузка'][0] / max(res['L_mean'], 1)
    s = []
    if len(hot) == 0:
        s.append('Ни у одного потребителя неучтённое не растёт вместе с его работой.')
    else:
        s.append('С неучтённым связаны: ' + '; '.join(f"<b>{esc(names.get(e, e))}</b> — {esc(r['tag'].lower())}" for e, r in hot.iterrows()) + '.')
    if const_share > 50:
        s.append(f'Основная часть неучтённого (~{const_share:.0f}%) — <b>постоянная нагрузка ≈{res["const_kw"]:.0f} кВт круглосуточно</b>. '
                 '<b>По месячным данным её нельзя привязать к конкретному потребителю</b>: постоянный прибор до счётчика выглядит одинаково, чей бы он ни был. '
                 'Исключены только те, кто останавливался, а неучтённое при этом не упало.')
    if res.get('L_summer_t', 0) > 2:
        s.append(f'Летом неучтённое растёт (в самый жаркий месяц примерно на {res["L_summer_pct"]:.0f}%): похоже на кондиционеры мимо счётчиков.')
    s.append('Найти конкретный прибор помогут почасовые профили счётчиков и ночной замер (раздел 6).')
    return ' '.join(s)


def build_html(res, d, ch, names, title):
    cand = d['cand']
    lvl_order = {'hot': 0, 'warm': 1, 'cool': 2}
    cand = cand.assign(o=cand['level'].map(lvl_order)).sort_values(['o', 'mean'], ascending=[True, False])
    rows = ''
    for e, r in cand.iterrows():
        summ = '' if np.isnan(r.get('summer', np.nan)) else (f"{'+' if r['summer'] >= 0 else '−'}{abs(r['summer']):.0f}%")
        rows += (f"<tr><td><b>{esc(names.get(e, e))}</b> <span class=mut>{esc(e)}</span></td><td class=n>{f0(r['mean'])}</td>"
                 f"<td class=n>{f2(r.get('r'))}</td><td class=n>{f2(r.get('rp'))}</td><td class=n>{f2(r.get('beta'))}</td>"
                 f"<td class=n>{f2(r.get('p'))}</td><td class=n>{summ}</td>"
                 f"<td><span class='tag {r['level']}'>{esc(r['tag'])}</span><br><span class=small>{esc(r['note'])}</span></td></tr>")
    parts = ''.join(f"<tr><td>{esc(k)}</td><td class=n>{f0(v[0])}</td><td class=n>{f0(v[1])}</td><td class=n>{v[2]:.1f}</td></tr>"
                    for k, v in res['parts'].items())
    errs = ''.join(f'<li>{esc(x)}</li>' for x in res['errors'][:15]) or '<li>Явных ошибок не найдено.</li>'
    frz = ''.join(f"<li>{esc(names.get(e, e))}: «{esc(v[0]['name'])}» — не меняются с {pd.Period(v[0]['since'], 'M').strftime('%m.%Y')}</li>"
                  for e, v in res['frozen'].items())
    evs = ''.join(f"<figure><div class=ft>{esc(t)}</div>{svg}<figcaption>{esc(c)}</figcaption></figure>" for t, svg, c in ch['events'])
    kpi_money = (f"<div class=kpi><div class=v>≈{f0(round(res['money_recent_month'], -3) / 1000)} тыс. ₽</div>"
                 f"<div class=l>в месяц не возвращается с потребителей (последние 12 мес, по тарифам таблицы)</div></div>"
                 if 'money_recent_month' in res else '')
    heads_txt = ''
    if 'heads_ratio' in res:
        r_ = list(res['heads_ratio'].values())
        heads_txt = (f"<p>Головных счётчиков несколько; за весь период они расходятся на {abs(100 * (r_[1] - 1)):.1f}%. "
                     f"Месяц к месяцу разница больше — в среднем {f0(res['heads_month_diff'])} кВт·ч, потому что их снимают в разные дни. "
                     'Поэтому за головной взято их среднее, а надёжнее смотреть суммы за 2–3 месяца.</p>')
    heads_fig = f"<figure><div class=ft>Неучтённое по каждому головному счётчику, последние 14 месяцев</div>{ch['heads']}</figure>" if 'heads' in ch else ''
    return f"""<!doctype html><html lang=ru><head><meta charset=utf-8><title>{esc(title)}</title><style>
@page {{ size: A4; margin: 15mm; }}
body {{ font-family: -apple-system, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif; font-size: 9.6pt; line-height: 1.45; color: #0b0b0b; max-width: 190mm; margin: 0 auto; }}
h1 {{ font-size: 19pt; margin: 0 0 2mm; }} h2 {{ font-size: 12.5pt; margin: 7mm 0 2mm; padding-top: 1mm; border-top: 0.6pt solid #d7d6d1; }}
.sub {{ color: #52514e; margin-bottom: 4mm; }}
.lead {{ background: #f6f5f2; border-left: 3pt solid #e34948; padding: 3mm 4mm; margin: 3mm 0 4mm; }}
.kpis {{ display: flex; gap: 3mm; margin: 3mm 0; }} .kpi {{ flex: 1; border: 0.6pt solid #d7d6d1; border-radius: 2mm; padding: 2.5mm 3mm; }}
.kpi .v {{ font-size: 15pt; font-weight: 700; }} .kpi .l {{ font-size: 8pt; color: #52514e; }}
table {{ border-collapse: collapse; width: 100%; margin: 2mm 0 3mm; font-size: 8.6pt; }}
th {{ text-align: left; font-weight: 600; color: #52514e; border-bottom: 0.8pt solid #8a8983; padding: 1.4mm 1.5mm; vertical-align: bottom; }}
td {{ border-bottom: 0.4pt solid #e6e5e0; padding: 1.4mm 1.5mm; vertical-align: top; }} tr {{ page-break-inside: avoid; }}
td.n, th.n {{ text-align: right; white-space: nowrap; }} .mut {{ color: #8a8983; font-size: 7.8pt; }} .small {{ font-size: 8pt; color: #3a3936; }}
.tag {{ display: inline-block; font-size: 7.6pt; font-weight: 600; padding: 0.3mm 1.6mm; border-radius: 1mm; }}
.tag.hot {{ background: #fbe1e0; color: #a3201f; }} .tag.warm {{ background: #fdf0d5; color: #7a5200; }} .tag.cool {{ background: #eceae5; color: #52514e; }}
figure {{ margin: 2mm 0 3mm; page-break-inside: avoid; }} figure img {{ width: 100%; height: auto; }}
figcaption {{ font-size: 8.2pt; color: #52514e; }} .ft {{ font-weight: 600; margin-bottom: 1mm; }}
ul, ol {{ margin: 0 0 2mm 5mm; padding: 0; }} li {{ margin-bottom: 1mm; }}
</style></head><body>
<h1>{esc(title)}</h1>
<div class=sub>Период {pd.Period(res['period'][0], 'M').strftime('%m.%Y')} — {pd.Period(res['period'][1], 'M').strftime('%m.%Y')} ({res['n_months']} мес.) · {len(cand)} потребителей · отчёт от {date.today().strftime('%d.%m.%Y')}</div>
<div class=lead><b>Вывод.</b> {lead_text(res, d['cand'], names)}</div>
<div class=kpis>
<div class=kpi><div class=v>{res['L_pct']:.1f}%</div><div class=l>неучтённое от головного, в среднем за период</div></div>
<div class=kpi><div class=v>{f0(res['L_recent'])}</div><div class=l>кВт·ч/мес неучтённого за последние 12 мес ≈ {res['kw_recent']:.1f} кВт круглосуточно</div></div>
{kpi_money}</div>

<h2>1. Сколько неучтённого</h2>
<figure><div class=ft>Головной счётчик и сумма потребителей</div>{ch['balance']}<figcaption>кВт·ч без коэффициентов надбавки. Красная полоса — неучтённое.</figcaption></figure>
<figure><div class=ft>Неучтённое по месяцам</div>{ch['loss']}<figcaption>Месячные значения скачут из-за дат съёма показаний. Чёрная линия — среднее за 12 месяцев.</figcaption></figure>
{heads_txt}{heads_fig}

<h2>2. Из чего состоит неучтённое</h2>
<p>Модель: неучтённое = постоянная часть + погода (градусо-дни жары и холода) + доли подозрительных потребителей. t — насколько надёжна часть (больше 2 — надёжно).</p>
<figure>{ch['decomp']}</figure>
<table><tr><th>Часть</th><th class=n>в среднем, кВт·ч/мес</th><th class=n>последние 12 мес</th><th class=n>t</th></tr>{parts}
<tr><td><b>Неучтённое фактически</b></td><td class=n><b>{f0(res['L_mean'])}</b></td><td class=n><b>{f0(res['L_recent'])}</b></td><td></td></tr></table>
<figure><div class=ft>Неучтённое по календарным месяцам</div>{ch['season']}</figure>

<h2>3. Проверка каждого потребителя</h2>
<table><tr><th>Потребитель</th><th class=n>Учтено,<br>кВт·ч/мес</th><th class=n>Корреляция<br>простая</th><th class=n>Корреляция<br>без погоды</th><th class=n>Доля β</th><th class=n>p</th><th class=n>Летом<br>учтённое</th><th>Вывод</th></tr>
{rows}</table>
<p class=small><b>Доля β</b> — сколько кВт·ч неучтённого прибавляется на каждый учтённый кВт·ч потребителя (поправка на погоду, суммы по 2 месяца). <b>p</b> — вероятность получить такую связь случайно (меньше 0,05 — значимо). <b>Летом учтённое</b> — насколько учтённое в самый жаркий месяц выше базы. Простая корреляция часто обманывает: потребители с похожим сезонным профилем «коррелируют», хотя ни при чём.</p>

<h2>4. Естественные эксперименты</h2>
{evs or '<p>Замен счётчиков с заметным скачком и остановок крупных потребителей не найдено.</p>'}

<h2>5. Ошибки и странности в таблице</h2>
<ul>{errs}</ul>
{('<p><b>Показания не меняются</b> (если помещения работают, их потребление уходит в неучтённое):</p><ul>' + frz + '</ul>') if frz else ''}

<h2>6. Что делать дальше</h2>
<ol>
<li>Снять 30-минутные профили нагрузки с головного и новых счётчиков за 1–2 недели (современные счётчики их хранят). Тогда связь с конкретным потребителем видна по часам.</li>
<li>Ночной замер: когда всё закрыто, сравнить мощность на головном и сумму по счётчикам. Разница — постоянная скрытая нагрузка.</li>
<li>Ночью по очереди отключать линии и смотреть мощность на головном.</li>
<li>Проверить токовыми клещами вводы до счётчиков у потребителей с пометками «Подозрение» и «Проверить».</li>
<li>Снимать все счётчики, включая головные, в один день. Исправить ошибки из раздела 5.</li>
<li>Оценить нормативные потери в кабелях (обычно 2–4%), чтобы понять, сколько неучтённого — физика.</li>
</ol>

<h2>7. Методика</h2>
<p>Подход «контрольного головного счётчика» (central observer meter; Bandim и др., IEEE T&amp;D 2003; Yip и др., IJEPES 2017; Kong и др., Energies 2019). Неучтённое = головной − сумма потребителей. Для каждого потребителя: регрессия неучтённого на его потребление с поправкой на погоду (Open-Meteo, градусо-дни); суммы по 1, 2 и 3 месяца; перестановочный тест сдвигами по времени. Отдельно — «естественные эксперименты»: замены счётчиков (модель «старый счётчик занижал») и остановки потребителей. Ограничение: по месячным данным нельзя найти конкретный прибор, только направление поиска.</p>
</body></html>"""


def to_pdf(html_path, pdf_path):
    try:
        from weasyprint import HTML  # если вдруг установлена
        HTML(filename=html_path).write_pdf(pdf_path)
        return 'weasyprint'
    except Exception:
        pass
    cands = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
             '/Applications/Yandex.app/Contents/MacOS/Yandex',
             '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
             '/Applications/Chromium.app/Contents/MacOS/Chromium',
             '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser']
    cands += [shutil.which(x) for x in ('google-chrome', 'chromium', 'chromium-browser')]
    for b in cands:
        if b and os.path.exists(b):
            try:
                subprocess.run([b, '--headless=new', '--disable-gpu', '--no-pdf-header-footer', f'--print-to-pdf={pdf_path}',
                                'file://' + os.path.abspath(html_path)], check=True, capture_output=True, timeout=120)
                if os.path.exists(pdf_path):
                    return os.path.basename(b)
            except Exception:
                continue
    return None


def summary_md(res, cand, names, pdf_ok, out):
    L = []
    L.append(f"Период: {res['period'][0]} … {res['period'][1]} ({res['n_months']} мес.)")
    L.append(f"Неучтённое: {res['L_pct']:.1f}% от головного в среднем; за последние 12 мес — {res['L_recent']:,.0f} кВт·ч/мес "
             f"({res['kw_recent']:.1f} кВт круглосуточно).".replace(',', ' '))
    if 'money_recent_month' in res:
        L.append(f"Не возвращается с потребителей ≈ {res['money_recent_month']:,.0f} ₽/мес (последние 12 мес).".replace(',', ' '))
    L.append('Разложение (кВт·ч/мес, весь период / последние 12 мес / t):')
    for k, v in res['parts'].items():
        L.append(f"  - {k}: {v[0]:,.0f} / {v[1]:,.0f} / t={v[2]:.1f}".replace(',', ' '))
    if res.get('weather') and 'L_summer_t' in res:
        L.append(f"Летний рост неучтённого: +{res['L_summer_pct']:.0f}% в самый жаркий месяц (t={res['L_summer_t']:.1f}).")
    L.append('Потребители (от подозрительных к невиновным):')
    order = cand.assign(o=cand['level'].map({'hot': 0, 'warm': 1, 'cool': 2})).sort_values(['o', 'mean'], ascending=[True, False])
    for e, r in order.iterrows():
        L.append(f"  - {names.get(e, e)} ({e}), {f0(r['mean'])} кВт·ч/мес: {r['tag']}. {r['note']}")
    if res['errors']:
        L.append('Ошибки в таблице:')
        L += [f'  - {x}' for x in res['errors'][:15]]
    L.append(f"Отчёт: {os.path.join(out, 'report.pdf') if pdf_ok else os.path.join(out, 'report.html') + ' (PDF не собрался — открыть в браузере и напечатать в PDF)'}")
    return '\n'.join(L)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('csv'); ap.add_argument('out')
    ap.add_argument('--lat', type=float, default=47.222); ap.add_argument('--lon', type=float, default=39.72)
    ap.add_argument('--head-codes', default='ТП,РГ', help='коды юр. лица у головных счётчиков, через запятую')
    ap.add_argument('--title', default='Неучтённая электроэнергия')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    meters, idx, tariff, names = read_sheet(a.csv, set(x.strip().upper() for x in a.head_codes.split(',') if x.strip()))
    W, has_w = weather(idx, a.lat, a.lon)
    res, d = analyze(meters, idx, tariff, W, has_w, names)
    ch = charts(res, d, names)
    html = build_html(res, d, ch, names, a.title)
    hp = os.path.join(a.out, 'report.html'); open(hp, 'w', encoding='utf-8').write(html)
    pdf_ok = to_pdf(hp, os.path.join(a.out, 'report.pdf'))
    md = summary_md(res, d['cand'], names, pdf_ok, a.out)
    open(os.path.join(a.out, 'summary.md'), 'w', encoding='utf-8').write(md)
    js = {k: v for k, v in res.items() if k not in ('parts',)}
    js['parts'] = {k: list(v) for k, v in res['parts'].items()}
    js['consumers'] = d['cand'].reset_index().to_dict(orient='records')
    json.dump(js, open(os.path.join(a.out, 'summary.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1, default=float)
    if not has_w:
        print('ВНИМАНИЕ: погоду скачать не удалось — анализ без поправки на погоду.')
    print(md)


if __name__ == '__main__':
    main()
