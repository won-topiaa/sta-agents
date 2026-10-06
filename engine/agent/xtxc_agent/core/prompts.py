"""The only four places the language model is used, each with a code validator.

1. brief_compile   : Korean sentence -> investment conditions draft (thinking off)
2. report_explain  : metric ids -> 2~3 plain Korean sentences with {placeholders}
3. counter_opinion : spec + checks -> "when this strategy loses" bullets with {placeholders}
4. answer_question : user question about their own records -> answer grounded in given facts

Numbers shown to users never come from the model: explanation flows must not
contain digits outside {placeholders}; code fills the placeholders from the
computed metrics. A model answer that sneaks in a number is rejected.
"""

from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation

from . import i18n

TEMPLATES = ("momentum", "low_vol", "equal_weight", "ai")      # ai: the AI designs a new strategy (strategy_design)
REBALANCE = ("weekly", "monthly")

# ------------------------------------------------------------------ 1. brief
BRIEF_SYSTEM = (
    "You turn a retail investor's request (in any language) into investment conditions for a long-only US stock strategy "
    "traded as tokenized stocks. Reply with ONE JSON object only, keys exactly: "
    "budget_krw (integer won or null), budget_usd (integer US dollars or null; use this when the user states dollars, "
    "USD, USDC or 美元), sectors (array of sector ids from the list), tickers (array of tickers from the list), "
    "exclude (array of tickers the user excluded), max_weight (decimal string 0.05..1 or null), "
    "min_cash (decimal string 0..0.9 or null), rebalance (\"weekly\"|\"monthly\"|null), "
    "template (\"momentum\"|\"low_vol\"|\"equal_weight\"|\"ai\"|null; \"ai\" only when the user asks the assistant or AI to "
    "design, invent or come up with the strategy itself), exclude_leveraged (true|false|null), "
    "questions (array of short questions in {language} for information that is truly missing, max 2). "
    "Use null for anything the user did not state. Never invent tickers outside the list. "
    "When the user names particular companies, put exactly those in tickers and leave sectors empty, unless the user "
    "also asks for a whole sector. "
    "Percentages become decimals (25% -> \"0.25\"). 만원/억 units become integer won; set at most one of budget_krw and budget_usd. "
    "One more key, forecast: null, EXCEPT when the user asks how much particular stocks may rise and fall, swing, or what "
    "their risk or price range could be over some period, instead of describing an investment to make. Then forecast is "
    "{{\"tickers\": [tickers from the list], \"horizon\": \"<n><unit>\" or null}} (unit h hours, d trading days, w weeks, "
    "m months, y years; e.g. a year -> \"1y\", two weeks -> \"2w\", an hour -> \"1h\"; null when no period was stated) and "
    "every other key is null or an empty array."
)


def brief_messages(text: str, universe_index: dict[str, list[str]], names: dict[str, str] | None = None) -> list[dict]:
    # "TICKER=Short name" so company names in any language map to the right ticker (e.g. Circle -> CRCL)
    names = names or {}
    compact = "; ".join(f"{sector}: {' '.join(f'{t}={names[t]}' if names.get(t) and names[t] != t else t for t in tickers)}"
                        for sector, tickers in sorted(universe_index.items()))
    return [
        {"role": "system", "content": BRIEF_SYSTEM.format(language=i18n.LANG_NAME[i18n.lang()]) + " Sector ids and tickers: " + compact},
        {"role": "user", "content": text},
    ]


def _decimal(value, lo: Decimal, hi: Decimal, name: str) -> str | None:
    if value is None:
        return None
    try:
        d = Decimal(str(value))
    except InvalidOperation as exc:
        raise ValueError(f"{name} is not a decimal") from exc
    if not (lo <= d <= hi):
        raise ValueError(f"{name} out of range")
    return format(d.normalize(), "f")


