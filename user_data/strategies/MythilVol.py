"""
MythilVol - volatility-forecast-driven strategy.

Core idea: position sizing is driven by a realized-volatility (RV) forecast.
The forecast comes from an XGBoost model trained offline by
``user_data/train_vol_model.py`` (saved to ``user_data/models/vol_model.json``).
If the model file (or the xgboost package) is missing, the strategy falls back
to an EWMA volatility forecast so the bot keeps running.

Entries are deliberately infrequent: a daily-timeframe trend regime filter
gates a 5m EMA-crossover trigger. With Kraken spot fees (~0.5% per round
trip), trade frequency is the main thing that kills small accounts - the
first version of this entry traded ~13x/day and lost exactly the fee per
trade. Target here is roughly 1-3 trades per week per pair.

This remains a starting point, not a proven edge. Expect losing weeks and
months even if it works; validate in dry-run on real data before risking
anything.
"""

import logging
from datetime import datetime
from pathlib import Path
from typing import Optional

import numpy as np
import talib.abstract as ta
from pandas import DataFrame

import freqtrade.vendor.qtpylib.indicators as qtpylib
from freqtrade.strategy import IStrategy, merge_informative_pair


logger = logging.getLogger(__name__)

try:
    import xgboost as xgb

    XGB_AVAILABLE = True
except ImportError:
    XGB_AVAILABLE = False

# One trading day of 5m bars - window for realized volatility.
RV_WINDOW = 288

# EWMA decay for the fallback forecaster (RiskMetrics-style lambda).
EWMA_LAMBDA = 0.94

# Feature order must match user_data/train_vol_model.py exactly.
FEATURE_COLUMNS = [
    "rv_lag_1",
    "rv_lag_3",
    "rv_lag_6",
    "rv_mean_12",
    "rv_std_12",
    "ret_mean_12",
    "ret_std_12",
    "hour_sin",
    "hour_cos",
]


def compute_vol_features(dataframe: DataFrame) -> DataFrame:
    """
    Shared feature engineering for both live inference and offline training.

    ``rv`` is the trailing realized volatility: sqrt of the sum of squared 5m
    log returns over a 288-bar (1 day) window, i.e. a daily-vol unit.
    """
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


