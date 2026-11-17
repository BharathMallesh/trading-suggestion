"""SOLVER M (loop 7) — features, labels, walk-forward models. Frozen spec: see method.md.

  python3 -I mlcore.py features DATA_DIR          -> DATA_DIR/features.pkl
  python3 -I mlcore.py walkforward DATA_DIR       -> DATA_DIR/wf/{preds.csv, ic.json, importance.json} (resumable per year)
  python3 -I mlcore.py live DATA_DIR SIGNAL       -> DATA_DIR/live-SIGNAL.csv  (train on every label known with the 1-month gap)
Every feature at signal date t uses rows dated <= t only.
"""
import json
import os
import site
import sys

# run with python3 -I (isolated): add only the user site-packages where numpy/pandas/scikit-learn are installed
sys.path.append(site.getusersitepackages())

import numpy as np
import pandas as pd

FEATS = ['r1', 'r3', 'r6', 'r12', 'r12_1', 'r6_1', 'r6v', 'r12v', 'resmom', 'resmom6', 'vol1', 'vol3', 'vol12', 'idio12', 'beta12',
         'maxret1', 'skew12', 'up3', 'up12', 'hi52', 'lo52', 'ma50gap', 'ma200gap', 'ma50_200', 'turn', 'turnchg', 'amihud3',
         'deliv42', 'delivchg', 'vol3_12', 'r1_vol', 'r3_1']
MODELS = ['ridge', 'hgb', 'rf', 'ens']


def make_models():
    from sklearn.linear_model import Ridge
    from sklearn.ensemble import HistGradientBoostingRegressor, RandomForestRegressor
    return {
        'ridge': Ridge(alpha=10.0),
        'hgb': HistGradientBoostingRegressor(max_depth=3, learning_rate=0.05, max_iter=200, min_samples_leaf=200, l2_regularization=1.0, random_state=0),
        'rf': RandomForestRegressor(n_estimators=300, max_depth=6, min_samples_leaf=200, max_features=0.33, random_state=0, n_jobs=-1),
    }


def load(D):
    px = pd.read_csv(os.path.join(D, 'px.csv.gz'))
    cal = np.array(sorted(px['date'].unique()))
    nif = pd.read_csv(os.path.join(D, 'nifty.csv')).set_index('date')['close']
    me = pd.read_csv(os.path.join(D, 'monthends.csv'))['date'].tolist()
    univ = pd.read_csv(os.path.join(D, 'univ.csv'))
    meta = json.load(open(os.path.join(D, 'meta.json')))
    wide = {k: px.pivot(index='date', columns='sym', values=k).reindex(cal) for k in ['close', 'high', 'low', 'val']}
    dv = pd.read_csv(os.path.join(D, 'deliv.csv.gz'))
    dv = dv[dv['sym'].isin(wide['close'].columns)]
    q = dv.pivot_table(index='date', columns='sym', values='qty', aggfunc='last').reindex(index=cal, columns=wide['close'].columns)
    dq = dv.pivot_table(index='date', columns='sym', values='deliv', aggfunc='last').reindex(index=cal, columns=wide['close'].columns)
    return cal, wide, q, dq, nif, me, univ, meta


def resid_mom(R, n, skip=21):
    """M10-style residual momentum over the window R (T x N log returns) vs NIFTY n (T); NaN-aware per column."""
    out = np.full(R.shape[1], np.nan)
    beta = np.full(R.shape[1], np.nan)
    idio = np.full(R.shape[1], np.nan)
    for j in range(R.shape[1]):
        r = R[:, j]
        ok = ~np.isnan(r) & ~np.isnan(n)
        if ok.sum() < 0.5 * len(r):
            continue
        x, y = n[ok], r[ok]
        vx = ((x - x.mean()) ** 2).sum()
        b = ((x - x.mean()) * (y - y.mean())).sum() / vx if vx > 0 else 1.0
        res = r - b * n
        body = res[: len(res) - skip]
        body = body[~np.isnan(body)]
        allr = res[~np.isnan(res)]
        sd = allr.std(ddof=1)
        beta[j] = b
        idio[j] = sd * np.sqrt(252)
        if sd > 0 and len(body) > 10:
            out[j] = body.sum() / (sd * np.sqrt(len(body)))
    return out, beta, idio