def validate_brief(answer, universe_tickers: set[str], sectors: set[str]) -> dict:
    keys = {"budget_krw", "budget_usd", "sectors", "tickers", "exclude", "max_weight", "min_cash", "rebalance", "template", "exclude_leveraged",
            "questions", "forecast"}
    if isinstance(answer, dict):
        # one budget is enough: a missing budget_krw or budget_usd means "not stated" (older cached answers lack budget_usd);
        # a missing forecast means "not a forecast question" (edits and older answers)
        answer = {"budget_krw": None, "budget_usd": None, "forecast": None, **answer}
    if not isinstance(answer, dict) or set(answer) != keys:
        raise ValueError(f"keys must be exactly {sorted(keys)}")
    if answer["forecast"] is not None:
        return {"forecast": validate_forecast_request(answer["forecast"], universe_tickers)}
    usd = answer["budget_usd"]
    if usd is not None and (not isinstance(usd, int) or not 10 <= usd <= 10_000_000):
        raise ValueError("budget_usd must be an integer between 10 and 10,000,000 or null")
    if usd is not None and answer["budget_krw"] is not None:
        raise ValueError("set only one of budget_krw and budget_usd")
    if usd is not None:                                   # code converts dollars to the internal won budget
        answer = {**answer, "budget_krw": int(Decimal(usd) * Decimal(i18n.DEFAULT_FX))}
    budget = answer["budget_krw"]
    if budget is not None and (not isinstance(budget, int) or not 10_000 <= budget <= 10_000_000_000):
        raise ValueError("budget_krw must be an integer between 10,000 and 10,000,000,000 or null")
    for name in ("sectors", "tickers", "exclude", "questions"):
        if not isinstance(answer[name], list) or not all(isinstance(x, str) for x in answer[name]):
            raise ValueError(f"{name} must be an array of strings")
    unknown = [s for s in answer["sectors"] if s not in sectors]
    if unknown:
        raise ValueError(f"unknown sectors {unknown}")
    bad = [t for t in answer["tickers"] + answer["exclude"] if t not in universe_tickers]
    if bad:
        raise ValueError(f"tickers not tradable on XTXC: {bad}")
    if answer["rebalance"] not in (None, *REBALANCE):
        raise ValueError("rebalance must be weekly, monthly or null")
    if answer["template"] not in (None, *TEMPLATES):
        raise ValueError("template must be momentum, low_vol, equal_weight, ai or null")
    if answer["exclude_leveraged"] not in (None, True, False):
        raise ValueError("exclude_leveraged must be boolean or null")
    if len(answer["questions"]) > 2:
        raise ValueError("at most two questions")
    answer = {k: v for k, v in answer.items() if k != "forecast"}
    return {
        **answer,
        "max_weight": _decimal(answer["max_weight"], Decimal("0.05"), Decimal("1"), "max_weight"),
        "min_cash": _decimal(answer["min_cash"], Decimal("0"), Decimal("0.9"), "min_cash"),
    }


FORECAST_MAX_TICKERS = 5


def validate_forecast_request(fc, universe_tickers: set[str]) -> dict:
    """{"tickers": [...], "horizon": "1y" | None} -- tickers may be empty (the app then asks, or uses the current conditions)."""
    from ..research.volforecast import parse_horizon
    if not isinstance(fc, dict) or set(fc) != {"tickers", "horizon"}:
        raise ValueError('forecast must be {"tickers": [...], "horizon": "..." or null}')
    tickers = fc["tickers"]
    if not isinstance(tickers, list) or not all(isinstance(t, str) for t in tickers):
        raise ValueError("forecast.tickers must be an array of tickers")
    bad = [t for t in tickers if t not in universe_tickers]
    if bad:
        raise ValueError(f"tickers not tradable on XTXC: {bad}")
    if len(set(tickers)) > FORECAST_MAX_TICKERS:
        raise ValueError(f"at most {FORECAST_MAX_TICKERS} tickers")
    horizon = fc["horizon"]
    if horizon is not None:
        if not isinstance(horizon, str):
            raise ValueError("forecast.horizon must be a string like 1y or null")
        horizon = parse_horizon(horizon).code
    return {"tickers": list(dict.fromkeys(tickers)), "horizon": horizon}


# Defaults applied by CODE (not the model) when the user did not say something.
BRIEF_DEFAULTS = {"max_weight": "0.25", "min_cash": "0.10", "rebalance": "monthly", "template": "momentum", "exclude_leveraged": True}


# --------------------------------------------------------- 2/3. explanations
PLACEHOLDER = re.compile(r"\{([a-z_]+)\}")
DIGIT = re.compile(r"[0-9０-９]")

