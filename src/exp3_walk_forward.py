import sys, os, warnings
import numpy as np
import pandas as pd
import xgboost as xgb
from arch import arch_model
warnings.filterwarnings("ignore")

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from data_pipeline import fetch_data, clean_missing_ticks, calculate_rolling_rv
from xgboost_model import generate_features, asymmetric_mse_objective

bars_per_year = 252 * 288

def calc_sharpe(r):
    s = np.std(r)
    return (np.mean(r) / s) * np.sqrt(bars_per_year) if s > 0 else 0
def calc_ann_ret(r):
    return (1 + np.mean(r)) ** bars_per_year - 1
def calc_max_dd(r):
    cum = (1 + pd.Series(r)).cumprod()
    return ((cum - cum.cummax()) / cum.cummax()).min()

# data
raw = fetch_data(ticker="ES=F", period="59d", interval="5m")
cleaned = clean_missing_ticks(raw)
base = calculate_rolling_rv(cleaned, window=288)
df = generate_features(base).dropna()
n = len(df)

feat_cols = ['Realized_Volatility','Returns','RV_Lag_1','RV_Lag_3','RV_Lag_6',
             'RV_Rolling_Mean_12','RV_Rolling_Std_12','Returns_Lag_1','Returns_Rolling_Std_12']

# Expanding-window walk-forward: 3 test folds, each ~20% of total data
# Window 1: train 0-40%, test 40-60%
# Window 2: train 0-60%, test 60-80%
# Window 3: train 0-80%, test 80-100%  (original split)
boundaries = [
    (0, int(n * 0.40), int(n * 0.40), int(n * 0.60)),
    (0, int(n * 0.60), int(n * 0.60), int(n * 0.80)),
    (0, int(n * 0.80), int(n * 0.80), n),
]

print("=" * 92)
print("EXPERIMENT 3: EXPANDING-WINDOW WALK-FORWARD VALIDATION")
print("=" * 92)

for fold_idx, (tr_start, tr_end, te_start, te_end) in enumerate(boundaries, 1):
    train_df = df.iloc[tr_start:tr_end]
    test_df = df.iloc[te_start:te_end]

    X_tr = train_df[feat_cols].values
    y_tr = train_df['Target_RV'].values
    X_te = test_df[feat_cols].values
    actual_ret = test_df['Returns'].shift(-1).fillna(0).values
    target_rv = np.median(train_df['Realized_Volatility'])

    tr_mean_rv = train_df['Realized_Volatility'].mean()
    te_mean_rv = test_df['Realized_Volatility'].mean()
    regime_shift = (te_mean_rv / tr_mean_rv - 1) * 100

    date_start = test_df.index.min().strftime('%Y-%m-%d')
    date_end = test_df.index.max().strftime('%Y-%m-%d')

    print(f"\n--- FOLD {fold_idx} | Test: {date_start} to {date_end} | "
          f"Train bars: {tr_end - tr_start} | Test bars: {te_end - te_start} ---")
    print(f"Train mean RV: {tr_mean_rv:.6f} | Test mean RV: {te_mean_rv:.6f} | "
          f"Regime shift: {regime_shift:+.1f}%")

    # Naive persistence
    naive_fc = test_df['Realized_Volatility'].values
    naive_w = np.clip(target_rv / np.maximum(naive_fc, 1e-6), 0.1, 2.0)
    naive_r = naive_w * actual_ret

    # XGBoost (asymmetric p=3, original model spec)
    xgb_model = xgb.XGBRegressor(n_estimators=100, max_depth=3, learning_rate=0.05,
                                  objective=asymmetric_mse_objective, n_jobs=-1, random_state=42)
    xgb_model.fit(X_tr, y_tr)
    xgb_fc = xgb_model.predict(X_te)
    xgb_w = np.clip(target_rv / np.maximum(xgb_fc, 1e-6), 0.1, 2.0)
    xgb_r = xgb_w * actual_ret

    # GARCH
    fold_df = df.iloc[tr_start:te_end]
    fold_train_ret = 100.0 * train_df['Returns']
    garch_fit = arch_model(fold_train_ret, vol='Garch', p=1, q=1, mean='Zero',
                           rescale=False).fit(disp='off')
    fold_all_ret = 100.0 * fold_df['Returns']
    fixed = arch_model(fold_all_ret, vol='Garch', p=1, q=1, mean='Zero',
                       rescale=False).fix(garch_fit.params)
    garch_cv = fixed.conditional_volatility.values
    garch_fc = ((garch_cv / 100.0) * np.sqrt(288))[(tr_end - tr_start):]
    garch_w = np.clip(target_rv / np.maximum(garch_fc, 1e-6), 0.1, 2.0)
    garch_r = garch_w * actual_ret

    # Hybrid 50/50
    hybrid_fc = 0.5 * xgb_fc + 0.5 * garch_fc
    hybrid_w = np.clip(target_rv / np.maximum(hybrid_fc, 1e-6), 0.1, 2.0)
    hybrid_r = hybrid_w * actual_ret

    # Buy & hold
    bnh_r = actual_ret

    print(f"{'Model':<22} | {'Sharpe':>8} | {'Ann.Ret':>9} | {'Max DD':>8} | {'Fcst Bias':>10}")
    print("-" * 72)
    for name, r, fc in [
        ("Buy & Hold", bnh_r, None),
        ("Naive Persistence", naive_r, naive_fc),
        ("GARCH(1,1)", garch_r, garch_fc),
        ("XGBoost (asym p=3)", xgb_r, xgb_fc),
        ("Hybrid GARCH-XGB", hybrid_r, hybrid_fc),
    ]:
        bias_str = f"{np.mean(fc) - te_mean_rv:+.6f}" if fc is not None else "N/A"
        print(f"{name:<22} | {calc_sharpe(r):>8.4f} | {calc_ann_ret(r):>8.2%} | "
              f"{calc_max_dd(r):>7.2%} | {bias_str:>10}")

print("\n" + "=" * 92)
print("SUMMARY: SHARPE RATIO RANKING BY FOLD")
print("=" * 92)
print("(Re-examine whether GARCH > XGBoost is stable or regime-dependent)")
print("=" * 92)