def features(D):
    cal, wide, q, dq, nif, me, univ, meta = load(D)
    C_raw = wide['close'].values
    C = wide['close'].ffill(limit=10).values
    H = wide['high'].values
    Lo = wide['low'].values
    V = wide['val'].values
    syms = np.array(wide['close'].columns)
    Q = q.values
    DQ = dq.values
    n_close = nif.reindex(cal).ffill().values
    LR = np.vstack([np.full((1, C.shape[1]), np.nan), np.log(C[1:] / C[:-1])])
    LR[np.isnan(C_raw)] = np.nan  # no return on a day the stock did not trade
    NR = np.concatenate([[np.nan], np.log(n_close[1:] / n_close[:-1])])
    pos = {d: i for i, d in enumerate(cal)}
    me_real = [d for d in me if d in pos and d <= meta['lastBhav']]
    rows = []
    us = univ.groupby('signal')['sym'].apply(set).to_dict()
    for k, t in enumerate(me_real):
        if t < '2008-12-01' or t not in us:
            continue
        i = pos[t]
        if i < 260:
            continue
        cols = np.where(np.isin(syms, list(us[t])))[0]
        c0 = C[i, cols]
        # valid: traded in the last 5 sessions, >= 150 traded days in the last 252
        traded = (~np.isnan(C_raw[i - 4:i + 1, cols])).any(0)
        nobs = (~np.isnan(C_raw[i - 251:i + 1, cols])).sum(0)
        ok = traded & (nobs >= 150) & ~np.isnan(c0)
        cols = cols[ok]
        c0 = C[i, cols]
        f = {}
        cl = lambda lag: C[i - lag, cols]
        f['r1'] = c0 / cl(21) - 1
        f['r3'] = c0 / cl(63) - 1
        f['r6'] = c0 / cl(126) - 1
        f['r12'] = c0 / cl(252) - 1
        f['r12_1'] = cl(21) / cl(252) - 1
        f['r6_1'] = cl(21) / cl(126) - 1
        f['r3_1'] = cl(21) / cl(63) - 1
        lr = LR[i - 251:i + 1][:, cols]
        sd = lambda a: np.nanstd(a, axis=0, ddof=1) * np.sqrt(252)
        f['vol1'] = sd(lr[-21:])
        f['vol3'] = sd(lr[-63:])
        f['vol12'] = sd(lr)
        f['vol3_12'] = f['vol3'] / f['vol12']
        f['r6v'] = f['r6'] / f['vol12']
        f['r12v'] = f['r12'] / f['vol12']
        f['r1_vol'] = f['r1'] / f['vol1']
        nr = NR[i - 251:i + 1]
        f['resmom'], f['beta12'], f['idio12'] = resid_mom(lr, nr)
        f['resmom6'], _, _ = resid_mom(lr[-126:], nr[-126:])
        with np.errstate(all='ignore'):
            f['maxret1'] = np.nanmax(np.expm1(lr[-21:]), axis=0)
            m = np.nanmean(lr, 0)
            s = np.nanstd(lr, 0)
            f['skew12'] = np.nanmean(((lr - m) / s) ** 3, 0)
            f['up3'] = (lr[-63:] > 0).sum(0) / (~np.isnan(lr[-63:])).sum(0)
            f['up12'] = (lr > 0).sum(0) / (~np.isnan(lr)).sum(0)
            f['hi52'] = c0 / np.nanmax(H[i - 251:i + 1, cols], 0) - 1
            f['lo52'] = c0 / np.nanmin(Lo[i - 251:i + 1, cols], 0) - 1
            ma50 = np.nanmean(C[i - 49:i + 1, cols], 0)
            ma200 = np.nanmean(C[i - 199:i + 1, cols], 0)
            f['ma50gap'] = c0 / ma50 - 1
            f['ma200gap'] = c0 / ma200 - 1
            f['ma50_200'] = ma50 / ma200 - 1
            v21 = np.nanmedian(V[i - 20:i + 1, cols], 0)
            v252 = np.nanmedian(V[i - 251:i + 1, cols], 0)
            f['turn'] = np.log(v21)
            f['turnchg'] = v21 / v252
            f['amihud3'] = np.nanmean(np.abs(lr[-63:]) / V[i - 62:i + 1, cols], 0) * 1e9
            q42, d42 = Q[i - 41:i + 1, cols], DQ[i - 41:i + 1, cols]
            q252, d252 = Q[i - 251:i + 1, cols], DQ[i - 251:i + 1, cols]
            n42 = (~np.isnan(d42)).sum(0)
            n252 = (~np.isnan(d252)).sum(0)
            f['deliv42'] = np.where(n42 >= 20, np.nansum(d42, 0) / np.nansum(q42, 0), np.nan)
            f['delivchg'] = np.where(n252 >= 120, f['deliv42'] - np.nansum(d252, 0) / np.nansum(q252, 0), np.nan)
        # label: close at the next real month-end / close now
        nxt = me_real[k + 1] if k + 1 < len(me_real) else None
        complete = nxt is not None and (nxt[:7] != meta['lastBhav'][:7] or k + 2 < len(me_real))
        if nxt is not None and complete:
            j = pos[nxt]
            # a stock that stops trading keeps its last close (as simulate() does for vanished stocks)
            last = pd.DataFrame(C_raw[i:j + 1, cols]).ffill().values[-1]
            fwd = last / c0 - 1
        else:
            fwd = np.full(len(cols), np.nan)
        df = pd.DataFrame({k2: np.asarray(v, float) for k2, v in f.items()})
        df['sym'] = syms[cols]
        df['signal'] = t
        df['fwd'] = fwd
        rows.append(df)
    X = pd.concat(rows, ignore_index=True)
    X = X.replace([np.inf, -np.inf], np.nan)
    # cross-sectional percentile ranks, missing -> 0.5
    for c in FEATS:
        X[c] = X.groupby('signal')[c].rank(pct=True).fillna(0.5)
    X['y'] = X.groupby('signal')['fwd'].rank(pct=True)
    # M10-style score for an IC baseline (z-scores of r6v, r12v, resmom with 0.25/0.25/0.5)
    X.to_pickle(os.path.join(D, 'features.pkl'))
    return X


