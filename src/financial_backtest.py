import sys
import os
import warnings
import numpy as np
import pandas as pd
import xgboost as xgb
from arch import arch_model
import matplotlib.pyplot as plt

warnings.filterwarnings("ignore")

# Import from data pipeline
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from data_pipeline import fetch_data, clean_missing_ticks, calculate_rolling_rv
from xgboost_model import generate_features, asymmetric_mse_objective

def calculate_drawdown(returns):
    """Calculates Maximum Drawdown given a series of returns."""
    cumulative_returns = (1 + returns).cumprod()
    running_max = cumulative_returns.cummax()
    drawdowns = (cumulative_returns - running_max) / running_max
    return drawdowns.min()

def calculate_metrics(returns_series, strategy_name):
    """
    Calculates Annualised Return, Sharpe Ratio, and Max Drawdown.
    Assuming 252 trading days/year and 288 5-minute bars/day -> 72576 bars/year.
    """
    bars_per_year = 252 * 288
    
    # Annualized Return
    total_return = (1 + returns_series).prod() - 1
    # Compound annualized growth rate
    n_years = len(returns_series) / bars_per_year
    ann_return = (1 + total_return) ** (1 / n_years) - 1 if n_years > 0 else 0
    
    # Sharpe Ratio (zero risk-free rate)
    mean_return = returns_series.mean()
    std_return = returns_series.std()
    # Annualize Sharpe
    sharpe_ratio = (mean_return / std_return) * np.sqrt(bars_per_year) if std_return > 0 else 0
    
    # Max Drawdown
    max_dd = calculate_drawdown(returns_series)
    
    print(f"--- {strategy_name} ---")
    print(f"Annualised Return: {ann_return:.2%}")
    print(f"Sharpe Ratio:      {sharpe_ratio:.4f}")
    print(f"Maximum Drawdown:  {max_dd:.2%}\n")
    
    return ann_return, sharpe_ratio, max_dd

