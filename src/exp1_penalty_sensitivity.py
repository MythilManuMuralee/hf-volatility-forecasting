import sys, os, warnings
import numpy as np
import pandas as pd
import xgboost as xgb
from arch import arch_model
warnings.filterwarnings("ignore")

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from data_pipeline import fetch_data, clean_missing_ticks, calculate_rolling_rv
from xgboost_model import generate_features

bars_per_year = 252 * 288

def calc_sharpe(r):
    s = np.std(r)
    return (np.mean(r) / s) * np.sqrt(bars_per_year) if s > 0 else 0

def calc_ann_ret(r):
    return (1 + np.mean(r)) ** bars_per_year - 1

def calc_max_dd(r):
    cum = (1 + pd.Series(r)).cumprod()
    return ((cum - cum.cummax()) / cum.cummax()).min()

def make_objective(penalty):
    def obj(y_true, y_pred):
        grad = np.where(y_true > y_pred, penalty * (y_pred - y_true), (y_pred - y_true))
        hess = np.where(y_true > y_pred, penalty, 1.0)
        return grad, hess
    return obj

# data
raw = fetch_data(ticker="ES=F", period="59d", interval="5m")
cleaned = clean_missing_ticks(raw)
base = calculate_rolling_rv(cleaned, window=288)
df = generate_features(base).dropna()

feat_cols = ['Realized_Volatility','Returns','RV_Lag_1','RV_Lag_3','RV_Lag_6',
             'RV_Rolling_Mean_12','RV_Rolling_Std_12','Returns_Lag_1','Returns_Rolling_Std_12']

split = int(len(df) * 0.8)
train, test = df.iloc[:split], df.iloc[split:]
X_tr, y_tr = train[feat_cols].values, train['Target_RV'].values
X_te = test[feat_cols].values
actual_ret = test['Returns'].shift(-1).fillna(0).values
target_rv = np.median(train['Realized_Volatility'])

# GARCH reference (for context only)
train_ret_scaled = 100.0 * train['Returns']
garch = arch_model(train_ret_scaled, vol='Garch', p=1, q=1, mean='Zero', rescale=False).fit(disp='off')
full_ret_scaled = 100.0 * df['Returns']
fixed = arch_model(full_ret_scaled, vol='Garch', p=1, q=1, mean='Zero', rescale=False).fix(garch.params)
garch_fc = (fixed.conditional_volatility.values / 100.0) * np.sqrt(288)
garch_fc_test = garch_fc[split:]
garch_w = np.clip(target_rv / np.maximum(garch_fc_test, 1e-6), 0.1, 2.0)
garch_r = garch_w * actual_ret

print("=" * 78)
print("EXPERIMENT 1: ASYMMETRIC PENALTY SENSITIVITY")
print("=" * 78)
print(f"{'Penalty':>10} | {'Sharpe':>8} | {'Ann.Ret':>9} | {'Ann.Vol':>9} | {'Max DD':>8} | {'Mean Fcst':>10} | {'Mean Actual':>11}")
print("-" * 78)

for pen in [1.0, 1.5, 2.0, 3.0, 5.0]:
    model = xgb.XGBRegressor(n_estimators=100, max_depth=3, learning_rate=0.05,
                             objective=make_objective(pen), n_jobs=-1, random_state=42)
    model.fit(X_tr, y_tr)
    fc = model.predict(X_te)
    w = np.clip(target_rv / np.maximum(fc, 1e-6), 0.1, 2.0)
    r = w * actual_ret
    print(f"{pen:>10.1f} | {calc_sharpe(r):>8.4f} | {calc_ann_ret(r):>8.2%} | "
          f"{np.std(r)*np.sqrt(bars_per_year):>8.2%} | {calc_max_dd(r):>7.2%} | "
          f"{np.mean(fc):>10.6f} | {np.mean(test['Target_RV'].dropna()):>11.6f}")

print("-" * 78)
print(f"{'GARCH ref':>10} | {calc_sharpe(garch_r):>8.4f} | {calc_ann_ret(garch_r):>8.2%} | "
      f"{np.std(garch_r)*np.sqrt(bars_per_year):>8.2%} | {calc_max_dd(garch_r):>7.2%} | "
      f"{np.mean(garch_fc_test):>10.6f} | {np.mean(test['Target_RV'].dropna()):>11.6f}")
print("=" * 78)