def m10_baseline(D):
    """Raw (un-ranked) M10 score recomputed for the IC baseline: 0.25 z(r6v) + 0.25 z(r12v) + 0.5 z(resmom), using ranks."""
    X = pd.read_pickle(os.path.join(D, 'features.pkl'))
    return 0.25 * X['r6v'] + 0.25 * X['r12v'] + 0.5 * X['resmom']


def add_months(ym, k):
    y, m = map(int, ym.split('-'))
    t = y * 12 + (m - 1) + k
    return f'{t // 12}-{t % 12 + 1:02d}'


def fit_predict(train, test):
    ms = make_models()
    out = {}
    fitted = {}
    for name, mdl in ms.items():
        mdl.fit(train[FEATS].values, train['y'].values)
        fitted[name] = mdl
        out[name] = mdl.predict(test[FEATS].values)
    P = pd.DataFrame(out, index=test.index)
    P['signal'] = test['signal'].values
    rk = P.groupby('signal')[['ridge', 'hgb', 'rf']].rank(pct=True)
    P['ens'] = rk.mean(axis=1)
    return P, fitted


def spearman(a, b):
    ok = ~(np.isnan(a) | np.isnan(b))
    if ok.sum() < 10:
        return np.nan
    return pd.Series(a[ok]).rank().corr(pd.Series(b[ok]).rank())


