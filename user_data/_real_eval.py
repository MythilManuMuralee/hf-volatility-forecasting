"""
Out-of-sample weekly evaluation of the MythilVol strategy on REAL market data.

Data: Bitfinex 1m candles (BTC/USD, ETH/USD) 2017-2019, resampled to 5m + 1d.
Protocol:
  1. Train the XGBoost vol model ONLY on 2017-01 .. 2018-12.
  2. Backtest each calendar week of 2019 independently with a fresh 100-unit
     wallet (plus a continuous compounding run across the whole year).
  3. Fills: entry/exit signals computed on bar t are filled at bar t+1 OPEN.
     Stops/trailing evaluated intrabar; trailing peak uses highs up to the
     PREVIOUS bar (conservative). Kraken-style fees 0.26%/side.

Usage:
  python3 _real_eval.py prepare   # build 5m/1d frames from raw CSVs
  python3 _real_eval.py train     # train vol model on 2017-2018
  python3 _real_eval.py eval      # weekly OOS backtests over 2019
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import xgboost as xgb

UD = Path(__file__).resolve().parent
RAW = Path("/tmp/claude-0/-home-user-hf-volatility-forecasting/48c5edc2-7cda-5c67-811d-e2a028d5d802/scratchpad/rawdata")
DATA = UD / "data" / "bitfinex"
MODEL_PATH = UD / "models" / "vol_model_real.json"

PAIRS = ["BTCUSD", "ETHUSD"]
YEARS = [2017, 2018, 2019]
TRAIN_END = pd.Timestamp("2019-01-01", tz="UTC")

RV_WINDOW = 288
FEATURE_COLUMNS = [
    "rv_lag_1", "rv_lag_3", "rv_lag_6", "rv_mean_12", "rv_std_12",
    "ret_mean_12", "ret_std_12", "hour_sin", "hour_cos",
]
UNDER_PREDICTION_PENALTY = 3.0
XGB_PARAMS = {
    "max_depth": 4, "eta": 0.05, "subsample": 0.8, "colsample_bytree": 0.8,
    "min_child_weight": 5.0, "seed": 42, "nthread": 4,
}
NUM_BOOST_ROUND = 300

START_WALLET = 100.0
MAX_OPEN_TRADES = 2
TRADABLE_RATIO = 0.99
FEE = 0.0026
STOPLOSS = -0.03
TRAIL_POSITIVE = 0.01
TRAIL_OFFSET = 0.02
STAKE_SCALE_MIN, STAKE_SCALE_MAX = 0.1, 2.0


def compute_vol_features(df: pd.DataFrame) -> pd.DataFrame:
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


def ta_ema(s: pd.Series, period: int) -> pd.Series:
    alpha = 2.0 / (period + 1)
    vals = s.to_numpy(dtype=float)
    res = np.full(len(s), np.nan)
    if len(s) >= period:
        res[period - 1] = np.nanmean(vals[:period])
        for i in range(period, len(s)):
            res[i] = alpha * vals[i] + (1 - alpha) * res[i - 1]
    return pd.Series(res, index=s.index)


def ta_rsi(s: pd.Series, period: int = 14) -> pd.Series:
    delta = s.diff()
    gain = delta.clip(lower=0.0)
    loss = -delta.clip(upper=0.0)
    avg_gain = gain.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    avg_loss = loss.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    rs = avg_gain / avg_loss
    return 100 - 100 / (1 + rs)


# ---------------------------------------------------------------- prepare
def prepare():
    DATA.mkdir(parents=True, exist_ok=True)
    for pair in PAIRS:
        frames = []
        for yr in YEARS:
            gz, csv = RAW / f"{pair}_{yr}.csv.gz", RAW / f"{pair}_{yr}.csv"
            src = gz if gz.exists() else csv
            if not src.exists():
                print(f"skip {pair} {yr}: no file")
                continue
            # Bitfinex candle order: MTS, OPEN, CLOSE, HIGH, LOW, VOLUME
            df = pd.read_csv(src, header=None,
                             names=["ts", "open", "close", "high", "low", "volume"])
            frames.append(df)
        raw = pd.concat(frames, ignore_index=True)
        raw["date"] = pd.to_datetime(raw["ts"], unit="ms", utc=True)
        raw = (raw.drop(columns="ts").drop_duplicates(subset="date")
                  .sort_values("date").set_index("date"))
        # sanity: enforce OHLC consistency (a handful of rows are dirty)
        bad = (raw["high"] < raw[["open", "close"]].max(axis=1)) | \
              (raw["low"] > raw[["open", "close"]].min(axis=1))
        raw.loc[bad, "high"] = raw.loc[bad, ["open", "close", "high"]].max(axis=1)
        raw.loc[bad, "low"] = raw.loc[bad, ["open", "close", "low"]].min(axis=1)

        agg = dict(open=("open", "first"), high=("high", "max"),
                   low=("low", "min"), close=("close", "last"),
                   volume=("volume", "sum"))
        m5 = raw.resample("5min").agg(**agg).dropna().reset_index()
        d1 = raw.resample("1D").agg(**agg).dropna().reset_index()
        m5.to_feather(DATA / f"{pair}-5m.feather")
        d1.to_feather(DATA / f"{pair}-1d.feather")
        print(f"{pair}: 1m rows={len(raw)}, 5m bars={len(m5)} "
              f"({m5['date'].iloc[0].date()} -> {m5['date'].iloc[-1].date()}), daily={len(d1)}")


# ------------------------------------------------------------------ train
def asymmetric_objective(preds, dtrain):
    y = dtrain.get_label()
    residual = preds - y
    w = np.where(residual < 0, UNDER_PREDICTION_PENALTY, 1.0)
    return 2.0 * w * residual, 2.0 * w


def train():
    frames = []
    for pair in PAIRS:
        df = pd.read_feather(DATA / f"{pair}-5m.feather")
        df = compute_vol_features(df)
        df["rv_target"] = df["rv"].shift(-RV_WINDOW)
        df = df[df["date"] < TRAIN_END]
        frames.append(df)
    data = pd.concat(frames, ignore_index=True).dropna(
        subset=FEATURE_COLUMNS + ["rv_target"])
    print(f"train samples: {len(data)} "
          f"({data['date'].min().date()} -> {data['date'].max().date()})")

    # simple 80/20 chronological holdout report
    data = data.sort_values("date").reset_index(drop=True)
    cut = int(len(data) * 0.8)
    tr, te = data.iloc[:cut], data.iloc[cut:]
    dtr = xgb.DMatrix(tr[FEATURE_COLUMNS], label=tr["rv_target"])
    dte = xgb.DMatrix(te[FEATURE_COLUMNS], label=te["rv_target"])
    booster = xgb.train(XGB_PARAMS, dtr, NUM_BOOST_ROUND, obj=asymmetric_objective)
    p = booster.predict(dte)
    y = te["rv_target"].to_numpy()
    print(f"holdout rmse={np.sqrt(np.mean((p-y)**2)):.6f}  bias={np.mean(p-y):+.6f}")
    # naive persistence baseline: predict rv_lag_1
    base = te["rv_lag_1"].to_numpy()
    print(f"persistence rmse={np.sqrt(np.mean((base-y)**2)):.6f}")

    dall = xgb.DMatrix(data[FEATURE_COLUMNS], label=data["rv_target"])
    booster = xgb.train(XGB_PARAMS, dall, NUM_BOOST_ROUND, obj=asymmetric_objective)
    booster.save_model(str(MODEL_PATH))
    print(f"saved {MODEL_PATH}")


# ------------------------------------------------------------------- eval
def build_frames(model):
    out = {}
    for pair in PAIRS:
        df = pd.read_feather(DATA / f"{pair}-5m.feather")
        df = compute_vol_features(df)
        dmat = xgb.DMatrix(df[FEATURE_COLUMNS].values, feature_names=FEATURE_COLUMNS)
        df["forecast_vol"] = model.predict(dmat)
        df["target_vol"] = df["rv"].rolling(RV_WINDOW, min_periods=RV_WINDOW // 2).median()
        df["ema_50"] = ta_ema(df["close"], 50)
        df["rsi"] = ta_rsi(df["close"], 14)

        daily = pd.read_feather(DATA / f"{pair}-1d.feather")
        df["date"] = df["date"].astype("datetime64[us, UTC]")
        daily["date"] = daily["date"].astype("datetime64[us, UTC]")
        daily["ema_20"] = ta_ema(daily["close"], 20)
        daily["date_merge"] = daily["date"] + pd.Timedelta(days=1) - pd.Timedelta(minutes=5)
        df = pd.merge_asof(
            df.sort_values("date"),
            daily[["date_merge", "close", "ema_20"]].rename(
                columns={"close": "close_1d", "ema_20": "ema_20_1d"}),
            left_on="date", right_on="date_merge", direction="backward")

        xa = (df["close"].shift(1) <= df["ema_50"].shift(1)) & (df["close"] > df["ema_50"])
        enter_raw = ((df["close_1d"] > df["ema_20_1d"]) & xa
                     & (df["rsi"] > 30) & (df["rsi"] < 70)
                     & (df["forecast_vol"] > 0) & (df["volume"] > 0)).fillna(False)
        exit_raw = ((df["close_1d"] < df["ema_20_1d"]) & (df["volume"] > 0)).fillna(False)
        # signal on bar t -> act at bar t+1 open
        df["enter_fill"] = enter_raw.shift(1).fillna(False)
        df["exit_fill"] = exit_raw.shift(1).fillna(False)
        # sizing snapshot from the SIGNAL bar (what live would have known)
        df["fv_sig"] = df["forecast_vol"].shift(1)
        df["tv_sig"] = df["target_vol"].shift(1)
        out[pair] = df.set_index("date")
    return out


def run_window(frames, t0, t1, start_wallet=START_WALLET):
    wallet = start_wallet
    open_trades = {}
    closed = []
    times = sorted(set().union(*[
        set(f.index[(f.index >= t0) & (f.index < t1)]) for f in frames.values()]))
    for t in times:
        for p, f in frames.items():
            if t not in f.index:
                continue
            row = f.loc[t]
            if p in open_trades:
                tr = open_trades[p]
                entry = tr["entry_price"]
                exit_price = reason = None
                if tr.get("exit_pending") or bool(row["exit_fill"]):
                    exit_price, reason = row["open"], "exit_signal"
                if exit_price is None:
                    stop_line = entry * (1 + STOPLOSS)
                    if row["open"] <= stop_line:
                        exit_price, reason = row["open"], "stoploss_gap"
                    elif row["low"] <= stop_line:
                        exit_price, reason = stop_line, "stoploss"
                if exit_price is None and tr["peak"] >= TRAIL_OFFSET:
                    trail_line = entry * (1 + tr["peak"] - TRAIL_POSITIVE)
                    if row["open"] <= trail_line:
                        exit_price, reason = row["open"], "trailing_gap"
                    elif row["low"] <= trail_line:
                        exit_price, reason = trail_line, "trailing_stop"
                if exit_price is not None:
                    proceeds = tr["qty"] * exit_price * (1 - FEE)
                    wallet += proceeds
                    closed.append({"pair": p, "entry_t": tr["entry_t"], "exit_t": t,
                                   "reason": reason, "stake": tr["stake"],
                                   "pnl": proceeds - tr["stake"]})
                    del open_trades[p]
                else:
                    tr["peak"] = max(tr["peak"], (row["high"] - entry) / entry)
            elif bool(row["enter_fill"]) and len(open_trades) < MAX_OPEN_TRADES:
                total = wallet + sum(tr["stake"] for tr in open_trades.values())
                base = total * TRADABLE_RATIO / MAX_OPEN_TRADES
                fv, tv = row["fv_sig"], row["tv_sig"]
                scale = 1.0
                if np.isfinite(fv) and np.isfinite(tv) and fv > 0:
                    scale = float(np.clip(tv / fv, STAKE_SCALE_MIN, STAKE_SCALE_MAX))
                stake = min(base * scale, wallet)
                if stake < 0.5:
                    continue
                price = row["open"]
                open_trades[p] = {"entry_t": t, "entry_price": price,
                                  "qty": stake * (1 - FEE) / price,
                                  "stake": stake, "peak": 0.0}
                wallet -= stake
    # liquidate at window end
    for p, tr in open_trades.items():
        f = frames[p]
        seg = f.loc[(f.index >= t0) & (f.index < t1)]
        last_close = seg["close"].iloc[-1]
        proceeds = tr["qty"] * last_close * (1 - FEE)
        wallet += proceeds
        closed.append({"pair": p, "entry_t": tr["entry_t"], "exit_t": "eow",
                       "reason": "liquidate", "stake": tr["stake"],
                       "pnl": proceeds - tr["stake"]})
    return wallet, closed


def evaluate():
    model = xgb.Booster()
    model.load_model(str(MODEL_PATH))
    frames = build_frames(model)

    weeks = pd.date_range("2019-01-07", "2019-12-23", freq="W-MON", tz="UTC")
    rows = []
    for w0 in weeks:
        w1 = w0 + pd.Timedelta(days=7)
        wallet, closed = run_window(frames, w0, w1)
        rows.append({"week": w0.date(), "end_wallet": wallet,
                     "ret_pct": (wallet / START_WALLET - 1) * 100,
                     "trades": len(closed),
                     "wins": sum(1 for c in closed if c["pnl"] > 0)})
    res = pd.DataFrame(rows)
    print("\n=== independent weekly runs, 100 start, 2019 OOS ===")
    print(res.to_string(index=False))
    r = res["ret_pct"]
    print(f"\nweeks: {len(res)}   mean: {r.mean():+.2f}%   median: {r.median():+.2f}%")
    print(f"std: {r.std():.2f}%   best: {r.max():+.2f}%   worst: {r.min():+.2f}%")
    print(f"positive weeks: {(r > 0).sum()}/{len(res)}  "
          f"flat(no trades): {(res['trades'] == 0).sum()}")
    print(f"avg trades/week: {res['trades'].mean():.1f}")

    w, closed = run_window(frames,
                           pd.Timestamp("2019-01-07", tz="UTC"),
                           pd.Timestamp("2019-12-30", tz="UTC"))
    n = len(closed)
    wins = sum(1 for c in closed if c["pnl"] > 0)
    fees_paid = sum(c["stake"] * FEE * 2 for c in closed)  # approx round-trip
    print(f"\n=== continuous 2019 run ===")
    print(f"100.00 -> {w:.2f}  ({(w/100-1)*100:+.2f}% over ~51 weeks, "
          f"= {((w/100)**(1/51)-1)*100:+.3f}%/week compounded)")
    print(f"trades: {n}  wins: {wins} ({wins/max(n,1)*100:.0f}%)  approx fees paid: {fees_paid:.2f}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "eval"
    {"prepare": prepare, "train": train, "eval": evaluate}[cmd]()
