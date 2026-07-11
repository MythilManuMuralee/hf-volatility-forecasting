"""
Funding-rate carry ("cash-and-carry") downloader + backtest.

Data: Binance USDT-margined perp funding history (fapi.binance.com, public,
no key). Funding is exchanged every 8h; the rate applies to position notional.

Strategy model (long spot + 1x short perp, market-neutral):
  - Enter when the trailing N-day average funding, annualized, exceeds
    ENTER_APR (rich enough to pay the round-trip fees).
  - Exit when the trailing average annualized funding drops below EXIT_APR.
  - While in position, each 8h period earns  notional * funding_rate.
  - Costs: spot taker + perp taker on entry AND exit (4 legs total).
  - Only ~half the capital is deployed as earning notional (other half is
    futures collateral), controlled by CAPITAL_UTILIZATION.

Honesty notes:
  - Ignores basis P/L at entry/exit (perp tracks spot closely; entering when
    funding is rich usually means entering at a small positive basis, which
    is a small tailwind we conservatively ignore).
  - Ignores liquidation risk (assumes collateral is managed; at 1x with
    rebalancing this is an operational task, not a modeling one).
  - Binance rates used as proxy for the venue you'd actually trade on;
    Kraken funding correlates but differs in level.

Usage:
  python3 _funding_carry.py download   # fetch full funding history
  python3 _funding_carry.py backtest   # weekly return distribution
"""
import json
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np
import pandas as pd

UD = Path(__file__).resolve().parent
OUT = UD / "data" / "funding"
SYMBOLS = ["BTCUSDT", "ETHUSDT"]
BASE = "https://fapi.binance.com/fapi/v1/fundingRate"

CAPITAL = 300.0                 # user's stake, EUR (~USD parity assumed)
CAPITAL_UTILIZATION = 0.48      # fraction deployed as earning notional
SPOT_FEE = 0.0026               # Kraken spot taker, per side
PERP_FEE = 0.0005               # Kraken futures taker, per side
ROUND_TRIP_COST = 2 * (SPOT_FEE + PERP_FEE)   # entry + exit, both legs

LOOKBACK_DAYS = 3               # trailing window for the funding signal
ENTER_APR = 0.05                # enter when trailing funding > 5% annualized
EXIT_APR = 0.0                  # exit when it drops below 0%
PERIODS_PER_YEAR = 3 * 365      # 8h funding periods


def download():
    OUT.mkdir(parents=True, exist_ok=True)
    for sym in SYMBOLS:
        rows = []
        start = 1568102400000  # 2019-09-10, around perp launch
        while True:
            url = f"{BASE}?symbol={sym}&startTime={start}&limit=1000"
            with urllib.request.urlopen(url, timeout=30) as r:
                batch = json.loads(r.read())
            if not batch:
                break
            rows.extend(batch)
            last = batch[-1]["fundingTime"]
            if len(batch) < 1000:
                break
            start = last + 1
            time.sleep(0.3)
        df = pd.DataFrame(rows)
        df["fundingRate"] = df["fundingRate"].astype(float)
        df["date"] = pd.to_datetime(df["fundingTime"], unit="ms", utc=True)
        df = df[["date", "fundingRate"]].drop_duplicates("date").sort_values("date")
        df.to_feather(OUT / f"{sym}.feather")
        print(f"{sym}: {len(df)} funding periods, "
              f"{df['date'].iloc[0].date()} -> {df['date'].iloc[-1].date()}, "
              f"mean APR {df['fundingRate'].mean() * PERIODS_PER_YEAR * 100:.1f}%")


def backtest():
    for sym in SYMBOLS:
        df = pd.read_feather(OUT / f"{sym}.feather").set_index("date")
        fr = df["fundingRate"]
        trailing_apr = fr.rolling(LOOKBACK_DAYS * 3).mean() * PERIODS_PER_YEAR

        notional = CAPITAL * CAPITAL_UTILIZATION
        in_pos = False
        equity = CAPITAL
        curve = []
        entries = 0
        for t, rate in fr.items():
            apr = trailing_apr.loc[t]
            if not in_pos and np.isfinite(apr) and apr > ENTER_APR:
                in_pos = True
                entries += 1
                equity -= notional * (SPOT_FEE + PERP_FEE)
            elif in_pos and np.isfinite(apr) and apr < EXIT_APR:
                in_pos = False
                equity -= notional * (SPOT_FEE + PERP_FEE)
            if in_pos:
                equity += notional * rate
            curve.append((t, equity, in_pos))

        ec = pd.DataFrame(curve, columns=["date", "equity", "in_pos"]).set_index("date")
        weekly = ec["equity"].resample("W-MON").last()
        wret = weekly.diff().dropna()
        wret_pct = wret / CAPITAL * 100

        yrs = (ec.index[-1] - ec.index[0]).days / 365.25
        total = ec["equity"].iloc[-1] - CAPITAL
        print(f"\n=== {sym}  ({ec.index[0].date()} -> {ec.index[-1].date()}, "
              f"{yrs:.1f}y, {entries} entries, "
              f"time in market {ec['in_pos'].mean()*100:.0f}%) ===")
        print(f"capital {CAPITAL:.0f}, earning notional {notional:.0f}, "
              f"round-trip cost {ROUND_TRIP_COST*notional:.2f}")
        print(f"total P/L: {total:+.2f}  ({total/CAPITAL*100:+.1f}% on capital, "
              f"{total/CAPITAL/yrs*100:+.2f}%/yr avg)")
        print(f"weekly P/L on {CAPITAL:.0f}: mean {wret.mean():+.3f} "
              f"({wret_pct.mean():+.3f}%)  median {wret.median():+.3f}")
        print(f"positive weeks: {(wret > 0).sum()}/{len(wret)} "
              f"({(wret > 0).mean()*100:.0f}%)   zero: {(wret == 0).sum()}   "
              f"negative: {(wret < 0).sum()}")
        print(f"best week {wret.max():+.2f}   worst week {wret.min():+.2f}")
        by_year = ec["equity"].resample("YE").last().diff()
        first_year = ec["equity"].resample("YE").last().iloc[0] - CAPITAL
        by_year.iloc[0] = first_year
        print("per-year P/L: " + "  ".join(
            f"{idx.year}: {v:+.2f}" for idx, v in by_year.items()))


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "backtest"
    {"download": download, "backtest": backtest}[cmd]()