def walkforward(D):
    from sklearn.inspection import permutation_importance
    X = pd.read_pickle(os.path.join(D, 'features.pkl'))
    X['m10'] = m10_baseline(D)
    out = os.path.join(D, 'wf')
    os.makedirs(out, exist_ok=True)
    last_sig = X['signal'].max()
    for Y in range(2013, int(add_months(last_sig[:7], 1)[:4]) + 1):  # a December signal trades in the next year
        fp = os.path.join(out, f'year-{Y}.json')
        if os.path.exists(fp):
            continue
        tr = X[(X['signal'] >= '2009-01-01') & (X['signal'] < f'{Y - 1}-11-01') & X['y'].notna()]
        te = X[(X['signal'] >= f'{Y - 1}-12-01') & (X['signal'] < f'{Y}-12-01')]
        if not len(te):
            continue
        P, fitted = fit_predict(tr, te)
        # importances: ridge coefficients + permutation importance on (a sample of) the training window
        samp = tr.sample(n=min(15000, len(tr)), random_state=0)
        imp = {'ridge_coef': dict(zip(FEATS, map(float, fitted['ridge'].coef_)))}
        for name in ['ridge', 'hgb', 'rf']:
            r = permutation_importance(fitted[name], samp[FEATS].values, samp['y'].values, n_repeats=3, random_state=0, n_jobs=1)
            imp[name] = dict(zip(FEATS, map(float, r.importances_mean)))
        ic = {}
        for sig, g in te.groupby('signal'):
            if g['fwd'].isna().all():
                continue
            p = P.loc[g.index]
            ic[sig] = {m: spearman(p[m].values, g['fwd'].values) for m in MODELS}
            ic[sig]['m10'] = spearman(g['m10'].values, g['fwd'].values)
        preds = pd.DataFrame({'signal': te['signal'].values, 'sym': te['sym'].values, **{m: P[m].values for m in MODELS}})
        preds.to_csv(os.path.join(out, f'preds-{Y}.csv'), index=False)
        json.dump({'year': Y, 'trainRows': int(len(tr)), 'trainFrom': tr['signal'].min(), 'trainTo': tr['signal'].max(), 'testFrom': te['signal'].min(), 'testTo': te['signal'].max(), 'importance': imp, 'ic': ic}, open(fp, 'w'))
        print(Y, len(tr), 'rows; test', te['signal'].min(), '..', te['signal'].max(), 'mean IC', {m: round(np.nanmean([v[m] for v in ic.values()]), 4) for m in MODELS + ['m10']}, flush=True)
    allp = [pd.read_csv(os.path.join(out, f)) for f in sorted(os.listdir(out)) if f.startswith('preds-')]
    pd.concat(allp).to_csv(os.path.join(out, 'preds.csv'), index=False)


def live(D, signal):
    """Score `signal` with the model the walk-forward schedule would use: the trading year Y of a signal is the year
    of the month after it; that model is trained on signals 2009-01 .. October of Y-1 (labels end by Nov Y-1)."""
    X = pd.read_pickle(os.path.join(D, 'features.pkl'))
    Y = int(add_months(signal[:7], 1)[:4])
    tr = X[(X['signal'] >= '2009-01-01') & (X['signal'] < f'{Y - 1}-11-01') & X['y'].notna()]
    te = X[X['signal'] == signal]
    if not len(te):
        raise SystemExit(f'no feature rows for signal {signal}')
    P, _ = fit_predict(tr, te)
    res = pd.DataFrame({'signal': signal, 'sym': te['sym'].values, **{m: P[m].values for m in MODELS}}).sort_values('ens', ascending=False)
    res.to_csv(os.path.join(D, f'live-{signal}.csv'), index=False)
    print(json.dumps({'signal': signal, 'trainRows': int(len(tr)), 'trainFrom': tr['signal'].min(), 'trainTo': tr['signal'].max(), 'scored': int(len(te))}))


if __name__ == '__main__':
    cmd, D = sys.argv[1], sys.argv[2]
    if cmd == 'features':
        X = features(D)
        print(X.shape, X['signal'].min(), X['signal'].max(), X.groupby('signal').size().describe().to_dict())
    elif cmd == 'walkforward':
        walkforward(D)
    elif cmd == 'live':
        live(D, sys.argv[3])
