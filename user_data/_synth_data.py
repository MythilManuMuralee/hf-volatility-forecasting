# One-off SYNTHETIC data generator (network egress to exchanges is blocked in
# this environment). Produces freqtrade-format feather files so the training
# and backtest pipeline can be smoke-tested. NOT real market data.
from pathlib import Path

import numpy as np
import pandas as pd

DAYS = 190
BARS = DAYS * 288
END = pd.Timestamp("2026-06-12 12:00", tz="UTC")
OUT = Path(__file__).resolve().parent / "data" / "kraken"
OUT.mkdir(parents=True, exist_ok=True)

rng = np.random.default_rng(42)
dates = pd.date_range(end=END, periods=BARS, freq="5min")


def make_pair(start_price: float, base_vol: float, fname: str) -> None:
    # Slow mean-reverting log-vol (so RV has learnable persistence) plus
    # intraday seasonality and occasional vol spikes.
    log_vol = np.zeros(BARS)
    for t in range(1, BARS):
        log_vol[t] = 0.999 * log_vol[t - 1] + 0.045 * rng.standard_normal()
    hour = np.asarray(dates.hour + dates.minute / 60, dtype=float)
    seasonal = 1.0 + 0.35 * np.sin(2 * np.pi * (hour - 3) / 24)
    spikes = (rng.random(BARS) < 0.0008) * rng.exponential(1.5, BARS)
    vol = base_vol * np.exp(0.6 * log_vol) * seasonal * (1 + spikes)

    # Regime-switching drift to create momentum the entry filter can latch onto.
    drift = np.repeat(
        rng.normal(0, 0.00006, BARS // 576 + 1), 576
    )[:BARS]
    rets = drift + vol * rng.standard_normal(BARS)
    close = start_price * np.exp(np.cumsum(rets))
    open_ = np.concatenate([[start_price], close[:-1]])
    wick = np.abs(rng.standard_normal((2, BARS))) * vol * close
    high = np.maximum(open_, close) + wick[0]
    low = np.minimum(open_, close) - wick[1]
    volume = np.exp(rng.normal(3, 0.5, BARS)) * (vol / base_vol)

    df = pd.DataFrame(
        {
            "date": dates,
            "open": open_,
            "high": high,
            "low": low,
            "close": close,
            "volume": volume,
        }
    )
    df.to_feather(OUT / fname)
    print(f"{fname}: {len(df)} bars, {df['date'].iloc[0]} -> {df['date'].iloc[-1]}")


make_pair(95000.0, 0.0011, "BTC_USDT-5m.feather")
make_pair(3400.0, 0.0014, "ETH_USDT-5m.feather")