class MythilVol(IStrategy):
    INTERFACE_VERSION = 3

    timeframe = "5m"
    informative_timeframe = "1d"
    can_short = False
    process_only_new_candles = True

    # RV window (288) + trailing target-vol median window (288) + indicator warmup.
    startup_candle_count = 700

    # Exits are handled by the stops below (and the placeholder exit signal),
    # so ROI is effectively disabled.
    minimal_roi = {"0": 100}

    # Hard stop at -3%; once profit reaches +2%, trail by 1%.
    stoploss = -0.03
    trailing_stop = True
    trailing_stop_positive = 0.01
    trailing_stop_positive_offset = 0.02
    trailing_only_offset_is_reached = True

    use_exit_signal = True

    # Vol-targeting overlay bounds: stake scale is clipped to [0.1, 2.0].
    STAKE_SCALE_MIN = 0.1
    STAKE_SCALE_MAX = 2.0

    def __init__(self, config: dict) -> None:
        super().__init__(config)
        self._model = None
        model_path = Path(config["user_data_dir"]) / "models" / "vol_model.json"
        if not XGB_AVAILABLE:
            logger.warning(
                "xgboost is not installed - falling back to EWMA vol forecast. "
                "Build the image from docker/Dockerfile.custom to enable the model."
            )
        elif model_path.is_file():
            booster = xgb.Booster()
            booster.load_model(str(model_path))
            self._model = booster
            logger.info("Loaded XGBoost vol model from %s", model_path)
        else:
            logger.warning(
                "No model at %s - falling back to EWMA vol forecast. "
                "Run user_data/train_vol_model.py to train one.",
                model_path,
            )

    def informative_pairs(self):
        return [(pair, self.informative_timeframe) for pair in self.dp.current_whitelist()]

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe = compute_vol_features(dataframe)

        # Daily trend regime: only trade long while the last completed daily
        # candle closed above its 20-day EMA.
        informative = self.dp.get_pair_dataframe(
            pair=metadata["pair"], timeframe=self.informative_timeframe
        )
        informative["ema_20"] = ta.EMA(informative, timeperiod=20)
        dataframe = merge_informative_pair(
            dataframe, informative, self.timeframe, self.informative_timeframe, ffill=True
        )

        if self._model is not None:
            dmatrix = xgb.DMatrix(
                dataframe[FEATURE_COLUMNS].values, feature_names=FEATURE_COLUMNS
            )
            dataframe["forecast_vol"] = self._model.predict(dmatrix)
        else:
            # EWMA fallback: per-bar variance scaled to the same daily-vol
            # unit as ``rv`` (sqrt of 288x the per-bar EWMA variance).
            ewma_var = (
                dataframe["log_ret"].pow(2).ewm(alpha=1 - EWMA_LAMBDA, min_periods=12).mean()
            )
            dataframe["forecast_vol"] = np.sqrt(ewma_var * RV_WINDOW)

        # Vol target: trailing one-day median of realized volatility.
        dataframe["target_vol"] = (
            dataframe["rv"].rolling(RV_WINDOW, min_periods=RV_WINDOW // 2).median()
        )

        # Momentum filter inputs (placeholder signal, see populate_entry_trend).
        dataframe["ema_50"] = ta.EMA(dataframe, timeperiod=50)
        dataframe["rsi"] = ta.RSI(dataframe, timeperiod=14)

        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # Entry = regime AND trigger:
        #   regime:  daily close above daily EMA20 (uptrend on the slow clock)
        #   trigger: 5m close CROSSES above 5m EMA50 - a crossover fires once
        #            per cross instead of on every bar, which is what keeps
        #            trade count (and fee bleed) low.
        dataframe.loc[
            (dataframe["close_1d"] > dataframe["ema_20_1d"])
            & qtpylib.crossed_above(dataframe["close"], dataframe["ema_50"])
            & (dataframe["rsi"] > 30)
            & (dataframe["rsi"] < 70)
            & (dataframe["forecast_vol"] > 0)
            & (dataframe["volume"] > 0),
            "enter_long",
        ] = 1
        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # Exit only on loss of the DAILY trend regime; intratrade noise is
        # handled by the stoploss and trailing stop instead.
        dataframe.loc[
            (dataframe["close_1d"] < dataframe["ema_20_1d"]) & (dataframe["volume"] > 0),
            "exit_long",
        ] = 1
        return dataframe

    def custom_stake_amount(
        self,
        pair: str,
        current_time: datetime,
        current_rate: float,
        proposed_stake: float,
        min_stake: Optional[float],
        max_stake: float,
        leverage: float,
        entry_tag: Optional[str],
        side: str,
        **kwargs,
    ) -> float:
        """
        Vol-targeting overlay:
            stake = base_stake * clip(target_vol / forecast_vol, 0.1, 2.0)
        with base_stake = total wallet / max_open_trades and target_vol the
        trailing median RV. Scales down in high-vol regimes, up in calm ones.
        """
        base_stake = (
            self.wallets.get_total_stake_amount() / self.config["max_open_trades"]
        )

        scale = 1.0
        dataframe, _ = self.dp.get_analyzed_dataframe(pair, self.timeframe)
        if dataframe is not None and not dataframe.empty:
            last = dataframe.iloc[-1]
            forecast_vol = last.get("forecast_vol")
            target_vol = last.get("target_vol")
            if (
                forecast_vol is not None
                and target_vol is not None
                and np.isfinite(forecast_vol)
                and np.isfinite(target_vol)
                and forecast_vol > 0
            ):
                scale = float(
                    np.clip(
                        target_vol / forecast_vol,
                        self.STAKE_SCALE_MIN,
                        self.STAKE_SCALE_MAX,
                    )
                )

        stake = base_stake * scale
        stake = min(stake, max_stake)
        if min_stake is not None:
            stake = max(stake, min_stake)
        return stake
