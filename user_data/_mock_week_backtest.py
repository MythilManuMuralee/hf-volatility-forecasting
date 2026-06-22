"""
Standalone reproduction of the MythilVol strategy for a single mock scenario:
start with 100 units, run Dec 10 -> Dec 17 2025, report the yield.

This does NOT use the freqtrade engine (not installed here). It re-implements
the strategy's entry/exit/sizing rules directly on the same on-disk candle data
and the same XGBoost model. The data is SYNTHETIC (see _synth_data.py), so the
result illustrates strategy mechanics only - it is not a real-market return.
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import xgboost as xgb

UD = Path(__file__).resolve().parent

# Inlined verbatim from MythilVol.py (that module imports talib at load time,
# which we don't need here). Keep in sync with the strategy.
RV_WINDOW = 288
FEATURE_COLUMNS = [
    "rv_lag_1", "rv_lag_3", "rv_lag_6", "rv_mean_12", "rv_std_12",
    "ret_mean_12", "ret_std_12", "hour_sin", "hour_cos",
]


def compute_vol_features(dataframe: pd.DataFrame) -> pd.DataFrame:
    df = dataframe
    df["log_ret"] = np.log(df["close"] / df["close"].shift(1))
    df["rv"] = np.sqrt(df["log_ret"].pow(2).rolling(RV_WINDOW).sum())
    df["rv_lag_1"] = df["rv"].shift(1)
    df["rv_lag_3"] = df["rv"].shift(3)
    df["rv_lag_6"] = df["rv"].shift(6)
    df["rv_mean_12"] = df["rv"].rolling(12).mean()
    df["rv_std_12"] = df["rv"].rolling(12).std()
    df["ret_mean_12"] = df["log_ret"].rolling(12).mean()
    df["ret_std_12"] = df["log_ret"].rolling(12).std()
    hour = df["date"].dt.hour + df["date"].dt.minute / 60.0
    df["hour_sin"] = np.sin(2 * np.pi * hour / 24.0)
    df["hour_cos"] = np.cos(2 * np.pi * hour / 24.0)
    return df

PAIRS = ["BTC/USDT", "ETH/USDT"]
DATADIR = UD / "data" / "kraken"
START_WALLET = 100.0
MAX_OPEN_TRADES = 2
TRADABLE_RATIO = 0.99
FEE = 0.0026               # Kraken taker, per side
STOPLOSS = -0.03
TRAIL_POSITIVE = 0.01
TRAIL_OFFSET = 0.02
STAKE_SCALE_MIN, STAKE_SCALE_MAX = 0.1, 2.0
WINDOW_START = pd.Timestamp(sys.argv[1] if len(sys.argv) > 1 else "2025-12-10", tz="UTC")
WINDOW_END = WINDOW_START + pd.Timedelta(days=7)


def ta_ema(s: pd.Series, period: int) -> pd.Series:
    # TA-Lib EMA: SMA seed for the first `period` values, then recursive EMA.
    out = s.ewm(span=period, adjust=False).mean()
    sma = s.rolling(period).mean()
    out.iloc[:period - 1] = np.nan
    out.iloc[period - 1] = sma.iloc[period - 1]
    # Re-run recursion from the SMA seed.
    alpha = 2.0 / (period + 1)
    vals = s.to_numpy(dtype=float)
    res = np.full(len(s), np.nan)
    res[period - 1] = np.nanmean(vals[:period])
    for i in range(period, len(s)):
        res[i] = alpha * vals[i] + (1 - alpha) * res[i - 1]
    return pd.Series(res, index=s.index)


def ta_rsi(s: pd.Series, period: int = 14) -> pd.Series:
    # Wilder's RSI (matches TA-Lib RSI).
    delta = s.diff()
    gain = delta.clip(lower=0.0)
    loss = -delta.clip(upper=0.0)
    avg_gain = gain.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    avg_loss = loss.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    rs = avg_gain / avg_loss
    return 100 - 100 / (1 + rs)


def load(pair: str) -> pd.DataFrame:
    f = pair.replace("/", "_")
    df = pd.read_feather(DATADIR / f"{f}-5m.feather")
    df["date"] = pd.to_datetime(df["date"], utc=True)
    daily = pd.read_feather(DATADIR / f"{f}-1d.feather")
    daily["date"] = pd.to_datetime(daily["date"], utc=True)
    return df.sort_values("date").reset_index(drop=True), daily.sort_values("date").reset_index(drop=True)


def prepare(df: pd.DataFrame, daily: pd.DataFrame, model: xgb.Booster) -> pd.DataFrame:
    df = compute_vol_features(df.copy())
    dmat = xgb.DMatrix(df[FEATURE_COLUMNS].values, feature_names=FEATURE_COLUMNS)
    df["forecast_vol"] = model.predict(dmat)
    df["target_vol"] = df["rv"].rolling(RV_WINDOW, min_periods=RV_WINDOW // 2).median()
    df["ema_50"] = ta_ema(df["close"], 50)
    df["rsi"] = ta_rsi(df["close"], 14)

    # Daily regime, merged the freqtrade way: a daily candle dated D only
    # becomes visible to 5m bars from (D + 1day - 5min) onward, then ffilled.
    daily = daily.copy()
    daily["ema_20"] = ta_ema(daily["close"], 20)
    daily["date_merge"] = daily["date"] + pd.Timedelta(days=1) - pd.Timedelta(minutes=5)
    merged = pd.merge_asof(
        df, daily[["date_merge", "close", "ema_20"]].rename(
            columns={"close": "close_1d", "ema_20": "ema_20_1d"}),
        left_on="date", right_on="date_merge", direction="backward",
    )
    return merged


def crossed_above(s: pd.Series) -> pd.Series:
    a, b = s["close"], s["ema_50"]
    return (a.shift(1) <= b.shift(1)) & (a > b)


def signals(df: pd.DataFrame) -> pd.DataFrame:
    xa = crossed_above(df)
    df["enter"] = (
        (df["close_1d"] > df["ema_20_1d"]) & xa
        & (df["rsi"] > 30) & (df["rsi"] < 70)
        & (df["forecast_vol"] > 0) & (df["volume"] > 0)
    ).fillna(False)
    df["exit"] = ((df["close_1d"] < df["ema_20_1d"]) & (df["volume"] > 0)).fillna(False)
    return df


def run():
    model = xgb.Booster()
    model.load_model(str(UD / "models" / "vol_model.json"))

    data = {}
    for p in PAIRS:
        df, daily = load(p)
        data[p] = signals(prepare(df, daily, model))

    # Unified 5m timeline.
    timeline = sorted(set().union(*[set(d["date"]) for d in data.values()]))
    idx = {p: data[p].set_index("date") for p in PAIRS}

    wallet = START_WALLET
    open_trades = {}   # pair -> dict
    closed = []

    in_window = [t for t in timeline if WINDOW_START <= t < WINDOW_END]
    for t in in_window:
        for p in PAIRS:
            if t not in idx[p].index:
                continue
            row = idx[p].loc[t]
            # --- manage an open trade on this pair ---
            if p in open_trades:
                tr = wallet_trade = open_trades[p]
                entry = tr["entry_price"]
                high, low, close = row["high"], row["low"], row["close"]
                # update peak profit for trailing
                tr["peak"] = max(tr["peak"], (high - entry) / entry)
                exit_price = None
                reason = None
                # trailing stop (only active once +2% reached)
                if tr["peak"] >= TRAIL_OFFSET:
                    trail_line = entry * (1 + tr["peak"] - TRAIL_POSITIVE)
                    if low <= trail_line:
                        exit_price, reason = trail_line, "trailing_stop"
                # hard stop -3%
                if exit_price is None:
                    stop_line = entry * (1 + STOPLOSS)
                    if low <= stop_line:
                        exit_price, reason = stop_line, "stoploss"
                # regime-loss exit signal -> fill next-open handled below; here
                # apply if flagged from previous bar
                if exit_price is None and tr.get("exit_pending"):
                    exit_price, reason = row["open"], "exit_signal"
                if exit_price is not None:
                    stake = tr["stake"]
                    qty = tr["qty"]
                    proceeds = qty * exit_price * (1 - FEE)
                    wallet += proceeds
                    pnl = proceeds - stake
                    closed.append({"pair": p, "entry_t": tr["entry_t"], "exit_t": t,
                                   "reason": reason, "stake": stake, "pnl": pnl,
                                   "ret_pct": pnl / stake * 100})
                    del open_trades[p]
                else:
                    if bool(row["exit"]):
                        tr["exit_pending"] = True
            # --- consider a new entry (next-open fill emulated via this bar's open
            #     would need shift; we enter at this bar's close signal -> fill at
            #     next bar open. Simplify: signal on bar t fills at bar t close.) ---
            if p not in open_trades and bool(row["enter"]) and len(open_trades) < MAX_OPEN_TRADES:
                total_stake = wallet * TRADABLE_RATIO
                base = total_stake / MAX_OPEN_TRADES
                fv, tv = row["forecast_vol"], row["target_vol"]
                scale = 1.0
                if np.isfinite(fv) and np.isfinite(tv) and fv > 0:
                    scale = float(np.clip(tv / fv, STAKE_SCALE_MIN, STAKE_SCALE_MAX))
                stake = min(base * scale, wallet * TRADABLE_RATIO)
                if stake < 0.5:   # min cost guard
                    continue
                price = row["close"]
                qty = stake * (1 - FEE) / price
                wallet -= stake
                open_trades[p] = {"entry_t": t, "entry_price": price, "qty": qty,
                                  "stake": stake, "peak": 0.0}

    # Mark-to-market any still-open trades at the window's last price.
    for p, tr in list(open_trades.items()):
        last = idx[p].loc[[t for t in in_window if t in idx[p].index][-1]]
        proceeds = tr["qty"] * last["close"] * (1 - FEE)
        wallet += proceeds
        pnl = proceeds - tr["stake"]
        closed.append({"pair": p, "entry_t": tr["entry_t"], "exit_t": "open@end",
                       "reason": "marked_to_market", "stake": tr["stake"], "pnl": pnl,
                       "ret_pct": pnl / tr["stake"] * 100})

    print(f"Window: {WINDOW_START.date()} -> {WINDOW_END.date()}  (SYNTHETIC data)")
    print(f"Start wallet: {START_WALLET:.2f}   End wallet: {wallet:.2f}")
    print(f"Net P/L: {wallet - START_WALLET:+.2f}  ({(wallet/START_WALLET - 1)*100:+.2f}%)")
    print(f"Trades closed: {len(closed)}")
    if closed:
        wins = [c for c in closed if c["pnl"] > 0]
        print(f"Wins: {len(wins)}/{len(closed)}  ({len(wins)/len(closed)*100:.0f}%)")
        print(f"{'pair':<9}{'entry':<22}{'exit':<22}{'reason':<16}{'stake':>8}{'pnl':>9}{'ret%':>8}")
        for c in closed:
            et = c['entry_t'].strftime('%Y-%m-%d %H:%M') if hasattr(c['entry_t'], 'strftime') else str(c['entry_t'])
            xt = c['exit_t'].strftime('%Y-%m-%d %H:%M') if hasattr(c['exit_t'], 'strftime') else str(c['exit_t'])
            print(f"{c['pair']:<9}{et:<22}{xt:<22}{c['reason']:<16}"
                  f"{c['stake']:>8.2f}{c['pnl']:>+9.2f}{c['ret_pct']:>+8.2f}")


if __name__ == "__main__":
    run()
