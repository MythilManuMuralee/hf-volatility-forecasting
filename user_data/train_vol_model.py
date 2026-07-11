"""
Train the XGBoost realized-volatility forecaster used by the MythilVol strategy.

Pipeline:
  1. Download 180 days of 5m OHLCV via ``freqtrade download-data`` (skippable).
  2. Build the exact feature set the strategy uses (imported from the strategy
     module so the two can never drift apart).
  3. Train XGBoost with an asymmetric squared loss that penalizes
     UNDER-prediction of volatility 3x (custom gradient/hessian) - for
     vol-targeting, under-forecasting vol means over-sizing positions, which
     is the expensive mistake.
  4. Walk-forward (expanding window) validation, then a final fit on all data.
  5. Save to ``user_data/models/vol_model.json``.

Run inside the freqtrade container (needs xgboost - see docker/Dockerfile.custom):
  docker compose run --rm freqtrade python3 /freqtrade/user_data/train_vol_model.py
"""

import argparse
import subprocess
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import xgboost as xgb

USER_DATA_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(USER_DATA_DIR / "strategies"))
from MythilVol import FEATURE_COLUMNS, RV_WINDOW, compute_vol_features  # noqa: E402

UNDER_PREDICTION_PENALTY = 3.0

XGB_PARAMS = {
    "max_depth": 4,
    "eta": 0.05,
    "subsample": 0.8,
    "colsample_bytree": 0.8,
    "min_child_weight": 5.0,
    "seed": 42,
    "nthread": 4,
}
NUM_BOOST_ROUND = 300


def asymmetric_squared_objective(preds: np.ndarray, dtrain: xgb.DMatrix):
    """
    Squared error with asymmetric weighting:
        L(pred, y) = w * (pred - y)^2,  w = 3 if pred < y (under-prediction) else 1
    Gradient and hessian w.r.t. pred:
        grad = 2 * w * (pred - y),  hess = 2 * w
    """
    y = dtrain.get_label()
    residual = preds - y
    weight = np.where(residual < 0, UNDER_PREDICTION_PENALTY, 1.0)
    grad = 2.0 * weight * residual
    hess = 2.0 * weight
    return grad, hess


def asymmetric_loss(preds: np.ndarray, y: np.ndarray) -> float:
    residual = preds - y
    weight = np.where(residual < 0, UNDER_PREDICTION_PENALTY, 1.0)
    return float(np.mean(weight * residual**2))


def download_data(config: Path, timeframe: str, days: int) -> None:
    cmd = [
        "freqtrade",
        "download-data",
        "--config",
        str(config),
        "--timeframe",
        timeframe,
        "--days",
        str(days),
    ]
    print(f"Running: {' '.join(cmd)}")
    subprocess.run(cmd, check=True)


def load_pair_data(datadir: Path, pair: str, timeframe: str) -> pd.DataFrame:
    path = datadir / f"{pair.replace('/', '_')}-{timeframe}.feather"
    if not path.is_file():
        raise FileNotFoundError(f"No data file at {path} - run download-data first.")
    df = pd.read_feather(path)
    df["date"] = pd.to_datetime(df["date"], utc=True)
    return df.sort_values("date").reset_index(drop=True)


def build_dataset(datadir: Path, pairs: list[str], timeframe: str) -> pd.DataFrame:
    frames = []
    for pair in pairs:
        df = load_pair_data(datadir, pair, timeframe)
        df = compute_vol_features(df)
        # Target: realized vol over the NEXT 288 bars. ``rv`` at t+288 covers
        # returns from t+1 through t+288, so shifting it back aligns the
        # future window with the features known at t.
        df["rv_target"] = df["rv"].shift(-RV_WINDOW)
        df["pair"] = pair
        frames.append(df)
    data = pd.concat(frames, ignore_index=True)
    data = data.dropna(subset=FEATURE_COLUMNS + ["rv_target"])
    return data.sort_values("date").reset_index(drop=True)


def walk_forward_validate(data: pd.DataFrame, n_folds: int = 5) -> None:
    """Expanding-window walk-forward: train on [0, split), test on the next chunk."""
    n = len(data)
    fold_size = n // (n_folds + 1)
    print(f"\nWalk-forward validation ({n_folds} folds, {n} samples total)")
    print(f"{'fold':>4} {'train':>8} {'test':>8} {'rmse':>12} {'asym_loss':>12} {'bias':>10}")
    for fold in range(1, n_folds + 1):
        train_end = fold * fold_size
        test_end = min(train_end + fold_size, n)
        train, test = data.iloc[:train_end], data.iloc[train_end:test_end]

        dtrain = xgb.DMatrix(train[FEATURE_COLUMNS], label=train["rv_target"])
        dtest = xgb.DMatrix(test[FEATURE_COLUMNS], label=test["rv_target"])
        booster = xgb.train(
            XGB_PARAMS, dtrain, NUM_BOOST_ROUND, obj=asymmetric_squared_objective
        )
        preds = booster.predict(dtest)
        y = test["rv_target"].to_numpy()
        rmse = float(np.sqrt(np.mean((preds - y) ** 2)))
        # bias > 0 means over-prediction on average (the asymmetric loss
        # should push the model in this direction).
        bias = float(np.mean(preds - y))
        print(
            f"{fold:>4} {len(train):>8} {len(test):>8} "
            f"{rmse:>12.6f} {asymmetric_loss(preds, y):>12.6f} {bias:>10.6f}"
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=USER_DATA_DIR / "config.json")
    parser.add_argument("--exchange", default="kraken")
    parser.add_argument("--pairs", nargs="+", default=["BTC/USDT", "ETH/USDT"])
    parser.add_argument("--timeframe", default="5m")
    parser.add_argument("--days", type=int, default=180)
    parser.add_argument(
        "--skip-download", action="store_true", help="Use already-downloaded data."
    )
    parser.add_argument("--folds", type=int, default=5)
    args = parser.parse_args()

    if not args.skip_download:
        download_data(args.config, args.timeframe, args.days)

    datadir = USER_DATA_DIR / "data" / args.exchange
    data = build_dataset(datadir, args.pairs, args.timeframe)
    print(
        f"Dataset: {len(data)} samples, {data['date'].min()} -> {data['date'].max()}, "
        f"pairs: {args.pairs}"
    )

    walk_forward_validate(data, n_folds=args.folds)

    print("\nTraining final model on all data...")
    dtrain = xgb.DMatrix(data[FEATURE_COLUMNS], label=data["rv_target"])
    booster = xgb.train(
        XGB_PARAMS, dtrain, NUM_BOOST_ROUND, obj=asymmetric_squared_objective
    )

    out_dir = USER_DATA_DIR / "models"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "vol_model.json"
    booster.save_model(str(out_path))
    print(f"Saved model to {out_path}")


if __name__ == "__main__":
    main()
