import yfinance as yf
import pandas as pd
import numpy as np

def fetch_data(ticker="ES=F", period="7d", interval="5m"):
    """
    Fetches 5-minute OHLCV data for the specified ticker.
    Using yfinance as a temporary placeholder.
    """
    print(f"Fetching {interval} data for {ticker} over {period}...")
    data = yf.download(tickers=ticker, period=period, interval=interval, progress=False)
    
    # Handle pandas MultiIndex columns which yfinance sometimes returns
    if isinstance(data.columns, pd.MultiIndex):
        data.columns = data.columns.get_level_values(0)
        
    return data

def clean_missing_ticks(df):
    """
    Cleans missing ticks in high-frequency data.
    Forward-fills missing values to maintain the last known price.
    Drops any initial rows with NaNs.
    """
    print("Cleaning missing ticks...")
    # A robust basic approach for non-regularly spaced timestamps 
    # is to forward-fill gaps. For true high-frequency data, we might
    # also resample to a strict time grid.
    clean_df = df.ffill()
    clean_df = clean_df.dropna()
    return clean_df

def calculate_rolling_rv(df, window=288):
    """
    Calculates the rolling realized volatility.
    
    Args:
        df: DataFrame containing a 'Close' price column.
        window: Integer for rolling window size. 
                288 periods of 5-minutes corresponds to roughly 24 hours.
                
    Returns:
        DataFrame with an additional 'Realized_Volatility' column.
    """
    print(f"Calculating rolling realized volatility with window={window}...")
    
    if 'Close' not in df.columns:
        raise ValueError("DataFrame must contain a 'Close' column.")
        
    # Calculate log returns
    log_returns = np.log(df['Close'] / df['Close'].shift(1))
    
    # Calculate rolling realized variance (sum of squared returns)
    rolling_var = log_returns.pow(2).rolling(window=window).sum()
    
    # Realized volatility is the square root of realized variance
    df['Realized_Volatility'] = np.sqrt(rolling_var)
    
    return df

if __name__ == "__main__":
    ticker = "ES=F"
    
    # 1. Fetch
    raw_data = fetch_data(ticker=ticker, period="7d", interval="5m")
    
    # 2. Clean
    cleaned_data = clean_missing_ticks(raw_data)
    
    # 3. Calculate RV
    final_data = calculate_rolling_rv(cleaned_data, window=288)
    
    print("\nSample of calculated volatility data:")
    print(final_data[['Close', 'Realized_Volatility']].tail(10))
    print("\nData processing pipeline completed successfully.")
