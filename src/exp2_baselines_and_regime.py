import sys, os, warnings
import numpy as np
import pandas as pd
import xgboost as xgb
from arch import arch_model
from sklearn.linear_model import Ridge
from sklearn.preprocessing import StandardScaler
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
def calc_ann_vol(r):
    return np.std(r) * np.sqrt(bars_per_year)
def calc_max_dd(r):
    cum = (1 + pd.Series(r)).cumprod()
    return ((cum - cum.cummax()) / cum.cummax()).min()

def fcst_quality(fc, actual):
    mse = np.mean((fc - actual) ** 2)
    mae = np.mean(np.abs(fc - actual))
    bias = np.mean(fc - actual)
    return mse, mae, bias

# data
raw = fetch_data(ticker="ES=F", period="59d", interval="5m")
cleaned = clean_missing_ticks(raw)
base = calculate_rolling_rv(cleaned, window=288)
df = generate_features(base).dropna()

feat_cols = [
    'Realized_Volatility','Returns','RV_Lag_1','RV_Lag_3','RV_Lag_6',
    'RV_Rolling_Mean_12','RV_Rolling_Std_12','Returns_Lag_1','Returns_Rolling_Std_12',
    'VIX', 'VIX_Change', 'Hour_sin', 'Hour_cos'
]

split = int(len(df) * 0.8)
train, test = df.iloc[:split], df.iloc[split:]
X_tr, y_tr = train[feat_cols].values, train['Target_RV'].values
X_te, y_te = test[feat_cols].values, test['Target_RV'].values
actual_ret = test['Returns'].shift(-1).fillna(0).values
target_rv = np.median(train['Realized_Volatility'])

print("=" * 88)
print("EXPERIMENT 2A: TRAIN VS TEST RV DISTRIBUTION (regime-shift diagnostic)")
print("=" * 88)
for label, series in [("Train RV", train['Realized_Volatility']),
                      ("Test RV ", test['Realized_Volatility'])]:
    print(f"{label} | mean={series.mean():.6f} | std={series.std():.6f} | "
          f"q25={series.quantile(0.25):.6f} | q50={series.quantile(0.50):.6f} | "
          f"q75={series.quantile(0.75):.6f} | q95={series.quantile(0.95):.6f}")
shift_pct = (test['Realized_Volatility'].mean() / train['Realized_Volatility'].mean() - 1) * 100
print(f"Test mean RV vs Train mean RV: {shift_pct:+.2f}% shift")

# build all forecasts
# 1. Naive persistence: forecast(t+1) = RV(t)
naive_fc = test['Realized_Volatility'].values

# 2. Training-mean baseline: constant forecast = mean(train RV)
tmean_fc = np.full(len(test), train['Realized_Volatility'].mean())

# 3. Ridge regression with same features
scaler = StandardScaler()
X_tr_s = scaler.fit_transform(X_tr)
X_te_s = scaler.transform(X_te)
ridge = Ridge(alpha=1.0, random_state=42)
ridge.fit(X_tr_s, y_tr)
ridge_fc = ridge.predict(X_te_s)

# 4. XGBoost (symmetric MSE, penalty=1)
def sym_obj(yt, yp):
    grad = yp - yt; hess = np.ones_like(yt); return grad, hess
xgb_sym = xgb.XGBRegressor(n_estimators=100, max_depth=3, learning_rate=0.05,
                           objective=sym_obj, n_jobs=-1, random_state=42)
xgb_sym.fit(X_tr, y_tr)
xgb_sym_fc = xgb_sym.predict(X_te)

# 5. XGBoost (asymmetric, original penalty=3)
xgb_asym = xgb.XGBRegressor(n_estimators=100, max_depth=3, learning_rate=0.05,
                            objective=asymmetric_mse_objective, n_jobs=-1, random_state=42)
xgb_asym.fit(X_tr, y_tr)
xgb_asym_fc = xgb_asym.predict(X_te)

# 6. GARCH
train_ret_scaled = 100.0 * train['Returns']
garch = arch_model(train_ret_scaled, vol='Garch', p=1, q=1, mean='Zero', rescale=False).fit(disp='off')
full_ret_scaled = 100.0 * df['Returns']
fixed = arch_model(full_ret_scaled, vol='Garch', p=1, q=1, mean='Zero', rescale=False).fix(garch.params)
garch_fc = ((fixed.conditional_volatility.values / 100.0) * np.sqrt(288))[split:]

models = [
    ("Naive Persistence", naive_fc),
    ("Train-Mean Constant", tmean_fc),
    ("Ridge Regression", ridge_fc),
    ("XGBoost (symmetric)", xgb_sym_fc),
    ("XGBoost (asym, p=3)", xgb_asym_fc),
    ("GARCH(1,1)", garch_fc),
]

print()
print("=" * 88)
print("EXPERIMENT 2B: FORECAST QUALITY (MSE, MAE, bias)")
print("=" * 88)
print(f"{'Model':<22} | {'MSE':>12} | {'MAE':>10} | {'Mean Bias':>11} | {'Mean Fcst':>10}")
print("-" * 88)
mask = ~np.isnan(y_te)
for name, fc in models:
    mse, mae, bias = fcst_quality(fc[mask], y_te[mask])
    print(f"{name:<22} | {mse:>12.8f} | {mae:>10.6f} | {bias:>+11.6f} | {np.mean(fc):>10.6f}")

print()
print("=" * 88)
print("EXPERIMENT 2C: STRATEGY PERFORMANCE (vol-target overlay applied to each forecast)")
print("=" * 88)
print(f"{'Model':<22} | {'Sharpe':>8} | {'Ann.Ret':>9} | {'Ann.Vol':>9} | {'Max DD':>8}")
print("-" * 88)
for name, fc in models:
    w = np.clip(target_rv / np.maximum(fc, 1e-6), 0.1, 2.0)
    r = w * actual_ret
    print(f"{name:<22} | {calc_sharpe(r):>8.4f} | {calc_ann_ret(r):>8.2%} | "
          f"{calc_ann_vol(r):>8.2%} | {calc_max_dd(r):>7.2%}")

# Buy & hold for context
bnh = actual_ret
print(f"{'Buy & Hold':<22} | {calc_sharpe(bnh):>8.4f} | {calc_ann_ret(bnh):>8.2%} | "
      f"{calc_ann_vol(bnh):>8.2%} | {calc_max_dd(bnh):>7.2%}")

print()
print("=" * 88)
print("EXPERIMENT 2D: XGBOOST FEATURE IMPORTANCE (symmetric model)")
print("=" * 88)
importance = xgb_sym.feature_importances_
for name, imp in sorted(zip(feat_cols, importance), key=lambda x: -x[1]):
    bar = "#" * int(imp * 100)
    print(f"  {name:<28} {imp:>7.4f}  {bar}")
print("=" * 88)
