# High-Frequency Volatility Forecasting

## Project Overview
This project develops and evaluates a hybrid GARCH-XGBoost volatility forecasting model to predict high-frequency (5-minute) volatility of E-mini S&P 500 futures (ES=F). The primary objective is to diagnose regime-shift sensitivity and compare the rapid adaptation capabilities of Machine Learning models against parametric baselines during volatility shocks.

## Setup
To set up the environment, install the required dependencies:
```bash
pip install -r requirements.txt
```

## How to Run
- **Full Results Table**: Run `python src/audit_script.py` to execute the complete pipeline and output the main summary statistics table and statistical significance checks.
- **Equity Curves**: Run `python src/financial_backtest.py` to generate the equity curves plot comparing all the strategies.
- **Diagnostic Experiments**:
  - `python src/exp1_penalty_sensitivity.py` - Asymmetric penalty sensitivity analysis.
  - `python src/exp2_baselines_and_regime.py` - Train vs. test regime shift diagnostic and baseline comparisons.
  - `python src/exp3_walk_forward.py` - Expanding-window walk-forward validation.

## Key Results
Sharpe ratios from the latest out-of-sample backtest audit on the full test window:
- **Buy & Hold Baseline**: 6.53
- **GARCH(1,1) Vol-Target**: 6.40
- **XGBoost Vol-Target**: 6.50
- **Hybrid GARCH-XGBoost**: 6.44

## Data Note
This project fetches ES=F tick data dynamically using a 59-day rolling window via `yfinance`. Because the 59-day window rolls forward daily, the exact quantitative results (returns, Sharpe ratios, etc.) will drift and vary slightly from day to day depending on the current active market data.
