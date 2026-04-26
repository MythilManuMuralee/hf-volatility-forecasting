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
    
    # Calculate percentage returns for GARCH stability (arch_model prefers non-tiny values)
    returns = 100 * np.log(final_data['Close'] / final_data['Close'].shift(1)).dropna()
    
    # Align final_data index with returns index
    final_data = final_data.loc[returns.index]
    target_rv = final_data['Realized_Volatility']
    
    # =========================================================================
    # LOOK-AHEAD BIAS PREVENTION:
    # 1. Strict chronological split (no shuffling).
    # 2. Parameters (alpha, beta, omega) are estimated exclusively on the TRUE 
    #    past data (train_returns).
    # 3. Forecasts at time `t` strictly use observations up to `t`, yielding
    #    variance expectations for `t+1`.
    # =========================================================================
    split_idx = int(len(returns) * 0.8)
    train_returns = returns.iloc[:split_idx]
    
    # Notice we don't pass test target info into the model anywhere.
    print(f"Dataset split: {len(train_returns)} Train / {len(returns) - split_idx} Test")
    
    print("Fitting GARCH(1,1) model purely on training set to prevent data leakage...")
    model = arch_model(train_returns, vol='Garch', p=1, q=1, mean='Zero')
    fitted_model = model.fit(disp='off')
    
    print("\nFitted Parameters:")
    print(fitted_model.params)
    
    print("\nGenerating isolated one-step-ahead forecasts...")
    # We populate a new full timeline model, but manually freeze parameters to train-only estimates 
    full_model_eval = arch_model(returns, vol='Garch', p=1, q=1, mean='Zero')
    fixed_res = full_model_eval.fix(fitted_model.params)
    
    # align='origin': the forecast index corresponds to the observation time 't'
    # 'h.1' provides the 1-step-ahead forecast for 't+1'
    forecasts = fixed_res.forecast(horizon=1, align='origin')
    
    # Extract test-period predictions and revert scaling
    test_variance_preds = forecasts.variance['h.1'].iloc[split_idx:] / 10000.0
    
    # Rescale conditional 1-period variance to match our rolling 288-period realized variance framework
    # Assuming variance scales linearly across our local window:
    test_volatility_preds = np.sqrt(test_variance_preds * window_size)
    
    # =========================================================================
    # ALIGNMENT FOR PREVENTING LOOK-AHEAD:
    # `test_volatility_preds` at index `t` is what the model expects for `t+1`.
    # We explicitly shift the *predictions* forward by 1 step in timeline, so 
    # when we align with actual Realized Volatility indices, a row at `t+1` 
    # pits actual `t+1` RV vs the forecast that was formed back at `t`.
    # =========================================================================
    aligned_y_pred = test_volatility_preds.shift(1)
    
    comparison_df = pd.DataFrame({
        'Realized_Vol_Actual': target_rv.iloc[split_idx:],
        'Predicted_Vol': aligned_y_pred
    }).dropna()
    
    y_true = comparison_df['Realized_Vol_Actual']
    y_pred = comparison_df['Predicted_Vol']
    
    # Evaluate
    mse = mean_squared_error(y_true, y_pred)
    mae = mean_absolute_error(y_true, y_pred)
    
    print("\n--- Out-of-Sample Baseline GARCH(1,1) Evaluation ---")
    print(f"Mean Squared Error (MSE): {mse:.6f}")
    print(f"Mean Absolute Error (MAE): {mae:.6f}")

if __name__ == "__main__":
    run_garch_baseline()
