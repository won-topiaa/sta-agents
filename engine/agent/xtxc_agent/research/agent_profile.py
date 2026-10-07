"""A user's own agent: a named investing style whose rules code adds to every strategy the agent designs.

The profile is data the user wrote and confirmed (style, rules from ``agent_rules.json``, risk limits, approval mode).
The model designs strategies *inside* it: code turns each rule into a filter, a market guard or a holdings cap of the
strategy language and merges them into every candidate, so a design that "forgets" a rule cannot reach a backtest.
The profile itself is never sent to the model as authority; its free-text philosophy is quoted as untrusted data.

Profile document (``xtxc.agent-profile/v1``)::

    {"schema": "xtxc.agent-profile/v1", "id": uuid, "revision": 3, "name": "Trend rider",
     "style": "technical", "preset": "trend" | "dip" | "breakout" | "custom",
     "rules": [{"id": "uptrend_only", "params": {"days": 200}}, ...],
     "philosophy": "free text, may be empty",
     "risk": {"maxWeightBps": 2500, "minCashBps": 1000, "maxDrawdownBps": 2000},
     "rebalance": "weekly" | "monthly",
     "approval": "PER_TRADE" | "AUTO_WITHIN_LIMITS"}
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from functools import lru_cache
from pathlib import Path

from .strategy_lang import FUNDAMENTAL_SIGNALS, DesignError, normalize_design

SCHEMA = "xtxc.agent-profile/v1"
RULES_FILE = Path(__file__).resolve().parent / "agent_rules.json"
APPROVALS = ("PER_TRADE", "AUTO_WITHIN_LIMITS")
REBALANCES = ("weekly", "monthly")
_UUID = re.compile(r"^[a-f0-9-]{36}$")
_CONTROL = re.compile(r"[\u0000-\u0008\u000b\u000c\u000e-\u001f‪-‮⁦-⁩]")


class ProfileError(ValueError):
    pass


@lru_cache(maxsize=1)
def catalog() -> dict:
    data = json.loads(RULES_FILE.read_text(encoding="utf-8"))
    if data.get("schema") != "xtxc.agent-rules/v1":
        raise ProfileError("unknown agent rule catalog")
    return data


def _param(spec: dict, value, name: str):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        raise ProfileError(f"{name} must be a number")
    if "options" in spec:
        if value not in spec["options"]:
            raise ProfileError(f"{name} must be one of {spec['options']}")
        return spec["options"][spec["options"].index(value)]   # 200.0 from JSON is stored as the option 200
    lo, hi, step = spec["min"], spec["max"], spec["step"]
    if not lo - 1e-9 <= value <= hi + 1e-9:
        raise ProfileError(f"{name} must be from {lo} to {hi}")
    k = round((value - lo) / step)
    if abs(lo + k * step - value) > 1e-6:
        raise ProfileError(f"{name} must move in steps of {step}")
    out = round(lo + k * step, 6)
    return int(out) if float(out).is_integer() and isinstance(step, int) else out


def normalize_rule(rule, style: str) -> dict:
    cat = catalog()["rules"]
    if not isinstance(rule, dict) or set(rule) - {"id", "params"} or rule.get("id") not in cat:
        raise ProfileError("unknown rule")
    spec = cat[rule["id"]]
    if style not in spec["styles"]:
        raise ProfileError(f"rule {rule['id']} does not belong to the {style} style")
    given = rule.get("params") or {}
    if not isinstance(given, dict) or set(given) - set(spec["params"]):
        raise ProfileError(f"rule {rule['id']}: unknown settings")
    params = {k: _param(p, given.get(k, p["default"]), f"{rule['id']}.{k}") for k, p in spec["params"].items()}
    for a, op, b in spec.get("requires", []):
        if op == "<" and not params[a] < params[b]:
            raise ProfileError(f"rule {rule['id']}: {a} must be shorter than {b}")
    return {"id": rule["id"], "params": params}


def _bps(v, lo, hi, name):
    if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
        raise ProfileError(f"{name} must be an integer from {lo} to {hi}")
    return v


def normalize_profile(profile) -> dict:
    """Validate and canonicalise a stored profile. Same checks as the web store; the engine never trusts it blindly."""
    if not isinstance(profile, dict) or profile.get("schema") != SCHEMA:
        raise ProfileError("not an agent profile")
    cat, lim = catalog(), catalog()["limits"]
    if not isinstance(profile.get("id"), str) or not _UUID.match(profile["id"]):
        raise ProfileError("agent id")
    revision = profile.get("revision")
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1:
        raise ProfileError("agent revision")
    name = profile.get("name")
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= lim["name_chars"] or _CONTROL.search(name):
        raise ProfileError("agent name")
    style = profile.get("style")
    if style not in cat["styles"] or not cat["styles"][style]["available"]:
        raise ProfileError("this style is not available yet")
    if profile.get("preset") not in cat["styles"][style]["presets"]:
        raise ProfileError("unknown preset")
    rules = profile.get("rules")
    if not isinstance(rules, list) or len(rules) > lim["rules"]:
        raise ProfileError(f"an agent has at most {lim['rules']} rules")
    rules = [normalize_rule(r, style) for r in rules]
    if len({r["id"] for r in rules}) != len(rules):
        raise ProfileError("each rule can be used once")
    if sum("filter" in cat["rules"][r["id"]] for r in rules) > lim["filters"]:
        raise ProfileError(f"at most {lim['filters']} stock filters")
    philosophy = profile.get("philosophy", "")
    if not isinstance(philosophy, str) or len(philosophy) > lim["philosophy_chars"] or _CONTROL.search(philosophy):
        raise ProfileError("philosophy text")
    risk = profile.get("risk")
    if not isinstance(risk, dict) or set(risk) != {"maxWeightBps", "minCashBps", "maxDrawdownBps"}:
        raise ProfileError("risk limits")
    risk = {"maxWeightBps": _bps(risk["maxWeightBps"], 100, 10000, "maxWeightBps"),
            "minCashBps": _bps(risk["minCashBps"], 0, 9500, "minCashBps"),
            "maxDrawdownBps": _bps(risk["maxDrawdownBps"], 100, 8000, "maxDrawdownBps")}
    if profile.get("rebalance") not in REBALANCES:
        raise ProfileError("rebalance")
    if profile.get("approval") not in APPROVALS:
        raise ProfileError("approval mode")
    return {"schema": SCHEMA, "id": profile["id"], "revision": revision, "name": name.strip(), "style": style,
            "preset": profile["preset"], "rules": sorted(rules, key=lambda r: r["id"]), "philosophy": philosophy.strip(),
            "risk": risk, "rebalance": profile["rebalance"], "approval": profile["approval"]}


def profile_hash(profile: dict) -> str:
    return hashlib.sha256(json.dumps(normalize_profile(profile), sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=False).encode()).hexdigest()


def _fill(template, params: dict):
    if isinstance(template, str) and template.startswith("$"):
        return params[template[1:]]
    if isinstance(template, dict) and set(template) == {"neg"}:
        return -_fill(template["neg"], params)
    if isinstance(template, dict):
        return {k: _fill(v, params) for k, v in template.items()}
    return template


def enforced(profile: dict) -> dict:
    """What the profile adds to every design: ``filters``, an optional ``risk_off`` and ``breadth_off`` market guard,
    an optional ``top_n_cap``, a minimum ``hold_buffer`` and ``exit`` rules (largest allowed stop distances)."""
    p = normalize_profile(profile)
    cat = catalog()["rules"]
    out = {"filters": [], "risk_off": None, "breadth_off": None, "top_n_cap": None, "hold_buffer": None, "exit": {}}
    for r in p["rules"]:
        spec = cat[r["id"]]
        if "filter" in spec:
            out["filters"].append(_fill(spec["filter"], r["params"]))
        for key in ("risk_off", "breadth_off", "hold_buffer"):
            if key in spec:
                out[key] = _fill(spec[key], r["params"])
        if "top_n_cap" in spec:
            out["top_n_cap"] = int(_fill(spec["top_n_cap"], r["params"]))
        if "exit" in spec:
            out["exit"].update(_fill(spec["exit"], r["params"]))
    # The same checks as any design: a rule can never produce something the strategy language rejects.
    probe = {"score": [{"signal": "trend", "lookback": 20, "weight": 1}], "filters": out["filters"], "weighting": "equal",
             "risk_off": out["risk_off"], "breadth_off": out["breadth_off"], "hold_buffer": out["hold_buffer"], "exit": out["exit"] or None}
    try:
        d = normalize_design(probe)
    except DesignError as exc:
        raise ProfileError(f"agent rules are inconsistent: {exc}") from exc
    return {"filters": d["filters"], "risk_off": d["risk_off"], "breadth_off": d.get("breadth_off"), "top_n_cap": out["top_n_cap"],
            "hold_buffer": d.get("hold_buffer"), "exit": d.get("exit")}


def apply(design: dict, profile: dict) -> dict:
    """The model's design with the agent's rules merged in. The agent's market guard replaces the model's; its holdings
    cap bounds ``top_n``. A technical agent's design may not use company fundamentals; a value agent's design must score
    at least one. Raises DesignError if the result is not a valid design for this agent."""
    d, e = normalize_design(design), enforced(profile)
    style = normalize_profile(profile)["style"]
    used = {t["signal"] for t in d["score"] + d["filters"]}
    if style == "technical" and used & set(FUNDAMENTAL_SIGNALS):
        raise DesignError("a technical agent decides from price behaviour only; this design uses company fundamentals")
    if style == "value" and not {t["signal"] for t in d["score"]} & set(FUNDAMENTAL_SIGNALS):
        raise DesignError("a value agent's design must score at least one company fundamental")
    filters = d["filters"] + [f for f in e["filters"] if f not in d["filters"]]
    top_n = d["top_n"]
    if e["top_n_cap"] is not None:
        top_n = e["top_n_cap"] if top_n is None else min(top_n, e["top_n_cap"])
    out = {**d, "filters": filters, "top_n": top_n, "risk_off": e["risk_off"] or d["risk_off"]}
    if e["breadth_off"]:
        out["breadth_off"] = e["breadth_off"]
    if e["hold_buffer"]:
        out["hold_buffer"] = max(e["hold_buffer"], d.get("hold_buffer") or 0)
    if e["exit"]:
        # the agent's stop is the loosest allowed: the model may only sell earlier, never later
        mine, theirs = e["exit"], d.get("exit") or {}
        out["exit"] = {k: min(v for v in (mine.get(k), theirs.get(k)) if v is not None)
                       if (mine.get(k) is not None or theirs.get(k) is not None) else None for k in ("stop_loss", "trailing_stop")}
    return normalize_design(out)


def compliance(design: dict, profile: dict) -> list[dict]:
    """One check per rule, against the design that is actually backtested. Never trusts that ``apply`` ran."""
    d, p, cat = normalize_design(design), normalize_profile(profile), catalog()["rules"]
    checks = []
    for r in p["rules"]:
        spec = cat[r["id"]]
        if "filter" in spec:
            ok = normalize_design({"score": d["score"], "filters": [_fill(spec["filter"], r["params"])],
                                   "weighting": "equal"})["filters"][0] in d["filters"]
        elif "risk_off" in spec:
            want = normalize_design({"score": d["score"], "weighting": "equal",
                                     "risk_off": _fill(spec["risk_off"], r["params"])})["risk_off"]
            ok = d["risk_off"] == want
        elif "breadth_off" in spec:
            want = normalize_design({"score": d["score"], "weighting": "equal",
                                     "breadth_off": _fill(spec["breadth_off"], r["params"])})["breadth_off"]
            ok = d.get("breadth_off") == want
        elif "hold_buffer" in spec:
            ok = (d.get("hold_buffer") or 0) >= _fill(spec["hold_buffer"], r["params"]) - 1e-9
        elif "exit" in spec:
            want = _fill(spec["exit"], r["params"])
            ok = all((d.get("exit") or {}).get(k) is not None and d["exit"][k] <= v + 1e-9 for k, v in want.items())
        else:
            cap = int(_fill(spec["top_n_cap"], r["params"]))
            ok = d["top_n"] is not None and d["top_n"] <= cap
        checks.append({"rule": r["id"], "params": r["params"], "status": "pass" if ok else "fail"})
    return checks