def run_financial_backtest(return_results=False):
    print("Fetching and preparing data...")
    # Using 59d to avoid yfinance limitation
    raw_data = fetch_data(ticker="ES=F", period="59d", interval="5m")
    cleaned_data = clean_missing_ticks(raw_data)
    base_data = calculate_rolling_rv(cleaned_data, window=288)
    
    # Generate XGBoost features
    feature_df = generate_features(base_data).dropna()
    
    feature_cols = [
        'Realized_Volatility', 'Returns', 
        'RV_Lag_1', 'RV_Lag_3', 'RV_Lag_6', 
        'RV_Rolling_Mean_12', 'RV_Rolling_Std_12',
        'Returns_Lag_1', 'Returns_Rolling_Std_12'
    ]
    
    # Data length and split logic
    split_idx = int(len(feature_df) * 0.8)
    train_df = feature_df.iloc[:split_idx]
    test_df = feature_df.iloc[split_idx:]
    
    X_train = train_df[feature_cols].values
    y_train = train_df['Target_RV'].values
    X_test = test_df[feature_cols].values
    
    # Returns aligned with Target_RV (which is t+1)
    # Target_RV is Realized_Volatility.shift(-1)
    # The actual return realized at t+1 is Returns.shift(-1)
    # We will use the model's prediction at t to position for t+1.
    actual_returns_test = test_df['Returns'].shift(-1).fillna(0).values
    
    print("\nTraining XGBoost Model...")
    xgb_model = xgb.XGBRegressor(
        n_estimators=100, max_depth=3, learning_rate=0.05, 
        objective=asymmetric_mse_objective, n_jobs=-1, random_state=42
    )
    xgb_model.fit(X_train, y_train)
    
    # Predict Volatility for test set
    xgb_forecasts = xgb_model.predict(X_test)
    
    print("Training GARCH(1,1) Baseline...")
    # GARCH is trained on the same training window. We use the Returns from train_df.
    # Note: arch expects scaled returns to converge well
    train_returns_scaled = 100.0 * train_df['Returns']
    garch_model = arch_model(train_returns_scaled, vol='Garch', p=1, q=1, mean='Zero', rescale=False)
    fitted_garch = garch_model.fit(disp='off')
    
    # Generate forecasts for test set using fixed parameters
    test_returns_scaled = 100.0 * test_df['Returns']
    # Full dataset needed for fix() to generate continuous conditional volatility
    full_returns_scaled = 100.0 * feature_df['Returns']
    full_garch_eval = arch_model(full_returns_scaled, vol='Garch', p=1, q=1, mean='Zero', rescale=False)
    fixed_res = full_garch_eval.fix(fitted_garch.params)
    
    # Get GARCH volatility for the test set period
    cond_vol_scaled = fixed_res.conditional_volatility.values
    # Convert per-bar sigma to rolling-RV-equivalent: sigma_t * sqrt(288) / 100
    garch_forecasts_full = (cond_vol_scaled / 100.0) * np.sqrt(288)
    garch_forecasts = garch_forecasts_full[split_idx:]
    
    # ==========================================
    # STRATEGY DESIGN: Volatility Targeting
    # ==========================================
    # Target anchor: Median training-period RV
    target_rv = np.median(train_df['Realized_Volatility'])
    
    # Calculate weights. Clip between 0.1 and 2.0 to avoid extreme leverage.
    # weight_t = clip(target_rv / forecast_rv_t, 0.1, 2.0)
    
    # 1. XGBoost Vol-Scale Strategy
    xgb_weights = np.clip(target_rv / np.maximum(xgb_forecasts, 1e-6), 0.1, 2.0)
    xgb_strategy_returns = xgb_weights * actual_returns_test
    
    # 2. GARCH(1,1) Vol-Scale Strategy
    garch_weights = np.clip(target_rv / np.maximum(garch_forecasts, 1e-6), 0.1, 2.0)
    garch_strategy_returns = garch_weights * actual_returns_test
    
    # 3. Buy & Hold Strategy
    # Weight = 1.0 throughout
    bnh_strategy_returns = actual_returns_test
    
    print("\n=============================================")
    print("FINANCIAL VALIDATION: STRATEGY BACKTEST RESULTS")
    print("=============================================\n")
    
    calculate_metrics(pd.Series(bnh_strategy_returns), "Buy & Hold Baseline")
    calculate_metrics(pd.Series(garch_strategy_returns), "GARCH(1,1) Baseline")
    calculate_metrics(pd.Series(xgb_strategy_returns), "XGBoost Vol-Scale Strategy")

    print("\nGenerating equity curves chart...")
    # Plotting
    bnh_cum = (1 + pd.Series(bnh_strategy_returns)).cumprod()
    garch_cum = (1 + pd.Series(garch_strategy_returns)).cumprod()
    xgb_cum = (1 + pd.Series(xgb_strategy_returns)).cumprod()
    
    plt.figure(figsize=(12, 7))
    # Using index for x-axis. For a real timeline, we would use test_df.index
    plt.plot(test_df.index, bnh_cum, label='Buy & Hold Baseline', color='gray', alpha=0.7)
    plt.plot(test_df.index, xgb_cum, label='XGBoost Vol-Scale', color='blue', linewidth=2)
    plt.plot(test_df.index, garch_cum, label='GARCH(1,1) Vol-Scale', color='orange', alpha=0.8)
    
    plt.title("Out-of-Sample Cumulative Returns: Volatility Scaling Strategies", fontsize=14)
    plt.xlabel("Date", fontsize=12)
    plt.ylabel("Cumulative Return Multiplier", fontsize=12)
    plt.legend(loc="upper left")
    plt.grid(True, alpha=0.3)
    
    # Save the plot
    plot_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "equity_curves.png")
    plt.savefig(plot_path, dpi=300, bbox_inches='tight')
    print(f"Equity curve plot saved successfully to: {plot_path}")

    if return_results:
        results_df = pd.DataFrame({
            'Actual_RV': test_df['Target_RV'].values,
            'BnH_Returns': bnh_strategy_returns,
            'GARCH_Returns': garch_strategy_returns,
            'XGB_Returns': xgb_strategy_returns
        }, index=test_df.index)
        return results_df

if __name__ == '__main__':
    run_financial_backtest()
