"""
baseline_garch.py

This script implements a GARCH(1,1) baseline model to forecast high-frequency volatility.
It includes explicit preventative measures against look-ahead bias through strict
train-testing separation and carefully aligned one-step-ahead forecasts.
"""

import sys
import os
import warnings
import numpy as np
import pandas as pd
from arch import arch_model
from sklearn.metrics import mean_squared_error, mean_absolute_error

# Suppress warnings for clean output
warnings.filterwarnings("ignore", category=FutureWarning)

# Ensure we can import from data_pipeline
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from data_pipeline import fetch_data, clean_missing_ticks, calculate_rolling_rv

def run_garch_baseline():
    print("Initializing Data Pipeline...")
    # 1. Load Data
    # Extending period slightly to ensure we have enough data post-rolling window
    raw_data = fetch_data(ticker="ES=F", period="1mo", interval="5m")
    cleaned_data = clean_missing_ticks(raw_data)
    
    # Daily RV proxy using 5min data
    window_size = 288
    final_data = calculate_rolling_rv(cleaned_data, window=window_size)
    
    # Drop rows where RV is NaN (due to rolling window warm-up)
    final_data = final_data.dropna(subset=['Realized_Volatility'])
    
    # Calculate log returns, then scale by 100 to help the GARCH optimizer 
    # converge (arch expects returns on the order of ~1, not ~0.001).
    raw_log_returns = np.log(final_data['Close'] / final_data['Close'].shift(1)).dropna()
    returns_scaled = 100.0 * raw_log_returns
    
    # Align final_data index with returns index
    final_data = final_data.loc[returns_scaled.index]
    target_rv = final_data['Realized_Volatility'].values  # numpy for safe positional access
    
    # =========================================================================
    # LOOK-AHEAD BIAS PREVENTION:
    # 1. Strict chronological split (no shuffling).
    # 2. Parameters (alpha, beta, omega) are estimated exclusively on the TRUE 
    #    past data (train_returns).
    # 3. Forecasts at time `t` strictly use observations up to `t`, yielding
    #    variance expectations for `t+1`.
    # =========================================================================
    split_idx = int(len(returns_scaled) * 0.8)
    train_returns = returns_scaled.iloc[:split_idx]
    
    # Notice we don't pass test target info into the model anywhere.
    print(f"Dataset split: {len(train_returns)} Train / {len(returns_scaled) - split_idx} Test")
    
    print("Fitting GARCH(1,1) model purely on training set to prevent data leakage...")
    model = arch_model(train_returns, vol='Garch', p=1, q=1, mean='Zero', rescale=False)
    fitted_model = model.fit(disp='off')
    
    print("\nFitted Parameters:")
    print(fitted_model.params)
    
    print("\nGenerating one-step-ahead conditional volatility forecasts...")
    # =========================================================================
    # FORECASTING STRATEGY:
    # fix() applies the train-only parameters (omega, alpha, beta) across the
    # full return series. The GARCH recursion is inherently causal:
    #     σ²_t = omega + alpha * r²_{t-1} + beta * σ²_{t-1}
    # so σ_t only depends on past returns and past variance — no future data.
    #
    # conditional_volatility gives σ_t at every timestamp. To get a true 
    # one-step-ahead forecast, we compare σ_t (formed from data up to t-1)
    # against realized volatility at time t.
    # =========================================================================
    full_model_eval = arch_model(returns_scaled, vol='Garch', p=1, q=1, mean='Zero', rescale=False)
    fixed_res = full_model_eval.fix(fitted_model.params)
    
    # conditional_volatility[t] = σ_t, computed from r_{t-1}, σ_{t-1} (causal).
    # This is already a one-step-ahead quantity: the model's expectation of 
    # volatility at t, formed using information strictly up to t-1.
    cond_vol_scaled = fixed_res.conditional_volatility
    
    # Descale: cond_vol is in "returns * 100" units. Divide by 100 to get raw 
    # return volatility, then multiply by sqrt(window_size) to match the rolling 
    # realized volatility scale (sum-of-squares over 288 periods).
    cond_vol = (cond_vol_scaled / 100.0) * np.sqrt(window_size)
    cond_vol_arr = cond_vol.values
    
    # =========================================================================
    # ALIGNMENT (positional numpy arrays, zero look-ahead):
    # cond_vol_arr[t] is the model's volatility estimate for period t, formed
    # from data up to t-1. We compare it directly against target_rv[t].
    # For the test period (indices split_idx onward):
    # =========================================================================
    y_pred = cond_vol_arr[split_idx:]
    y_true = target_rv[split_idx:]
    
    # Remove any NaN entries defensively
    mask = ~(np.isnan(y_pred) | np.isnan(y_true))
    y_pred = y_pred[mask]
    y_true = y_true[mask]
    
    # Evaluate
    mse = mean_squared_error(y_true, y_pred)
    mae = mean_absolute_error(y_true, y_pred)
    
    print(f"\nTest samples evaluated: {len(y_true)}")
    print("\n--- Out-of-Sample Baseline GARCH(1,1) Evaluation ---")
    print(f"Mean Squared Error (MSE): {mse:.6f}")
    print(f"Mean Absolute Error (MAE): {mae:.6f}")

if __name__ == "__main__":
    run_garch_baseline()
