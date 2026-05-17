import os
import sys
import numpy as np
import pandas as pd
import warnings
warnings.filterwarnings("ignore")

from data_pipeline import fetch_data, clean_missing_ticks, calculate_rolling_rv
from xgboost_model import generate_features
from financial_backtest import run_financial_backtest

bars_per_year = 252 * 288

def calc_sharpe(returns):
    std = np.std(returns)
    if std == 0: return 0
    return (np.mean(returns) / std) * np.sqrt(bars_per_year)

def calc_ann_vol(returns):
    return np.std(returns) * np.sqrt(bars_per_year)

def calc_max_dd(returns):
    cum = (1 + pd.Series(returns)).cumprod()
    running_max = cum.cummax()
    dd = (cum - running_max) / running_max
    return dd.min()

def calc_ann_ret(returns):
    return (1 + np.mean(returns)) ** bars_per_year - 1

def block_bootstrap(returns_A, returns_B, block_size=288, n_bootstraps=1000):
    n = len(returns_A)
    diffs = []
    
    returns_A = np.array(returns_A)
    returns_B = np.array(returns_B)
    np.random.seed(42)
    for _ in range(n_bootstraps):
        num_blocks = int(np.ceil(n / block_size))
        start_indices = np.random.randint(0, n - block_size + 1, num_blocks)
        
        boot_A = []
        boot_B = []
        for idx in start_indices:
            boot_A.extend(returns_A[idx:idx+block_size])
            boot_B.extend(returns_B[idx:idx+block_size])
            
        boot_A = np.array(boot_A[:n])
        boot_B = np.array(boot_B[:n])
        
        diffs.append(calc_sharpe(boot_A) - calc_sharpe(boot_B))
        
    return np.percentile(diffs, [2.5, 97.5])

def run_audit():
    print("STEP 1: Load and inspect...")
    raw_data = fetch_data(ticker="ES=F", period="59d", interval="5m")
    
    start_date = raw_data.index.min()
    end_date = raw_data.index.max()
    print(f"Date Range: {start_date} to {end_date}")
    
    cleaned_data = clean_missing_ticks(raw_data)
    base_data = calculate_rolling_rv(cleaned_data, window=288)
    feature_df = generate_features(base_data).dropna()
    total_bars = len(feature_df)
    print(f"Total Bars (after cleaning/feature gen): {total_bars}")
    
    split_idx = int(total_bars * 0.8)
    test_bars = total_bars - split_idx
    print(f"Train/Test split: 80/20")
    print(f"Test Set Bars: {test_bars}")

    print("\nSTEP 2 & 3: Run pipeline and extract results...")
    df = run_financial_backtest(return_results=True)
    
    # Check if df length matches test_bars, it should
    assert len(df) == test_bars
    
    def get_full_stats(returns):
        return {
            'Ann_Ret': calc_ann_ret(returns),
            'Ann_Vol': calc_ann_vol(returns),
            'Sharpe': calc_sharpe(returns),
            'Max_DD': calc_max_dd(returns)
        }
    
    stats_full = {
        'BnH': get_full_stats(df['BnH_Returns']),
        'GARCH': get_full_stats(df['GARCH_Returns']),
        'XGB': get_full_stats(df['XGB_Returns']),
        'Hybrid': get_full_stats(df['Hybrid_Returns'])
    }
    
    threshold = df['Actual_RV'].quantile(0.80)
    high_vol_df = df[df['Actual_RV'] >= threshold]
    high_vol_bars = len(high_vol_df)
    
    def get_sub_stats(returns):
        return {
            'Ann_Ret': calc_ann_ret(returns),
            'Sharpe': calc_sharpe(returns)
        }
    
    stats_sub = {
        'BnH': get_sub_stats(high_vol_df['BnH_Returns']),
        'GARCH': get_sub_stats(high_vol_df['GARCH_Returns']),
        'XGB': get_sub_stats(high_vol_df['XGB_Returns']),
        'Hybrid': get_sub_stats(high_vol_df['Hybrid_Returns'])
    }
    
    print("\nSTEP 4: Bootstrap...")
    ci = block_bootstrap(df['XGB_Returns'], df['GARCH_Returns'])
    actual_diff = calc_sharpe(df['XGB_Returns']) - calc_sharpe(df['GARCH_Returns'])
    sig = "Yes" if ci[0] > 0 else "No"
    
    print("\nGenerating Output Table...")
    
    print(f"| Metric | Full Test Window | High-Vol Subsample (Top 20%) |")
    print(f"|--------|------------------|------------------------------|")
    print(f"| **Buy & Hold** | | |")
    print(f"| - Sharpe | {stats_full['BnH']['Sharpe']:.4f} | {stats_sub['BnH']['Sharpe']:.4f} |")
    print(f"| - Ann. Return | {stats_full['BnH']['Ann_Ret']:.2%} | {stats_sub['BnH']['Ann_Ret']:.2%} |")
    print(f"| - Ann. Volatility | {stats_full['BnH']['Ann_Vol']:.2%} | N/A |")
    print(f"| - Max DD | {stats_full['BnH']['Max_DD']:.2%} | N/A |")
    
    print(f"| **GARCH Vol-Target** | | |")
    print(f"| - Sharpe | {stats_full['GARCH']['Sharpe']:.4f} | {stats_sub['GARCH']['Sharpe']:.4f} |")
    print(f"| - Ann. Return | {stats_full['GARCH']['Ann_Ret']:.2%} | {stats_sub['GARCH']['Ann_Ret']:.2%} |")
    print(f"| - Ann. Volatility | {stats_full['GARCH']['Ann_Vol']:.2%} | N/A |")
    print(f"| - Max DD | {stats_full['GARCH']['Max_DD']:.2%} | N/A |")
    
    print(f"| **XGBoost Vol-Target** | | |")
    print(f"| - Sharpe | {stats_full['XGB']['Sharpe']:.4f} | {stats_sub['XGB']['Sharpe']:.4f} |")
    print(f"| - Ann. Return | {stats_full['XGB']['Ann_Ret']:.2%} | {stats_sub['XGB']['Ann_Ret']:.2%} |")
    print(f"| - Ann. Volatility | {stats_full['XGB']['Ann_Vol']:.2%} | N/A |")
    print(f"| - Max DD | {stats_full['XGB']['Max_DD']:.2%} | N/A |")
    
    print(f"| **Hybrid GARCH-XGBoost** | | |")
    print(f"| - Sharpe | {stats_full['Hybrid']['Sharpe']:.4f} | {stats_sub['Hybrid']['Sharpe']:.4f} |")
    print(f"| - Ann. Return | {stats_full['Hybrid']['Ann_Ret']:.2%} | {stats_sub['Hybrid']['Ann_Ret']:.2%} |")
    print(f"| - Ann. Volatility | {stats_full['Hybrid']['Ann_Vol']:.2%} | N/A |")
    print(f"| - Max DD | {stats_full['Hybrid']['Max_DD']:.2%} | N/A |")
    
    print(f"| **Test Bars** | {test_bars} | {high_vol_bars} |")
    
    print("\n**Statistical Significance Check:**")
    print(f"- XGBoost vs GARCH Sharpe Spread (full window): {actual_diff:.4f}")
    print(f"- Bootstrap 95% CI: [{ci[0]:.4f}, {ci[1]:.4f}]")
    print(f"- Statistically significant? {sig}")

if __name__ == '__main__':
    run_audit()
