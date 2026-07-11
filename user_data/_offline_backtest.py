# One-off offline launcher: this sandbox blocks all exchange APIs, but
# freqtrade always loads markets from the exchange - even for backtesting.
# This shim injects static kraken market metadata for BTC/USDT and ETH/USDT
# so backtesting can run purely from on-disk candle data.
#
# Usage:
#   python3 _offline_backtest.py backtesting --config ... --strategy MythilVol ...
import sys

from freqtrade.exchange.exchange import Exchange


def _spot_market(base: str, quote: str, mid: str, price_tick: float, amount_min: float):
    return {
        "id": mid,
        "symbol": f"{base}/{quote}",
        "base": base,
        "quote": quote,
        "baseId": base,
        "quoteId": quote,
        "type": "spot",
        "spot": True,
        "margin": False,
        "swap": False,
        "future": False,
        "option": False,
        "contract": False,
        "active": True,
        "linear": None,
        "inverse": None,
        "contractSize": None,
        "expiry": None,
        "strike": None,
        "settle": None,
        "settleId": None,
        "taker": 0.0026,
        "maker": 0.0016,
        "percentage": True,
        "tierBased": True,
        "precision": {"amount": 1e-8, "price": price_tick},
        "limits": {
            "amount": {"min": amount_min, "max": None},
            "price": {"min": price_tick, "max": None},
            "cost": {"min": 0.5, "max": None},
            "leverage": {"min": None, "max": None},
        },
        "info": {},
    }


MARKETS = [
    _spot_market("BTC", "USDT", "XBTUSDT", 0.1, 1e-4),
    _spot_market("ETH", "USDT", "ETHUSDT", 0.01, 1e-3),
]

CURRENCIES = {
    code: {"id": code, "code": code, "active": True, "precision": 1e-8, "info": {}}
    for code in ("BTC", "ETH", "USDT")
}


async def _offline_reload_markets(self, reload: bool = False) -> None:
    self._api_async.set_markets(MARKETS, CURRENCIES)


Exchange._api_reload_markets = _offline_reload_markets
Exchange.fetch_trading_fees = lambda self: {}


if __name__ == "__main__":
    from freqtrade.main import main

    main(sys.argv[1:])
