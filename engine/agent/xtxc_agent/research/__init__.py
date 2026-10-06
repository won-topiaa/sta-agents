"""XTXC research engine: universe, market data, strategies, backtest, evaluator, execution costs.

See docs/CONTRACT.md section 2 for the public interface.  All modules are deterministic given a
snapshot id; nothing here calls an LLM or the production StockMesh API.
"""
