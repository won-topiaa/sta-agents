import pytest

from xtxc_agent.research import execution_costs as ec


def q(usdc: float, tokens: float, decimals: int = 8, **extra):
    return {"input_atoms": int(round(usdc * 1e6)), "output_atoms": int(round(tokens * 10 ** decimals)),
            "decimals": decimals, "quoted_at": "2026-09-26T01:00:00Z", "source": "test", **extra}


def test_missing_quotes_default_conservative():
    out = ec.token_cost_model(["NVDA", "AMD"], 500_000_000, {})
    assert set(out) == {"NVDA", "AMD"}
    for v in out.values():
        assert v["cost_bps"] == 100.0 and v["premium_bps"] is None and v["source"] == "default-conservative"


def test_premium_from_smallest_and_cost_at_order_size():
    quotes = {"NVDA": [q(10, 0.099), q(1000, 9.8), q(100, 0.985)]}
    out = ec.token_cost_model(["NVDA"], 500_000_000, quotes, underlying_close={"NVDA": 100.0})["NVDA"]
    # smallest: 10 USDC for 0.099 tokens -> 101.0101 per token -> +101.01 bps
    assert out["premium_bps"] == pytest.approx((10 / 0.099 / 100 - 1) * 1e4, abs=0.01)
    # order 500 USDC -> uses the 1000 USDC quote (smallest >= order): 102.0408 -> +204.08 bps
    assert out["cost_bps"] == pytest.approx((1000 / 9.8 / 100 - 1) * 1e4, abs=0.01)
    assert out["source"] == "quote:test"
    assert "ui-multiplier-not-provided" in out["flags"]


def test_order_larger_than_quotes_is_flagged():
    out = ec.token_cost_model(["NVDA"], 5_000_000_000, {"NVDA": q(100, 0.99)}, underlying_close={"NVDA": 100.0})
    assert "order-larger-than-quotes" in out["NVDA"]["flags"]


def test_scaling_mismatch_is_flagged_not_adjusted():
    # token trades ~10x the share (e.g. NFLX after its 10:1 split): do not trust, do not rescale
    out = ec.token_cost_model(["NFLX"], 100_000_000, {"NFLX": q(100, 0.137)},
                              underlying_close={"NFLX": 72.0})["NFLX"]
    assert out["source"] == "default-conservative" and out["cost_bps"] == 100.0
    assert out["premium_bps"] is None
    assert "price-ratio-suspect" in out["flags"]
    assert out["detail"]["scaling_factor_guess"] == "10x"
    assert out["detail"]["ratio_smallest"] == pytest.approx(100 / 0.137 / 72.0, rel=1e-6)


def test_ui_multiplier_is_applied_when_given():
    out = ec.token_cost_model(["NVDA"], 100_000_000, {"NVDA": q(102, 1.0, ui_multiplier="1.02")},
                              underlying_close={"NVDA": 100.0})["NVDA"]
    assert out["premium_bps"] == pytest.approx(0.0, abs=0.01)
    assert "ui-multiplier-not-provided" not in out["flags"]


def test_cost_model_from_and_xtxc_model():
    tc = {"A": {"cost_bps": 38.0}, "B": {"cost_bps": -20.0}, "C": {"cost_bps": 100.0}}
    assert ec.cost_model_from(tc) == {"A": 38.0, "B": 20.0, "C": 100.0}
    assert ec.xtxc_cost_model(tc) == {"default_bps": 100.0, "per_ticker_bps": {"A": 38.0, "B": 20.0, "C": 100.0}}
    with pytest.raises(ValueError):
        ec.token_cost_model(["A"], 0, {})


def test_uses_snapshot_close_by_default(real_snapshot_id):
    from xtxc_agent.research.marketdata import load_prices

    close = float(load_prices(real_snapshot_id, field="close")["NVDA"].dropna().iloc[-1])
    out = ec.token_cost_model(["NVDA"], 100_000_000, {"NVDA": q(close * 1.003, 1.0)}, snapshot_id=real_snapshot_id)
    assert out["NVDA"]["premium_bps"] == pytest.approx(30.0, abs=0.05)
    assert out["NVDA"]["detail"]["snapshot_id"] == real_snapshot_id