EXPLAIN_SYSTEM = (
    "You write for retail investors on a phone. Write 2 or 3 short plain sentences in {language} explaining a "
    "backtest result. You MUST NOT write any digit. Refer to numbers only through these placeholders, copied exactly: {ids}. "
    "Each placeholder already includes its unit. "
    "Say clearly that it is a past calculation, not a promise. No jargon (no Sharpe, alpha, beta). "
    "Only state causes and comparisons that the facts state; do not invent reasons. "
    "Example of the required style: \"{example}\" "
    "Reply as JSON: {{\"sentences\": [\"...\"]}}."
)
EXPLAIN_EXAMPLE = {"en": "Over {years}, this approach would have returned {total_return_xtxc}.",
                   "ko": "{years} 동안 이 방식이었다면 {total_return_xtxc}였어요.",
                   "zh": "如果过去{years}都用这个方式，结果是{total_return_xtxc}。"}

COUNTER_SYSTEM = (
    "You are the devil's advocate for a retail investor. Given a long-only stock strategy and its checks, list 2 or 3 "
    "concrete situations in which this strategy would lose money or disappoint, in plain {language}, one sentence each. "
    "You MUST NOT write any digit; if you need a number, use only these placeholders copied exactly: {ids}. "
    "Reply as JSON: {{\"risks\": [\"...\"]}}."
)


def explain_messages(facts: dict, placeholders: list[str]) -> list[dict]:
    ids = ", ".join("{" + p + "}" for p in placeholders)
    return [
        {"role": "system", "content": EXPLAIN_SYSTEM.format(ids=ids, language=i18n.LANG_NAME[i18n.lang()], example=EXPLAIN_EXAMPLE[i18n.lang()])},
        {"role": "user", "content": _facts_text(facts)},
    ]


def counter_messages(facts: dict, placeholders: list[str]) -> list[dict]:
    ids = ", ".join("{" + p + "}" for p in placeholders)
    return [
        {"role": "system", "content": COUNTER_SYSTEM.format(ids=ids, language=i18n.LANG_NAME[i18n.lang()])},
        {"role": "user", "content": _facts_text(facts)},
    ]


def _facts_text(facts: dict) -> str:
    # Facts are described qualitatively plus placeholder names; the model sees no raw numbers.
    return "\n".join(f"- {k}: {no_digits(str(v))}" for k, v in facts.items())


def validate_sentences(answer, key: str, allowed: set[str], lo: int, hi: int) -> list[str]:
    if not isinstance(answer, dict) or set(answer) != {key}:
        raise ValueError(f"reply must be {{\"{key}\": [...]}}")
    items = answer[key]
    if not isinstance(items, list) or not lo <= len(items) <= hi or not all(isinstance(s, str) and 4 <= len(s) <= 160 for s in items):
        raise ValueError(f"{key} must hold {lo}..{hi} sentences of 4..160 characters")
    for i, s in enumerate(items, 1):
        unknown = set(PLACEHOLDER.findall(s)) - allowed
        if unknown:
            raise ValueError(f"sentence {i} uses unknown placeholders {sorted(unknown)}; use only the listed ones")
        digits = DIGIT.findall(PLACEHOLDER.sub("", s))
        if digits:
            raise ValueError(f"digits are not allowed outside placeholders: sentence {i} contains {''.join(digits)!r} "
                             f"in \"{s[:80]}\". Rewrite that part with a listed placeholder or plain words without digits")
    return items


def no_digits(text: str) -> str:
    """Facts given to the model carry no digits at all (it would copy them)."""
    return DIGIT.sub("", text.replace("1년", "한 해").replace("1개", "한 개"))


def fill(sentences: list[str], values: dict[str, str]) -> list[str]:
    return [PLACEHOLDER.sub(lambda m: values.get(m.group(1), m.group(0)), s) for s in sentences]


# ------------------------------------------------------------ 4. questions
QA_SYSTEM = (
    "Answer a retail investor's question about THEIR OWN records using only the facts given. "
    "If the facts do not answer it, say you cannot tell from the records. Plain {language}, at most 3 sentences. "
    "Do not write digits; cite values only as the placeholders provided. Reply as JSON: {\"answer\": \"...\"}."
)
