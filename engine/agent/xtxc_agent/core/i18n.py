"""Display language: English (default), Korean, Simplified Chinese.

A request's language comes from the `X-Lang` header (see app.py); background work (research threads, the order
watcher) runs in the language the object was created in. Every sentence a user can see is looked up here with
`tr(key, **params)`; amounts are formatted per language (KRW for Korean, USD for English and Chinese).
Stored records keep the language they were written in, like messages in a chat.
"""

from __future__ import annotations

import contextvars
from contextlib import contextmanager
from decimal import Decimal

LANGS = ("en", "ko", "zh")
DEFAULT = "en"
DEFAULT_FX = "1390"
LANG_NAME = {"en": "English", "ko": "Korean (polite 해요체)", "zh": "Simplified Chinese"}

_current: contextvars.ContextVar[str] = contextvars.ContextVar("xtxc_lang", default=DEFAULT)


def norm(value: str | None) -> str:
    v = (value or "").strip().lower()[:2]
    return v if v in LANGS else DEFAULT


def lang() -> str:
    return _current.get()


def set_lang(value: str | None) -> contextvars.Token:
    return _current.set(norm(value))


@contextmanager
def speaking(value: str | None):
    token = _current.set(norm(value))
    try:
        yield
    finally:
        _current.reset(token)


# ------------------------------------------------------------------ helpers
def _has_batchim(word: str) -> bool:
    import re
    word = re.sub(r"\s*\([^()]*\)\s*$", "", word.rstrip()) or word      # '애플(AAPL)' reads as '애플'
    ch = word.rstrip()[-1:] if word.strip() else ""
    if "가" <= ch <= "힣":
        return (ord(ch) - 0xAC00) % 28 != 0
    return ch.lower() in "lmnr0136789"


def topic(word: str) -> str:
    """Korean topic particle ('아마존은'); other languages: the word itself."""
    if lang() != "ko":
        return word
    return word + ("은" if _has_batchim(word) else "는")


def obj(word: str) -> str:
    """Korean object particle ('아마존을'); other languages: the word itself."""
    if lang() != "ko":
        return word
    return word + ("을" if _has_batchim(word) else "를")


def join(items) -> str:
    items = [str(i) for i in items if i is not None and str(i) != ""]
    return ("、" if lang() == "zh" else ", ").join(items)


def sentences(items) -> str:
    """Join sentences the way the language writes them (no spaces between Chinese sentences)."""
    items = [str(i).strip() for i in items if i and str(i).strip()]
    return ("" if lang() == "zh" else " ").join(items)


def tidy(text: str) -> str:
    """Remove words the model repeated next to a filled placeholder ('最近最近一年', 'the last the last year', '최근 최근 1년')."""
    import re
    text = re.sub(r"最近\s*最近", "最近", text)
    text = re.sub(r"(?i)\b(the last|over the last)\s+the last\b", r"\1", text)
    return re.sub(r"최근\s+최근", "최근", text)


def won(krw: int) -> str:
    """Korean won: '186만 원', '9,600원'."""
    if abs(krw) >= 10_000:
        text = f"{Decimal(krw) / 10_000:.1f}".rstrip("0").rstrip(".")
        return f"{text}만 원"
    return f"{krw:,}원"


def usd(amount: Decimal | float) -> str:
    a = Decimal(str(amount))
    sign = "-" if a < 0 else ""
    a = abs(a)
    return f"{sign}${a:,.0f}" if a >= 1000 else f"{sign}${a:,.2f}"


def money(krw: int | None, fx: str | None = None) -> str:
    """A KRW amount shown the user's way: won for Korean, dollars (USDC) for English and Chinese."""
    krw = int(krw or 0)
    if lang() == "ko":
        return won(krw)
    return usd(Decimal(krw) / Decimal(fx or DEFAULT_FX))


def years(n) -> str:
    return tr("unit.years", n=n)


def with_ticker(name: str, ticker: str) -> str:
    """'Apple (AAPL)' in English, '애플(AAPL)' / '苹果(AAPL)' in Korean and Chinese."""
    if not name or name == ticker:
        return ticker
    return f"{name} ({ticker})" if lang() == "en" else f"{name}({ticker})"


def stock_name(inst, ticker: str | None = None) -> str:
    if inst is None:
        return ticker or ""
    field = {"ko": "name_ko", "zh": "name_zh", "en": "name_short_en"}[lang()]
    return (getattr(inst, field, None) or getattr(inst, "name_short_en", None) or getattr(inst, "name_en", None)
            or getattr(inst, "name_ko", None) or ticker or "")


def tr(key: str, **kw) -> str:
    entry = M.get(key)
    if entry is None:
        raise KeyError(f"no message {key!r}")
    text = entry.get(lang()) or entry["en"]
    if "n" in kw and "s" not in kw:
        kw["s"] = "" if kw["n"] in (1, "1") else "s"
    return text.format(**kw) if kw or "{" in text else text


class Names:
    """A name table that answers in the current language: Names("sector").get("healthcare") -> "Healthcare"."""

    def __init__(self, group: str):
        self.group = group

    def get(self, key, default=None):
        k = f"{self.group}.{key}"
        return tr(k) if k in M else (key if default is None else default)

    def __getitem__(self, key):
        return self.get(key)

    def __contains__(self, key):
        return f"{self.group}.{key}" in M


def label(group: str, key: str) -> str:
    """Names of fixed things: sectors, strategies, fields, verdicts, steps, modes, statuses."""
    return tr(f"{group}.{key}") if f"{group}.{key}" in M else key


# ------------------------------------------------------------------ catalog
def _m(en: str, ko: str, zh: str) -> dict:
    return {"en": en, "ko": ko, "zh": zh}


M: dict[str, dict[str, str]] = {
    # units
    "unit.years": _m("{n} year{s}", "{n}년", "{n}年"),
    "unit.minutes": _m("{n} min", "{n}분", "{n}分钟"),
    "unit.rounds": _m("{n} round{s}", "{n}차례", "{n}轮"),
    "unit.stocks": _m("{n} stock{s}", "{n}종목", "{n}只股票"),
    "unit.pp": _m("{x} pp", "{x}%p", "{x}个百分点"),
    "unit.recent_year": _m("the last year", "최근 1년", "最近一年"),
    "period.weekly": _m("weekly", "매주", "每周"),
    "period.monthly": _m("monthly", "매달", "每月"),
    "word.none": _m("none", "없음", "无"),
    "word.on": _m("on", "켬", "开启"),
    "word.off": _m("off", "끔", "关闭"),
    "word.strategy": _m("Strategy", "전략", "策略"),
    # sectors / strategies / fields
    "sector.semiconductors": _m("Semiconductors", "반도체", "半导体"),
    "sector.big_tech": _m("Big Tech", "빅테크", "大型科技"),
    "sector.etf_index": _m("Index ETFs", "지수 ETF", "指数ETF"),
    "sector.commodities_etf": _m("Commodity ETFs", "원자재 ETF", "大宗商品ETF"),
    "sector.crypto_related": _m("Crypto-related", "가상자산 관련", "加密资产相关"),
    "sector.financials": _m("Financials", "금융", "金融"),
    "sector.healthcare": _m("Healthcare", "헬스케어", "医疗保健"),
    "sector.consumer": _m("Consumer", "소비재", "消费"),
    "sector.energy": _m("Energy", "에너지", "能源"),
    "sector.industrials": _m("Industrials", "산업재", "工业"),
    "sector.telecom_media": _m("Telecom & Media", "통신·미디어", "通信·传媒"),
    "sector.software": _m("Software", "소프트웨어", "软件"),
    "template.momentum": _m("Momentum", "모멘텀", "动量"),
    "template.low_vol": _m("Low volatility", "저변동성", "低波动"),
    "template.equal_weight": _m("Equal weight", "균등 분산", "等权分散"),
    "field.budget_krw": _m("Budget", "예산", "预算"),
    "field.sectors": _m("Sectors", "분야", "行业"),
    "field.tickers": _m("Stocks", "종목", "股票"),
    "field.exclude": _m("Excluded stocks", "제외 종목", "排除的股票"),
    "field.max_weight": _m("Max per stock", "한 종목 최대 비중", "单只上限"),
    "field.min_cash": _m("Cash to keep", "남길 현금", "保留现金"),
    "field.rebalance": _m("Rebalance", "비중 조정 주기", "调仓周期"),
    "field.template": _m("Strategy", "전략 방식", "策略方式"),
    "field.exclude_leveraged": _m("Exclude leveraged", "레버리지 제외", "排除杠杆"),
    "verdict.pass": _m("Pass", "통과", "通过"),
    "verdict.warn": _m("Caution", "주의", "注意"),
    "verdict.fail": _m("Fail", "불합격", "不通过"),
    "tier.fast": _m("Quick approval", "빠른 결재", "快速审批"),
    "tier.careful": _m("Careful approval", "신중한 결재", "谨慎审批"),
    "tier.blocked": _m("Can't approve", "결재 불가", "无法审批"),
    "mode.now": _m("Approve now", "지금 결재", "立即审批"),
    "mode.presign": _m("Conditional approval (pre-signed)", "조건부 결재(사전 서명)", "条件审批（预签名）"),
    "mode.notify": _m("Notify when conditions are met", "조건되면 알림", "条件满足时通知"),
    "mode.slice": _m("Split buying (pre-signed)", "나눠 사기(사전 서명)", "分批买入（预签名）"),
    "mode.immediate": _m("Approve all at once (instead of split buying)", "지금 한 번에 결재(나눠 사기 대신)", "一次性审批（代替分批买入）"),
    "mode.slice_interval": _m("Split buying (pre-signed, every {m} min)", "나눠 사기(사전 서명, {m}분 간격)", "分批买入（预签名，每{m}分钟）"),
    "status.filled": _m("filled", "체결", "已成交"),
    "status.failed": _m("failed", "실패", "失败"),
    "status.cancelled": _m("not sent", "보내지 않음", "未发送"),
    "status.unknown": _m("checking the result", "결과 확인 중", "结果确认中"),
    "status.expired": _m("deadline passed", "마감 만료", "已过截止时间"),
    "status.partial": _m("partly filled", "일부 체결", "部分成交"),
    "step.conditions": _m("Checking conditions", "조건 확인", "确认条件"),
    "step.data": _m("Preparing price data", "가격 데이터 준비", "准备价格数据"),
    "step.costs": _m("Measuring real XTXC trading costs", "XTXC 실제 거래 비용 측정", "测量 XTXC 实际交易成本"),
    "step.backtest": _m("Calculating past performance", "과거 성과 계산", "计算过往表现"),
    "step.evaluate": _m("Independent checks", "독립 검사", "独立检验"),
    "step.explain": _m("Plain-language explanation", "쉬운 말 설명", "通俗解释"),
    "step.done": _m("Done", "완료", "完成"),

    # app / demo errors
    "err.demo.connect_first": _m("Connect the demo wallet first.", "시연 지갑을 먼저 연결해 주세요.", "请先连接演示钱包。"),
    "err.demo.not_your_wallet": _m("This isn't the wallet of this demo session.", "이 시연 세션의 지갑이 아니에요.", "这不是本次演示会话的钱包。"),
    "err.demo.wallets_not_ready": _m("Demo wallets aren't ready yet. Please try again shortly.", "시연용 지갑이 준비되지 않았어요. 잠시 뒤 다시 시도해 주세요.",
                                     "演示钱包尚未就绪，请稍后再试。"),
    "err.rate": _m("Too many requests. Please try again in about {m} min.", "요청이 너무 잦아요. 약 {m}분 뒤에 다시 시도해 주세요.",
                   "请求过于频繁，请约 {m} 分钟后再试。"),
    "err.ai_unavailable": _m("The AI isn't responding right now. Please try again in a moment.", "AI가 지금 응답하지 않아요. 잠시 뒤 다시 시도해 주세요.",
                             "AI 暂时没有响应，请稍后再试。"),
    "err.ai_invalid": _m("The AI couldn't turn that into conditions. Please be a little more specific.",
                         "AI 답을 조건으로 바꾸지 못했어요. 조금 더 구체적으로 적어 주세요.", "AI 无法把这句话整理成投资条件，请说得更具体一些。"),
    "err.chain": _m("There's a problem connecting to the chain.", "체인 연결에 문제가 있어요.", "链连接出现问题。"),
    "err.research_not_found": _m("Couldn't find that check.", "연구 기록을 찾지 못했어요.", "找不到该回测记录。"),
    "err.receipt_not_found": _m("Couldn't find that receipt.", "영수증을 찾지 못했어요.", "找不到该收据。"),
    "err.paper_not_found": _m("Couldn't find that paper-trading record.", "모의운용 기록을 찾지 못했어요.", "找不到该模拟运行记录。"),
    "err.walletcheck_not_found": _m("Couldn't find that wallet check.", "지갑 점검 기록을 찾지 못했어요.", "找不到该钱包检查记录。"),
    "err.wallet_first": _m("Connect a wallet first.", "지갑을 먼저 연결해 주세요.", "请先连接钱包。"),
    "err.wallet_needed": _m("A wallet is needed.", "지갑이 필요해요.", "需要钱包。"),
    "err.chat.other_wallet": _m("These records belong to another wallet, so they can't be used in this chat.",
                                "다른 지갑의 기록이라 대화에 쓸 수 없어요.", "这些记录属于其他钱包，不能在对话中使用。"),
    "err.plan.research_running": _m("You can make an order after the check finishes.", "연구가 끝난 뒤에 주문을 만들 수 있어요.", "回测完成后才能生成订单。"),
    "err.plan.research_failed": _m("A strategy that failed the independent checks can't become an order.",
                                   "독립 검사에서 불합격한 전략은 주문으로 넘길 수 없어요.", "未通过独立检验的策略不能生成订单。"),
    "err.plan.conditions_changed": _m("Your conditions changed. Check again with the new conditions before making an order.",
                                      "조건이 바뀌었어요. 새 조건으로 다시 연구한 뒤 주문을 만들 수 있어요.", "条件已更改。请用新条件重新回测后再生成订单。"),
    "sim.note": _m("This is a demo chain with no other traders. Instead, a simulator brings pool prices back to where they started "
                   "about {s} seconds after a trade (what other traders do on a real exchange).",
                   "시연용 체인이라 다른 거래자가 없어요. 대신 시뮬레이터가 거래 약 {s}초 뒤 풀 가격을 시작 수준으로 되돌려요"
                   "(실제 거래소에서 다른 거래자가 하는 일).",
                   "这是演示链，没有其他交易者。模拟器会在交易约 {s} 秒后把池子价格恢复到初始水平（真实交易所中由其他交易者完成）。"),
    "ledger.plan.rejected": _m("A check made with conditions v{old} can't be used with conditions v{cur}, so no order was made.",
                               "조건 v{old}로 만든 연구는 조건 v{cur}에서 쓸 수 없어 주문을 만들지 않았어요.",
                               "用条件 v{old} 做的回测不能用于条件 v{cur}，因此没有生成订单。"),
    "ledger.plan.replaced": _m("A new approval card was made from the same check, so the previous card won't be used.",
                               "같은 연구로 새 결재 카드를 만들어 이전 카드는 쓰지 않아요.", "已用同一回测生成新的审批卡，之前的卡片不再使用。"),
    "ledger.walletcheck.same": _m("Wallet check: signed exactly as shown", "지갑 점검: 서명 내용 그대로", "钱包检查：签名内容与显示一致"),
    "ledger.walletcheck.changed": _m("Wallet check: the wallet changed the transaction", "지갑 점검: 지갑이 거래를 바꿨어요", "钱包检查：钱包修改了交易"),

    # briefs
    "brief.q.what": _m("Which sectors or stocks should we invest in?", "어떤 분야나 종목으로 투자할까요?", "要投资哪些行业或股票？"),
    "brief.q.budget": _m("How much would you like to start with?", "얼마로 시작할까요?", "打算用多少资金开始？"),
    "brief.q.cap": _m("With {n} stocks and at most {mw}% each, only {tot}% gets invested. Keep the rest as cash?",
                      "종목 {n}개에 한 종목 최대 {mw}%면 {tot}%까지만 투자돼요. 나머지는 현금으로 둘까요?",
                      "{n}只股票、每只最多{mw}%时，只能投入{tot}%。其余保留为现金吗？"),
    "brief.title.more": _m(" and more", " 외", " 等"),
    "brief.title.mine": _m("My strategy", "내 전략", "我的策略"),
    "err.brief.length": _m("Please write your request in 2–1,000 characters.", "요청은 2~1,000자로 적어 주세요.", "请用 2 到 1,000 个字描述你的需求。"),
    "err.brief.not_editable": _m("These can't be changed: {fields}", "바꿀 수 없는 항목: {fields}", "这些项目无法修改：{fields}"),
    "err.brief.pick": _m("Please choose a rebalance period and a strategy.", "리밸런싱 주기와 전략 종류를 골라 주세요.", "请选择调仓周期和策略方式。"),
    "err.brief.need_budget": _m("Set a budget and stocks to invest in first.", "예산과 투자할 종목을 먼저 정해 주세요.", "请先设定预算和要投资的股票。"),
    "ledger.brief.drafted": _m("Draft conditions: {title}", "투자 조건 초안: {title}", "投资条件草稿：{title}"),
    "ledger.brief.edited": _m("Conditions edited: {fields}", "조건 수정: {fields}", "条件已修改：{fields}"),
    "ledger.brief.confirmed": _m("Conditions v{v} confirmed: {budget}, {n} stock{s}, max {mw}% per stock, at least {mc}% cash",
                                 "조건 v{v} 확인: {budget}, 종목 {n}개, 한 종목 최대 {mw}%, 현금 {mc}% 이상",
                                 "条件 v{v} 已确认：{budget}，{n}只股票，单只最多{mw}%，现金至少{mc}%"),

    # ask / paper
    "err.ask.length": _m("Please keep your question to 2–300 characters.", "질문은 2~300자로 적어 주세요.", "问题请控制在 2 到 300 个字。"),
    "ledger.ask": _m("Question: {q}", "질문: {q}", "提问：{q}"),
    "err.paper.not_done": _m("Only a finished check can be paper-traded.", "연구가 끝난 전략만 모의운용할 수 있어요.", "只有完成回测的策略才能模拟运行。"),
    "ledger.paper.started": _m("Paper trading started: {title} (from the {date} close)", "모의운용 시작: {title} ({date} 종가 기준)",
                               "模拟运行开始：{title}（以 {date} 收盘价为准）"),
    "paper.no_start_price": _m("Couldn't find the start-date prices.", "시작일 가격을 찾지 못했어요.", "找不到起始日价格。"),
    "paper.no_new_days": _m("No new trading days since the start yet. It will be calculated when the next close arrives.",
                            "아직 시작일 이후 새 거래일 데이터가 없어요. 다음 종가가 들어오면 계산해요.", "起始日之后还没有新的交易日数据，下一个收盘价出来后会计算。"),
    "paper.result": _m("Simulated performance over {n} trading day{s} since {date}. Not real trading.",
                       "{date} 이후 거래일 {n}일 동안의 가상 성과예요. 실제 거래가 아니에요.", "{date} 之后 {n} 个交易日的模拟表现，并非真实交易。"),

    # orders: approval card
    "route.no_close": _m("No stock price reference, so the holding can't be valued", "주가 기준값이 없어 보유분 가치를 계산할 수 없어요",
                         "缺少股价参考，无法计算持仓价值"),
    "route.none": _m("No route to trade this on XTXC right now", "지금 XTXC에서 거래할 경로가 없어요", "目前在 XTXC 上没有可交易的路径"),
    "light.premium.closed": _m(" The US market is closed now, so the price gap may widen.", " 지금은 미국 장이 닫혀 있어 가격 차이가 커질 수 있어요.",
                               "美国市场目前休市，价格差可能扩大。"),
    "ledger.plan.blocked": _m("Can't approve: {reasons}", "결재 불가: {reasons}", "无法审批：{reasons}"),
    "rule.outside": _m("Stocks outside your conditions: {names}", "조건에 없는 종목이 들어 있어요: {names}", "包含条件之外的股票：{names}"),
    "rule.cash": _m("It would buy more than your cash floor allows", "남겨야 할 현금보다 많이 사려고 해요", "买入金额超过了应保留现金的限制"),
    "rule.usdc": _m("Your wallet's USDC is less than the order amount", "지갑의 USDC가 주문 금액보다 적어요", "钱包中的 USDC 少于订单金额"),
    "rule.leveraged": _m("You chose to exclude leveraged products: {names}", "레버리지 상품은 제외하기로 했어요: {names}", "你已选择排除杠杆产品：{names}"),
    "light.rules": _m("My conditions", "내 조건", "我的条件"),
    "light.rules.ok": _m("Budget, stocks, per-stock limit and cash floor are all respected.", "예산, 종목, 한 종목 비중, 남길 현금을 모두 지켜요.",
                         "预算、股票、单只比例和保留现金都符合条件。"),
    "light.rules.nothing": _m("Your weights are already close to target; nothing to change.", "지금 비중이 목표와 거의 같아서 바꿀 게 없어요.",
                              "当前比例已接近目标，无需调整。"),
    "light.holdings": _m("Holdings", "보유량", "持仓"),
    "light.holdings.ok": _m("Stocks already in your wallet were subtracted; only what's needed is bought.",
                            "지갑에 이미 있는 주식을 빼고 필요한 만큼만 계산했어요.", "已扣除钱包中已有的股票，只计算需要的部分。"),
    "light.holdings.fail": _m("Couldn't read your wallet holdings, so no order can be made.", "지갑 보유량을 읽지 못해 주문을 만들 수 없어요.",
                              "无法读取钱包持仓，因此无法生成订单。"),
    "reason.holdings": _m("Couldn't read wallet holdings", "지갑 보유량을 읽지 못했어요", "无法读取钱包持仓"),
    "prod.unit": _m("Can't confirm how many shares one token represents (split/multiplier): {names}",
                    "토큰 1개가 몇 주인지 확인되지 않아요(분할·배율): {names}", "无法确认 1 枚代币对应多少股（拆股/倍数）：{names}"),
    "prod.no_buy": _m("No route to buy right now: {names}", "지금 살 수 있는 경로가 없어요: {names}", "目前没有可买入的路径：{names}"),
    "prod.no_sell": _m("No route to sell right now: {names}", "지금 팔 수 있는 경로가 없어요: {names}", "目前没有可卖出的路径：{names}"),
    "prod.unverified": _m("Tokens not on the verified list: {names}", "검증 목록에 없는 토큰이에요: {names}", "不在验证列表中的代币：{names}"),
    "light.product": _m("Product check", "상품 확인", "产品确认"),
    "light.product.ok": _m("Only tokens on the verified list are traded.", "검증 목록에 있는 토큰으로만 거래해요.", "只交易验证列表中的代币。"),
    "light.premium": _m("Price gap", "가격 차이", "价格差"),
    "light.premium.detail": _m("Token prices differ from the stock's close by up to {p}%.", "토큰 가격이 원주식 종가와 최대 {p}% 달라요.",
                               "代币价格与股票收盘价最多相差 {p}%。"),
    "light.premium.none": _m("Couldn't find the stock price, so the gap wasn't calculated.", "원주식 가격을 찾지 못해 가격 차이를 계산하지 못했어요.",
                             "找不到股票价格，无法计算价格差。"),
    "reason.premium": _m("Token price differs from the stock by more than {p}%", "토큰 가격이 원주식과 {p}% 넘게 달라요", "代币价格与股票相差超过 {p}%"),
    "light.cost": _m("Cost", "비용", "成本"),
    "light.cost.detail": _m("Trading costs are up to {c}% of the order amount.", "사고팔 때 드는 비용이 주문 금액의 최대 {c}%예요.",
                            "交易成本最高为订单金额的 {c}%。"),
    "light.cost.none": _m("Couldn't calculate the cost.", "비용을 계산하지 못했어요.", "无法计算成本。"),
    "reason.cost": _m("Cost exceeds {c}% of the order amount", "비용이 주문 금액의 {c}%를 넘어요", "成本超过订单金额的 {c}%"),
    "light.quote": _m("Quote", "견적", "报价"),
    "light.quote.detail": _m("Fresh quote. If you don't approve within {sec} seconds, a new one is fetched.",
                             "방금 받은 견적이에요. {sec}초 안에 결재하지 않으면 다시 받아요.", "刚获取的报价。{sec} 秒内未审批将重新获取。"),
    "headline.buy": _m("Buy {n} stock{s} for {amount}", "{n}종목을 {amount}어치 사요", "买入{n}只股票，共{amount}"),
    "headline.sell": _m("Sell {n} stock{s} for {amount}", "{n}종목을 {amount}어치 팔아요", "卖出{n}只股票，共{amount}"),
    "headline.none": _m("Nothing to change", "바꿀 게 없어요", "无需调整"),
    "preview.token": _m("{name} token{note}", "{name} 토큰{note}", "{name} 代币{note}"),
    "preview.split": _m(" (in {n} parts)", " ({n}번에 나눠)", "（分{n}次）"),
    "preview.min": _m("+ at least {x}", "+ 최소 {x}", "+ 至少 {x}"),
    "preview.title.slice": _m("Sign once and it fills in {n} rounds · slices in the same round fill together or wait together until the price comes back",
                              "한 번 서명하면 {n}차례에 나눠 체결돼요 · 같은 차례의 조각은 한꺼번에 체결되거나 가격이 돌아올 때까지 함께 기다려요",
                              "签名一次，分{n}轮成交 · 同一轮的分片一起成交，或一起等待价格回来"),
    "preview.title.one": _m("1 transaction · every stock fills together or is cancelled together",
                            "거래 1건 · 모든 종목이 한꺼번에 체결되거나 한꺼번에 취소돼요", "1 笔交易 · 所有股票一起成交或一起取消"),
    # all at once vs split (verbs per side are passed in as params)
    "imm.no_route": _m("There isn't enough volume to {verb} {names} all at once right now. Split buying still sends the first slice right away.",
                       "{names} 지금 한 번에 {stem} 물량이 없어요. 나눠 사기에서도 첫 조각은 바로 보내요.",
                       "{names}目前没有足够的流动性一次性{verb}。分批买入时第一片也会立即发送。"),
    "imm.too_costly": _m("{ger} {names} all at once would cost {c}% of the order, so it's blocked. Split buying still sends the first slice right away.",
                         "{names} 한 번에 {verb_if} 비용이 주문 금액의 {c}%라서 막아 두었어요. 나눠 사기에서도 첫 조각은 바로 보내요.",
                         "一次性{verb}{names}的成本为订单金额的{c}%，因此已被阻止。分批买入时第一片也会立即发送。"),
    "imm.cost": _m(" (cost up to {c}%)", "(비용 최대 {c}%)", "（成本最高{c}%）"),
    "imm.note_extra": _m("{ger} it all now costs about {extra} more than splitting{cost}. But it finishes right away with no waiting.",
                         "지금 한 번에 {verb_if} 나눠서 할 때보다 약 {extra} 더 들어요{cost}. 대신 기다리지 않고 바로 끝나요.",
                         "现在一次性{verb}比分批多花约{extra}{cost}，但无需等待，立即完成。"),
    "imm.note_same": _m("{ger} it all now costs about the same{cost}, and finishes right away.",
                        "지금 한 번에 {verb_if} 비용 차이가 거의 없어요{cost}. 기다리지 않고 바로 끝나요.",
                        "现在一次性{verb}的成本几乎没有差别{cost}，无需等待，立即完成。"),
    "verb.BUY": _m("buy", "사면", "买入"), "verb.SELL": _m("sell", "팔면", "卖出"), "verb.MIX": _m("trade", "거래하면", "交易"),
    "ger.BUY": _m("Buying", "", ""), "ger.SELL": _m("Selling", "", ""), "ger.MIX": _m("Trading", "", ""),
    "stem.BUY": _m("", "살", ""), "stem.SELL": _m("", "팔", ""), "stem.MIX": _m("", "거래할", ""),
    "slice.part": _m("{name} trades thinly, so it's {done} in {n} parts", "{name} 거래가 얇아 {n}번에 나눠 {done}",
                     "{name}交易较薄，分{n}次{done}"),
    "slice.done.BUY": _m("bought", "사요", "买入"), "slice.done.SELL": _m("sold", "팔아요", "卖出"),
    "slice.tail": _m(". Each slice goes only when the price is back near where it started; slices not filled by the deadline aren't sent.",
                     ". 각 조각은 가격이 처음 수준 근처로 돌아왔을 때만 보내고, 마감까지 못 채운 조각은 보내지 않아요.",
                     "。每一片只在价格回到初始水平附近时发送，截止前未成交的分片不会发送。"),
    "slice.join": _m(". ", ". ", "；"),
    "claim.void.immediate": _m("Chose all at once, so the split-buying predictions aren't scored", "지금 한 번에를 골라 나눠 사기 예측은 채점하지 않아요",
                               "已选择一次性成交，分批预测不计分"),
    "claim.cost.BUY": _m("{name}: buys about {c}% {dir} than the stock price.", "{name} 주가보다 약 {c}% {dir} 사요.",
                         "{name}：以比股价{dir}约{c}%的价格买入。"),
    "claim.cost.SELL": _m("{name}: sells about {c}% {dir} than the stock price.", "{name} 주가보다 약 {c}% {dir} 팔아요.",
                          "{name}：以比股价{dir}约{c}%的价格卖出。"),
    "claim.dir.higher": _m("higher", "비싸게", "高"), "claim.dir.lower": _m("lower", "싸게", "低"),
    "claim.min.BUY": _m("{name}: receives at least the minimum number of tokens.", "{name} 거래에서 토큰을 최소 수량 이상 받아요.",
                        "{name}：至少收到最低数量的代币。"),
    "claim.min.SELL": _m("{name}: receives at least the minimum USDC.", "{name} 거래에서 USDC를 최소 수량 이상 받아요.", "{name}：至少收到最低数量的 USDC。"),

    # execution
    "err.exec.plan_not_found": _m("Couldn't find that approval card.", "결재 카드를 찾지 못했어요.", "找不到该审批卡。"),
    "err.exec.used": _m("This card was already processed. Please make a new order.", "이미 처리된 결재 카드예요. 주문을 새로 만들어 주세요.",
                        "该卡片已处理，请重新生成订单。"),
    "err.exec.blocked": _m("A card judged 'can't approve' can't be approved.", "결재 불가 판정을 받은 카드는 결재할 수 없어요.", "被判定为无法审批的卡片不能审批。"),
    "err.exec.superseded": _m("Your conditions changed after this card was made, so it can no longer be used.",
                              "이 카드를 만든 뒤 조건이 바뀌어서 더는 쓸 수 없어요.", "生成此卡片后条件已更改，无法再使用。"),
    "err.exec.mode": _m("This card doesn't allow the approval method you chose.", "이 카드에서는 고른 결재 방식을 쓸 수 없어요.", "此卡片不支持所选的审批方式。"),
    "err.exec.ack": _m("{note} If you've checked it, tick 'extra cost confirmed' and approve again.",
                       "{note} 확인했다면 '추가 비용 확인'을 누르고 다시 결재해 주세요.", "{note}确认后请勾选“已确认额外成本”再审批。"),
    "err.exec.interval": _m("Pick a slice interval from {opts}.", "조각 간격은 {opts} 중에서 골라 주세요.", "请从 {opts} 中选择分片间隔。"),
    "err.exec.deadline_min": _m("Set the deadline at least 1 minute from now.", "마감은 지금부터 1분 이상 뒤로 정해 주세요.", "截止时间请设在至少 1 分钟之后。"),
    "err.exec.deadline_slices": _m("To send every slice, the deadline must be more than {m} minutes away.",
                                   "조각을 모두 보내려면 마감이 {m}분 넘게 남아 있어야 해요.", "要发送所有分片，截止时间需在 {m} 分钟以上之后。"),
    "err.exec.only_split": _m("{name} can't be bought at once, so it can only be approved as split buying.",
                              "{name} 한 번에 살 수 없어 나눠 사기로만 결재할 수 있어요.", "{name}无法一次性买入，只能以分批买入方式审批。"),
    "err.exec.no_pending_sig": _m("No transactions are waiting for a signature. Please prepare the approval again.",
                                  "서명을 기다리는 거래가 없어요. 결재를 다시 준비해 주세요.", "没有等待签名的交易，请重新准备审批。"),
    "err.exec.need_all": _m("All {n} signed transactions are needed.", "서명한 거래 {n}건이 모두 필요해요.", "需要全部 {n} 笔已签名交易。"),
    "ledger.plan.prepared": _m("{label} prepared: {headline}", "{label} 준비: {headline}", "{label} 已准备：{headline}"),
    "ledger.sig_mismatch": _m("The signed transaction differed from the approval card, so it wasn't sent.",
                              "서명한 거래가 결재 카드와 달라서 보내지 않았어요.", "签名的交易与审批卡不一致，因此未发送。"),
    "ledger.presigned.slice": _m("Split buying waiting: {n} rounds over about {m} min · {headline}",
                                 "나눠 사기 대기: {n}차례에 걸쳐 약 {m}분 동안 · {headline}", "分批买入等待中：约 {m} 分钟内分 {n} 轮 · {headline}"),
    "ledger.presigned.cond": _m("Conditional order waiting: {parts} · {headline}", "조건부 주문 대기: {parts} · {headline}",
                                "条件订单等待中：{parts} · {headline}"),
    "cond.market_open": _m("once the US market opens", "미국 장이 열리고", "美国市场开盘后"),
    "cond.premium": _m("when the price gap is at most {p}%", "가격 차이가 {p}% 이하일 때", "价格差不超过 {p}% 时"),
    "cond.deadline": _m("until {t}", "{t}까지", "截至 {t}"),
    "cond.none": _m("no conditions", "조건 없음", "无条件"),
    "label.all": _m("{name} (all)", "{name} 전부", "{name} 全部"),
    "reason.prev_failed": _m("Not sent because an earlier transaction failed", "앞 거래가 실패해 보내지 않았어요", "前一笔交易失败，因此未发送"),
    "reason.chain_reset": _m("Not sent because the demo chain was restarted", "시연 체인이 다시 시작되어 보내지 않았어요", "演示链已重启，因此未发送"),
    "ledger.order.chain_reset": _m("The demo chain was restarted, so this waiting order can no longer be sent.",
                                   "시연 체인이 다시 시작되어 대기 중이던 주문은 더 이상 보낼 수 없어요.", "演示链已重启，等待中的订单无法再发送。"),
    "reason.expired_slice": _m("Not sent because the price didn't come back before the deadline", "마감까지 가격이 돌아오지 않아 보내지 않았어요",
                               "截止前价格未回到原位，因此未发送"),
    "receipt.summary": _m("{n} stock{s} filled", "{n}종목 체결", "{n}只股票成交"),
    "receipt.slices": _m("({f}/{t} slices)", "({f}/{t}조각)", "（{f}/{t}片）"),
    "cond.reason.expired": _m("The deadline has passed", "마감이 지났어요", "已过截止时间"),
    "cond.reason.closed": _m("The US market is still closed", "미국 장이 아직 닫혀 있어요", "美国市场尚未开盘"),
    "cond.reason.route": _m("Can't find a route for {name} right now", "{name} 경로를 지금 찾을 수 없어요", "目前找不到 {name} 的路径"),
    "cond.reason.premium": _m("The price gap is {p}%, above the limit", "가격 차이가 {p}%로 기준보다 커요", "价格差为 {p}%，超过标准"),
    "ledger.order.superseded": _m("Conditions changed, so the waiting order won't be used. Use Stop all to void its signatures.",
                                  "조건이 바뀌어 대기 중인 주문을 쓰지 않기로 했어요. 모두 멈추기로 서명을 무효화하세요.",
                                  "条件已更改，等待中的订单不再使用。请用“全部停止”使签名失效。"),
    "ledger.order.expired": _m("Conditions weren't met by the deadline, so the order wasn't sent.", "마감까지 조건이 맞지 않아 주문을 보내지 않았어요.",
                               "截止前条件未满足，订单未发送。"),
    "ledger.order.ready": _m("Ready to approve now: {headline}", "지금 결재할 수 있어요: {headline}", "现在可以审批：{headline}"),
    "wait.not_yet": _m("Before the next slice's time", "다음 조각 시간 전이에요", "还没到下一片的时间"),
    "wait.price": _m("The price hasn't come back near where it started yet", "가격이 아직 처음 수준 근처로 돌아오지 않았어요", "价格尚未回到初始水平附近"),
    "wait.min_out": _m("At the current price the promised minimum can't be received", "지금 가격으로는 약속한 최소 수량을 못 받아요",
                       "按当前价格无法收到承诺的最低数量"),
    "ledger.order.slice": _m("Split buying slice filled: {label}", "나눠 사기 조각 체결: {label}", "分批买入分片成交：{label}"),
    "ledger.fast_forward": _m("Demo tool: moved the next slice ({label}) up by {m} min", "시연 도구: 다음 조각({label}) 시간을 {m}분 앞당겼어요",
                              "演示工具：将下一片（{label}）提前了 {m} 分钟"),
    "ledger.watcher_error": _m("Error while watching: {e}", "감시 중 오류: {e}", "监控时出错：{e}"),
    "ledger.stop": _m("Stop all: {n} waiting order{s} cancelled", "모두 멈추기: 대기 주문 {n}건 취소", "全部停止：已取消 {n} 笔等待订单"),
    "ledger.stop.void_tx": _m(", transaction to void pre-signatures prepared", ", 사전 서명 무효화 거래 준비", "，已准备使预签名失效的交易"),
    "ledger.stop.ok": _m("Pre-signed orders were voided on chain.", "사전 서명한 주문을 체인에서 무효화했어요.", "已在链上使预签名订单失效。"),
    "ledger.stop.fail": _m("The voiding transaction failed. Please try again.", "무효화 거래가 실패했어요. 다시 시도해 주세요.", "失效交易失败，请重试。"),
    "seal.nothing": _m("No new records to seal.", "봉인할 새 기록이 없어요.", "没有需要封存的新记录。"),
    "ledger.seal": _m("Sealed {n} record{s} of {day} (part {p}).", "{day} 기록 {n}건을 봉인했어요 (봉인 {p}).", "已封存 {day} 的 {n} 条记录（第 {p} 部分）。"),

    # research
    "fact.strategy": _m("{template} approach among {sectors}, at most {{max_weight}} per stock, at least {{min_cash}} cash, rebalanced {period}",
                        "{sectors} 가운데 {template} 방식, 한 종목 최대 {{max_weight}}, 현금 {{min_cash}} 이상, {period} 비중 조정",
                        "在{sectors}中采用{template}方式，单只最多{{max_weight}}，现金至少{{min_cash}}，{period}调整比例"),
    "fact.chosen": _m("the chosen stocks", "고른 종목", "所选股票"),
    "ledger.research.failed": _m("Couldn't finish the check: {e}", "연구를 끝내지 못했어요: {e}", "未能完成回测：{e}"),
    "step.detail.conditions": _m("Conditions v{v} · {n} stock{s}", "조건 v{v} · 종목 {n}개", "条件 v{v} · {n}只股票"),
    "step.detail.data": _m("Daily bars up to {d} · source {src} (demo only)", "{d}까지 일봉 · 출처 {src} (데모 전용)", "截至 {d} 的日线 · 来源 {src}（仅限演示）"),
    "step.detail.data_missing": _m(" · no data: {m}", " · 자료 없음: {m}", " · 无数据：{m}"),
    "exec.label": _m("Can it actually be bought?", "실제로 살 수 있나", "能否实际买入"),
    "exec.ok": _m("Every chosen stock can be bought on XTXC right now at this amount.", "고른 종목 모두 지금 XTXC에서 이 금액으로 살 수 있어요.",
                  "所选股票目前都能在 XTXC 以此金额买入。"),
    "exec.excluded": _m("Stocks that are hard to buy on XTXC at this amount right now were left out of the check. ",
                        "지금 XTXC에서 이 금액으로 사기 어려운 종목은 연구에서 뺐어요. ", "目前在 XTXC 难以按此金额买入的股票已从回测中排除。"),
    "exec.sliced": _m(" Thinly traded {names} are calculated as bought in small parts over time.",
                      " 거래가 얇은 {names}은 시간을 나눠 조금씩 사는 것으로 계산했어요.", " 交易较薄的{names}按分时少量买入计算。"),
    "exec.slice_name": _m("{name} ({n} slices)", "{name}({n}조각)", "{name}（{n}片）"),
    "step.detail.no_buyable": _m("No buyable stocks", "살 수 있는 종목 없음", "没有可买入的股票"),
    "research.unbuyable": _m("No stock can be bought on XTXC at this amount right now, so the past calculation wasn't run. "
                             "Try another sector or a smaller amount.",
                             "지금 XTXC에서 이 금액으로 살 수 있는 종목이 없어서 과거 계산을 하지 않았어요. 다른 분야를 고르거나 금액을 줄여 보세요.",
                             "目前在 XTXC 没有能以此金额买入的股票，因此未进行过往计算。请换个行业或减少金额。"),
    "research.disclaimer": _m("This is a past calculation. It doesn't promise future returns.", "과거 계산이에요. 미래 수익을 약속하지 않아요.",
                              "这是过往计算，不代表未来收益。"),
    "ledger.research.blocked": _m("{title}: no buyable stocks right now, so the check stopped.", "{title}: 지금 살 수 있는 종목이 없어 연구를 멈췄어요.",
                                  "{title}：目前没有可买入的股票，回测已停止。"),
    "step.detail.costs": _m("Per-trade cost ", "한 번 거래 비용 ", "单次交易成本 "),
    "step.detail.costs_excluded": _m(" · excluded: ", " · 제외: ", " · 排除："),
    "step.detail.cache": _m("Reused an existing calculation with the same conditions (AI and compute cost 0)",
                            "같은 조건의 기존 계산을 재사용했어요 (AI·계산 비용 0)", "复用了相同条件的已有计算（AI 与计算成本为 0）"),
    "step.detail.fresh": _m("Calculated fresh", "새로 계산했어요", "重新计算"),
    "step.detail.verdict": _m("Verdict: {v}", "판정: {v}", "判定：{v}"),
    "step.detail.ai": _m("AI explanation", "AI 설명", "AI 解释"),
    "step.detail.ai_cached": _m(" (reused saved explanation)", " (저장된 설명 재사용)", "（复用已保存的解释）"),
    "step.detail.no_ai": _m("AI unavailable, so a default text was used", "AI를 쓸 수 없어 기본 문구로 대신했어요", "AI 不可用，已改用默认文字"),
    "ledger.research.done": _m("{title} check: past {y} after costs {r}, verdict {v}", "{title} 연구: 비용 뺀 과거 {y} {r}, 판정 {v}",
                               "{title} 回测：扣除成本后过去{y} {r}，判定 {v}"),
    "excl.no_route": _m("No XTXC trading route", "XTXC 거래 경로 없음", "没有 XTXC 交易路径"),
    "excl.unit": _m("Can't confirm how many shares one token is", "토큰 1개가 몇 주인지 확인 불가", "无法确认 1 枚代币对应多少股"),
    "excl.no_route_split": _m("No route to buy this amount at once, and splitting doesn't help", "이 금액을 한 번에 살 경로 없고, 나눠도 살 수 없음",
                              "没有一次性买入此金额的路径，分批也无法买入"),
    "excl.thin": _m("Thin trading moves the price {p}%, and splitting doesn't reduce it", "거래가 얇아 가격이 {p}% 움직이고, 나눠도 줄지 않음",
                    "交易较薄，价格变动 {p}%，分批也无法降低"),
    "excl.premium": _m("Token price differs from the stock by {p}%", "토큰 가격이 주가와 {p}% 차이", "代币价格与股价相差 {p}%"),
    "excl.no_close": _m("No stock price to compare", "주가와 비교할 가격 없음", "没有可对比的股价"),
    "friction.split": _m(" · assumes split buying in {n} slices", " · 나눠 사기 {n}조각 가정", " · 假设分{n}片买入"),
    "fallback.summary": _m("After costs, the past {years} result was {r}. QQQ was {b} over the same period. This is a past calculation; "
                           "it doesn't promise future returns.",
                           "비용을 뺀 과거 {years} 결과는 {r}였어요. 같은 기간 QQQ는 {b}였어요. 과거 계산이에요. 미래 수익을 약속하지 않아요.",
                           "扣除成本后，过去{years}的结果为{r}。同期 QQQ 为{b}。这是过往计算，不代表未来收益。"),
    "fallback.counter1": _m("If everything is in one sector, losses grow when that sector falls together.",
                            "한 분야에 몰려 있으면 그 분야가 함께 떨어질 때 손실이 커져요.", "如果集中在一个行业，该行业一起下跌时亏损会变大。"),
    "fallback.counter2": _m("Trend-following reacts late when the trend suddenly changes.",
                            "최근 흐름을 따라가는 방식은 흐름이 갑자기 바뀌면 늦게 반응해요.", "跟随近期走势的方式在趋势突变时反应较慢。"),

    # chat
    "chat.err.length": _m("Please keep your message within 300 characters.", "메시지는 300자 안으로 적어 주세요.", "消息请控制在 300 个字以内。"),
    "chat.err.stage": _m("Unknown step.", "알 수 없는 단계예요.", "未知的步骤。"),
    "chat.ai_down": _m("The AI can't answer right now. You can keep going with the buttons below.",
                       "지금은 AI가 답하기 어려워요. 아래 버튼으로 계속 진행할 수 있어요.", "AI 暂时无法回答，你可以用下面的按钮继续。"),
    "chat.stop": _m("Stop all waiting orders? One wallet signature voids every pre-signed order.",
                    "기다리는 주문을 모두 멈출까요? 지갑에서 한 번 서명하면 미리 서명한 주문이 모두 무효가 돼요.",
                    "要停止所有等待中的订单吗？在钱包中签名一次，所有预签名订单都会失效。"),
    "chat.new": _m("Here's what I understood. Please check the conditions card.", "이렇게 이해했어요. 조건 카드를 확인해 주세요.",
                   "我是这样理解的，请确认条件卡。"),
    "chat.new.guessed": _m(" I guessed {fields}, so please check them.", " {fields} 제가 짐작한 값이라 맞는지 봐 주세요.",
                           "{fields}是我推测的，请确认是否正确。"),
    "chat.edit.waiting": _m("Orders are waiting to fill, so conditions can't change right now. You can change them after Stop all.",
                            "주문이 체결을 기다리는 중이라 지금은 조건을 바꿀 수 없어요. 모두 멈추기를 한 뒤에 바꿀 수 있어요.",
                            "订单正在等待成交，现在无法修改条件。执行“全部停止”后即可修改。"),
    "chat.edit.refused": _m("That can't be changed: {e}", "그렇게는 바꿀 수 없어요: {e}", "无法这样修改：{e}"),
    "chat.edit.done": _m("Conditions updated: {diff}.", "조건을 바꿨어요: {diff}.", "条件已修改：{diff}。"),
    "chat.edit.recheck": _m(" Your conditions changed, so check again before making an order.", " 조건이 바뀌어서 다시 검사한 뒤에 주문을 만들 수 있어요.",
                            "条件已更改，请重新回测后再生成订单。"),
    "chat.next.brief": _m("Great. I'll confirm these conditions and check them on past data.", "좋아요. 이 조건을 확정하고 과거 데이터로 검사할게요.",
                          "好的，我会确认这些条件并用历史数据回测。"),
    "chat.next.research": _m("I'll make an approval card from the check. Nothing is bought until you approve it.",
                             "검사 결과로 주문 결재 카드를 만들게요. 만들어도 결재하기 전에는 아무것도 사지 않아요.",
                             "我会根据回测结果生成审批卡。审批之前不会买入任何东西。"),
    "chat.next.plan": _m("I'll open the approval card. Review it and slide to approve yourself. I can't approve for you.",
                         "결재 카드를 열게요. 내용을 확인하고 직접 밀어서 결재해 주세요. 제가 대신 결재할 수는 없어요.",
                         "我来打开审批卡。请确认内容后亲自滑动审批，我不能代你审批。"),
    "chat.next.waiting": _m("Here's where things stand now.", "지금 진행 상황을 보여 드릴게요.", "为你显示当前进度。"),
    "chat.next.receipt": _m("To start a new strategy, describe the investment you want in one sentence.",
                            "새 전략을 시작하려면 원하는 투자를 한 문장으로 적어 주세요.", "要开始新策略，请用一句话描述你想要的投资。"),
    "chat.waiting.default": _m("Waiting for the next check", "다음 확인을 기다려요", "等待下一次检查"),

    # glossary (term, definition)
    "g.tokenized.t": _m("Tokenized stock", "토큰화 주식", "代币化股票"),
    "g.tokenized.d": _m("A digital token built to track the value of one US share. On XTXC you buy and sell these tokens.",
                        "미국 주식 한 주의 가치를 따라가도록 만든 디지털 토큰이에요. XTXC에서는 이 토큰을 사고팔아요.",
                        "跟踪一股美国股票价值的数字代币。在 XTXC 上买卖的就是这种代币。"),
    "g.usdc.t": _m("USDC", "USDC", "USDC"),
    "g.usdc.d": _m("A digital dollar that moves with the US dollar. You pay with it when buying stock tokens.",
                   "미국 달러와 같은 가치로 움직이게 만든 디지털 달러예요. 주식 토큰을 살 때 이걸로 값을 내요.",
                   "与美元等值的数字美元。购买股票代币时用它付款。"),
    "g.sign.t": _m("Wallet signature", "지갑 서명", "钱包签名"),
    "g.sign.d": _m("Approving a transaction yourself after reading it in your wallet app. Nothing goes out without it.",
                   "내 지갑 앱에서 거래 내용을 보고 직접 승인하는 일이에요. 서명 없이는 아무것도 나가지 않아요.",
                   "在钱包应用中查看交易内容并亲自批准。没有签名，什么都不会发出。"),
    "g.card.t": _m("Approval card", "결재 카드", "审批卡"),
    "g.card.d": _m("One page showing what you buy for how much, with costs and warning signs. Slide to approve before any order is prepared.",
                   "무엇을 얼마에 사는지, 비용과 위험 신호를 한 장에 모은 확인서예요. 밀어서 결재해야 주문이 준비돼요.",
                   "一页确认单，列出买什么、花多少钱、成本和风险信号。滑动审批后才会准备订单。"),
    "g.split.t": _m("Split buying", "나눠 사기", "分批买入"),
    "g.split.d": _m("Buying a thinly traded stock all at once pushes its price up, so it's bought in parts, a little each time the price comes back.",
                    "거래가 얇은 종목을 한 번에 사면 가격이 크게 올라서, 여러 조각으로 나눠 가격이 돌아올 때마다 조금씩 사는 방식이에요.",
                    "一次性买入交易较薄的股票会推高价格，所以分成几片，每次价格回来时少量买入。"),
    "g.gap.t": _m("Price gap", "가격 차이", "价格差"),
    "g.gap.d": _m("How far the token price is from the real stock price. A big gap means you might overpay, so it's flagged.",
                  "토큰 가격이 실제 주식 가격과 얼마나 다른지예요. 차이가 크면 비싸게 살 수 있어서 주의로 표시해요.",
                  "代币价格与真实股价相差多少。差距大可能买贵，所以会标为注意。"),
    "g.presign.t": _m("Pre-signing", "미리 서명", "预签名"),
    "g.presign.d": _m("Signing now an order that is sent later when conditions are met. Stop all can void it at any time.",
                      "조건이 맞을 때 보낼 주문에 지금 서명해 두는 방식이에요. 모두 멈추기로 언제든 무효로 만들 수 있어요.",
                      "现在先签名、条件满足时再发送的订单。随时可以用“全部停止”使其失效。"),
    "g.lights.t": _m("Safety lights", "신호등", "信号灯"),
    "g.lights.d": _m("Code checks one by one: your conditions, holdings, product, price gap, cost and quote.",
                     "내 조건, 보유량, 상품 확인, 가격 차이, 비용, 견적을 코드가 하나씩 검사한 결과예요.",
                     "由代码逐项检查：你的条件、持仓、产品、价格差、成本和报价。"),
    "g.past.t": _m("Past check", "과거 검사", "历史回测"),
    "g.past.d": _m("A calculation of how this approach would have done in the past. It doesn't promise future returns.",
                   "이 방식으로 과거에 투자했다면 어땠는지 계산한 거예요. 미래 수익을 약속하지 않아요.",
                   "计算这种方式在过去会有什么结果。不代表未来收益。"),
    "g.score.t": _m("AI scorecard", "AI 성적표", "AI 成绩单"),
    "g.score.d": _m("After each fill, a record of whether the AI's predicted cost and quantity were right.",
                    "AI가 말한 예상 비용과 받을 수량이 실제로 맞았는지 체결 뒤에 채점한 기록이에요.",
                    "每次成交后，对 AI 预测的成本和数量是否准确的评分记录。"),
}

M.update({
    "eval.label.leakage": _m("Future information", "미래 정보", "未来信息"),
    "eval.label.costs": _m("Trading costs", "거래 비용", "交易成本"),
    "eval.label.holdout": _m("Last-year check", "최근 1년 확인", "最近一年检验"),
    "eval.label.survivorship": _m("Only surviving stocks", "살아남은 종목만", "仅含存续股票"),
    "eval.label.attempts": _m("Number of tries", "시도 횟수", "尝试次数"),
    "eval.unknown": _m("unknown", "알 수 없음", "未知"),
    "eval.leakage.pass": _m("It didn't use information unknown at the time. Replacing later prices with random values on {n} past dates "
                            "left that day's decisions unchanged.",
                            "그때는 알 수 없던 정보를 쓰지 않았어요. 과거 {n}개 날짜에서 그 뒤 가격을 엉터리 값으로 바꿔 봐도 그날의 결정은 그대로였어요.",
                            "没有使用当时无法知道的信息。在过去 {n} 个日期把之后的价格换成随机值，当天的决策仍然不变。"),
    "eval.leakage.fail": _m("Changing later prices changed past decisions. That means information unknown at the time leaked in, "
                            "so don't trust this result.",
                            "뒤에 올 가격을 바꾸자 과거의 결정이 달라졌어요. 그때 알 수 없던 정보가 섞여 있다는 뜻이라 이 결과는 믿으면 안 돼요.",
                            "改变之后的价格后，过去的决策也变了。说明混入了当时无法知道的信息，这个结果不可信。"),
    "eval.costs.fail": _m("Some results were calculated with zero trading costs. In reality every trade costs money, so these numbers are inflated.",
                          "거래 비용을 0으로 놓고 계산한 결과가 있어요. 실제로는 사고팔 때마다 돈이 들기 때문에 이 숫자는 부풀려져 있어요.",
                          "有些结果是按零交易成本计算的。实际上每次买卖都有成本，所以这些数字被夸大了。"),
    "eval.costs.pass": _m("Calculated after trading costs. Total return after costs is {ru} for the stocks and {rx} if bought as tokens. "
                          "Costs paid over the period were about {cu}% (stocks) and {cx}% (tokens) of the starting money.",
                          "사고팔 때 드는 비용을 빼고 계산했어요. 비용을 뺀 전체 수익은 원래 주식 기준 {ru}, 토큰으로 샀다면 {rx}예요. "
                          "기간 동안 낸 비용은 처음 돈의 약 {cu}%(주식), {cx}%(토큰)예요.",
                          "已扣除交易成本计算。扣除成本后的总收益：按股票为{ru}，按代币买入为{rx}。期间支付的成本约为初始资金的{cu}%（股票）和{cx}%（代币）。"),
    "eval.holdout.none": _m("The period isn't long enough to set aside the last year, or there's no benchmark price.",
                            "최근 1년을 따로 떼어 확인할 만큼 기간이 길지 않거나 비교 기준 가격이 없어요.",
                            "期间不够长，无法单独检验最近一年，或者没有基准价格。"),
    "eval.holdout.warn": _m("Looking at the last year alone, this strategy made {hx} (with token costs), below {bench}'s {hb} over the same period. "
                            "Lately, simply holding {bench} would have been better.",
                            "최근 1년만 따로 보면 이 전략은 {hx}(토큰 비용 반영)로, 같은 기간 {bench} {hb}보다 낮았어요. "
                            "요즘 시장에서는 전략 없이 {bench}만 사 두는 편이 나았어요.",
                            "单看最近一年，该策略为{hx}（含代币成本），低于同期{bench}的{hb}。最近直接持有{bench}会更好。"),
    "eval.holdout.pass": _m("Even looking at the last year alone, this strategy made {hx} (with token costs), above {bench}'s {hb} over the same period.",
                            "최근 1년만 따로 봐도 이 전략은 {hx}(토큰 비용 반영)로, 같은 기간 {bench} {hb}보다 높았어요.",
                            "单看最近一年，该策略为{hx}（含代币成本），高于同期{bench}的{hb}。"),
    "eval.surv": _m("This re-ran the past using only stocks you can buy as tokens today. Companies that failed or disappeared meanwhile are "
                    "missing, so it may look better than reality.",
                    "지금 토큰으로 살 수 있는 종목만 골라 과거를 다시 돌려 본 결과예요. 그사이 망하거나 사라진 회사는 빠져 있어서 실제보다 좋아 보일 수 있어요.",
                    "这是只用今天能以代币买到的股票重跑过去的结果。期间倒闭或消失的公司不在其中，所以可能比实际看起来更好。"),
    "eval.surv.late": _m(" {names} listed partway through the period, so they're included only from then on.",
                         " {names} 기간 중간에 상장해서 그 뒤부터만 들어가요.", " {names}在期间中途上市，因此只从上市后开始计入。"),
    "eval.attempts.warn": _m("You tried the same conditions {n} times. After many tweaks, a good-looking result can appear by chance, "
                             "so trust the numbers a bit less.",
                             "같은 조건으로 {n}번 시도했어요. 여러 번 바꿔 보다 보면 우연히 좋아 보이는 결과가 나오기 쉬워서, 숫자를 조금 덜 믿는 게 좋아요.",
                             "同样的条件已尝试 {n} 次。反复调整容易偶然得到好看的结果，所以对数字要少信一点。"),
    "eval.attempts.first": _m("This is the first try with these conditions. Not tweaked enough to cherry-pick a lucky result.",
                              "같은 조건으로 첫 시도예요. 우연히 좋은 결과를 골라낼 만큼 많이 바꿔 보지는 않았어요.",
                              "这是该条件的第一次尝试。调整次数不多，不至于挑出偶然的好结果。"),
    "eval.attempts.nth": _m("This is try number {n} with these conditions. Not tweaked enough to cherry-pick a lucky result.",
                            "같은 조건으로 {n}번째 시도예요. 우연히 좋은 결과를 골라낼 만큼 많이 바꿔 보지는 않았어요.",
                            "这是该条件的第 {n} 次尝试。调整次数不多，不至于挑出偶然的好结果。"),
})

# AI 전략 설계 + 격리 실행
M.update({
    "template.ai": _m("Designed by the AI", "AI가 새로 설계", "AI新设计"),
    "step.design": _m("AI designs candidates", "AI가 전략 후보 설계", "AI设计候选策略"),
    "step.isolated": _m("Isolated runs pick one", "격리 실행으로 후보 비교", "隔离运行比较候选"),
    "step.detail.design": _m("{n} candidates written in building blocks (no code); code checked every rule",
                             "부품으로 쓴 후보 {n}개 (코드 아님), 모든 규칙을 코드가 검사했어요", "用组件写成的{n}个候选（不是代码），所有规则由代码检查"),
    "step.detail.isolated": _m("Chose “{name}” out of {n} on the earlier years only ({mode}, {s} s)",
                               "앞선 기간만으로 {n}개 중 “{name}”을 골랐어요 ({mode}, {s}초)", "只用较早的年份从{n}个中选出“{name}”（{mode}，{s}秒）"),
    "step.detail.isolated_bt": _m(" · in the isolated runner", " · 격리 실행기에서", " · 在隔离运行器中"),
    "design.ai_failed": _m("The AI couldn't design a valid strategy this time. Try again, or pick one of the ready-made methods.",
                           "이번에는 AI가 규칙에 맞는 전략을 설계하지 못했어요. 다시 시도하거나 준비된 방식 중 하나를 골라 주세요.",
                           "这次AI没能设计出符合规则的策略。请重试，或选择一种现成的方法。"),
    "paper.extended": _m(" Sessions from {d0} to {d1} are valued with the tokens' own closing trades (the verified daily prices end before).",
                         " {d0}~{d1} 거래일은 토큰의 종가 무렵 체결 가격으로 평가했어요 (검증된 일봉은 그 전까지).",
                         " {d0}至{d1}的交易日用代币收盘时的成交价格估值（经过验证的日线截至此前）。"),
    "chat.edit.same": _m("Those are already your conditions, so nothing changed.", "이미 그 조건으로 되어 있어서 바꾼 게 없어요.",
                         "条件本来就是这样，所以没有改动。"),
    "design.rule": _m("Candidates are compared only on the earlier years; the last year is kept aside to check the choice.",
                      "후보는 앞선 기간으로만 비교하고, 최근 1년은 고른 뒤 확인용으로 남겨 둬요.", "只用较早的年份比较候选，最近一年留作选择后的检验。"),
    "ledger.strategy.designed": _m("AI designed {n} candidates; chose {name} in the isolated runner",
                                   "AI 전략 설계: 후보 {n}개 중 {name} (격리 실행)", "AI设计了{n}个候选，在隔离运行中选出{name}"),
    "dz.mode.service": _m("isolated service", "격리 서비스", "隔离服务"),
    "dz.mode.process": _m("isolated process", "격리 프로세스", "隔离进程"),
    "dz.days": _m("{n} trading days", "{n}거래일", "{n}个交易日"),
    "dz.sig.momentum": _m("return over {span}", "{span} 수익률", "{span}收益率"),
    "dz.sig.volatility": _m("swings over {span}", "{span} 흔들림", "{span}波动"),
    "dz.sig.trend": _m("price vs its {span} average", "{span} 평균 대비 가격", "相对{span}均价的价格"),
    "dz.sig.drawdown": _m("distance from the {span} high", "{span} 최고가 대비 하락", "距{span}高点的跌幅"),
    "dz.sig.sharpe": _m("return per unit of swing over {span}", "{span} 흔들림 대비 수익", "{span}单位波动收益"),
    "dz.sig.rsi": _m("RSI over {span}", "{span} RSI", "{span} RSI"),
    "dz.sig.zscore": _m("Bollinger position over {span}", "{span} 볼린저 밴드 위치", "{span}布林带位置"),
    "dz.sig.ma_cross": _m("{fast} average vs {span} average", "{span} 평균 대비 {fast} 평균", "{fast}均线相对{span}均线"),
    "dz.sig.earnings_yield": _m("earnings yield", "이익수익률(PER 역수)", "盈利收益率"),
    "dz.sig.book_to_price": _m("book-to-price", "장부가 대비 가격(PBR 역수)", "账面市值比"),
    "dz.sig.fcf_yield": _m("free-cash-flow yield", "잉여현금흐름 수익률", "自由现金流收益率"),
    "dz.sig.roe": _m("return on equity", "자기자본이익률(ROE)", "净资产收益率"),
    "dz.sig.debt_to_equity": _m("debt to equity", "부채비율", "负债权益比"),
    "dz.sig.revenue_growth": _m("revenue growth", "매출 성장률", "营收增长率"),
    "dz.sig.dividend_yield": _m("dividend yield", "배당수익률", "股息率"),
    "dz.sig.ebitda_yield": _m("EBITDA yield (EV/EBITDA inverted)", "EBITDA 수익률(EV/EBITDA 역수)", "EBITDA收益率"),
    "dz.sig.earnings_yield_vs_sector": _m("earnings yield vs its sector", "업종 대비 이익수익률", "相对行业的盈利收益率"),
    "dz.sig.book_to_price_vs_sector": _m("book-to-price vs its sector", "업종 대비 장부가 비율", "相对行业的账面市值比"),
    "dz.sig.volume_surge": _m("recent volume vs usual", "평소 대비 최근 거래량", "近期成交量相对常态"),
    "dz.sig.dollar_volume": _m("daily dollars traded", "하루 거래대금", "日成交额"),
    "dz.sig.rel_strength": _m("return vs the Nasdaq-100 over {span}", "{span} 나스닥100 대비 수익률", "{span}相对纳斯达克100的收益"),
    "dz.sig.money_flow": _m("money flow (20 days)", "자금 흐름(20일)", "资金流向（20天）"),
    "dz.sig.sector_momentum": _m("its sector's three-month return", "업종 3개월 수익률", "所属行业三个月收益"),
    "dz.sig.sector_money_flow": _m("money flow into its sector (20 days)", "업종 자금 흐름(20일)", "行业资金流向（20天）"),
    "dz.sig.breakout": _m("close vs the highest close of the previous {span}", "직전 {span} 최고 종가 대비 종가", "相对前{span}最高收盘价的收盘价"),
    "dz.sig.squeeze": _m("swings of the last two weeks vs the past {span}", "{span} 대비 최근 2주 변동폭", "最近两周波动相对{span}波动"),
    "dz.sig.higher_lows": _m("share of rising highs and lows over {span}", "{span} 고점·저점 상승 비율", "{span}高点低点抬升比例"),
    "dz.sig.double_bottom": _m("close vs the double-bottom neckline ({span})", "쌍바닥 목선 대비 종가({span})", "相对双底颈线的收盘价（{span}）"),
    "dz.breadth": _m("when fewer than {b} of the stocks are above their {span} average, invest only {e} of the usual amount",
                     "{span} 평균 위에 있는 종목이 {b}보다 적으면 평소의 {e}만 투자", "当高于{span}均线的股票少于{b}时，只投入平时的{e}"),
    "dz.macro.below": _m("falls below", "아래로 내려가면", "低于"),
    "dz.macro.above": _m("rises above", "위로 올라가면", "高于"),
    "dz.macro.IPG3344S": _m("when US semiconductor production's change over {n} months {dir} {v}, semiconductor makers get {e} of their weight",
                            "미국 반도체 생산지수의 {n}개월 변화율이 {v} {dir} 반도체 기업 비중을 {e}로 줄임",
                            "当美国半导体产量{n}个月变化{dir}{v}时，半导体企业权重降为{e}"),
    "dz.macro.RSAFS": _m("when US retail sales' change over {n} months {dir} {v}, consumer companies get {e} of their weight",
                         "미국 소매판매의 {n}개월 변화율이 {v} {dir} 소비재 기업 비중을 {e}로 줄임",
                         "当美国零售销售{n}个月变化{dir}{v}时，消费企业权重降为{e}"),
    "dz.macro.DCOILWTICO": _m("when the WTI oil price's change over {n} trading days {dir} {v}, energy companies get {e} of their weight",
                              "WTI 유가의 {n}거래일 변화율이 {v} {dir} 에너지 기업 비중을 {e}로 줄임",
                              "当WTI油价{n}个交易日变化{dir}{v}时，能源企业权重降为{e}"),
    "dz.macro.DTWEXBGS": _m("when the broad US dollar index's change over {n} trading days {dir} {v}, every stock gets {e} of its weight",
                            "달러지수의 {n}거래일 변화율이 {v} {dir} 전 종목 비중을 {e}로 줄임",
                            "当美元广义指数{n}个交易日变化{dir}{v}时，所有股票权重降为{e}"),
    "dz.hold": _m("keeps a holding while it ranks within {x} times the number of holdings", "보유 종목은 보유 수의 {x}배 순위 안이면 유지",
                  "持仓排名在持仓数的{x}倍以内时继续持有"),
    "dz.exit.stop": _m("sells a holding {v} below its purchase price", "매수가보다 {v} 내리면 매도", "低于买入价{v}时卖出"),
    "dz.exit.trail": _m("sells a holding {v} below its highest close since purchase", "매수 후 최고가보다 {v} 내리면 매도",
                        "低于买入后最高收盘价{v}时卖出"),
    "dz.skip": _m(" (leaving out the last {span})", " (최근 {span} 제외)", "（不含最近{span}）"),
    "dz.term.pos": _m("{sig} — higher is better, weight {w}", "{sig} — 높을수록 좋음, 비중 {w}", "{sig} — 越高越好，权重{w}"),
    "dz.term.neg": _m("{sig} — lower is better, weight {w}", "{sig} — 낮을수록 좋음, 비중 {w}", "{sig} — 越低越好，权重{w}"),
    "dz.filter.above": _m("only stocks whose {sig} is above {v}", "{sig}이 {v}보다 높은 종목만", "只保留{sig}高于{v}的股票"),
    "dz.filter.below": _m("only stocks whose {sig} is below {v}", "{sig}이 {v}보다 낮은 종목만", "只保留{sig}低于{v}的股票"),
    "dz.filter.entry": _m(" (checked when buying)", " (매수할 때만 확인)", "（仅在买入时检查）"),
    "dz.filter.top_fraction": _m("the top {p} by {sig}", "{sig} 상위 {p}", "{sig}最高的{p}"),
    "dz.filter.bottom_fraction": _m("the lowest {p} by {sig}", "{sig} 하위 {p}", "{sig}最低的{p}"),
    "dz.top": _m("the best {n}", "상위 {n}종목", "最好的{n}只"),
    "dz.top.auto": _m("as many as the caps need", "한도를 채우는 만큼", "按上限需要的数量"),
    "dz.w.equal": _m("equal amounts", "같은 금액씩", "等额"),
    "dz.w.rank": _m("more for higher ranks", "순위가 높을수록 더", "排名越高越多"),
    "dz.w.inverse_volatility": _m("more for calmer stocks", "덜 흔들리는 종목에 더", "越平稳越多"),
    "dz.risk_off": _m("when {t}'s {sig} is below {v}, invest only {e} of the usual amount", "{t}의 {sig}이 {v}보다 낮으면 평소의 {e}만 투자",
                      "当{t}的{sig}低于{v}时，只投入平时的{e}"),
    "eval.label.design": _m("Designed within the rules", "설계 규칙 확인", "设计规则检查"),
    "eval.label.selection": _m("The untouched last year", "고르지 않은 최근 1년", "未用于选择的最近一年"),
    "eval.label.robustness": _m("Small changes to settings", "설정을 조금 바꾸면", "稍改设置"),
    "eval.design.pass": _m("The AI wrote {n} candidates in building blocks, not code. Code checked every rule, each ran in the isolated "
                           "runner, and the chosen one kept the per-stock cap and cash floor at every rebalance.",
                           "AI가 코드가 아닌 부품으로 후보 {n}개를 썼어요. 모든 규칙을 코드가 검사했고, 각각 격리 실행기에서 돌렸으며, 고른 전략은 "
                           "모든 조정 때 한 종목 한도와 현금 비중을 지켰어요.",
                           "AI用组件（不是代码）写了{n}个候选。所有规则由代码检查，每个都在隔离运行器中运行，选中的策略在每次调仓时都遵守了单只上限和现金比例。"),
    "eval.selection.pass": _m("Chosen on the earlier years (return per unit of risk {a}); in the last year, which was not used to choose, it was {b}.",
                              "앞선 기간으로 골랐고(위험 대비 수익 {a}), 고를 때 쓰지 않은 최근 1년에는 {b}였어요.",
                              "依据较早年份选出（风险调整收益{a}）；在未用于选择的最近一年为{b}。"),
    "eval.selection.warn": _m("Chosen on the earlier years (return per unit of risk {a}), but in the untouched last year it fell to {b}. "
                              "The pick may have been luck.",
                              "앞선 기간에서는 위험 대비 수익 {a}였지만, 고를 때 쓰지 않은 최근 1년에는 {b}로 떨어졌어요. 운이었을 수 있어요.",
                              "在较早年份风险调整收益为{a}，但在未用于选择的最近一年降到{b}。选中可能是运气。"),
    "eval.selection.none": _m("Not enough data to check the choice on an untouched year.", "고르지 않은 기간으로 확인할 데이터가 부족해요.",
                              "没有足够的数据在未使用的年份上检验。"),
    "eval.robust.pass": _m("With every period a quarter shorter or longer, return per unit of risk stayed between {lo} and {hi} (as designed: {b}).",
                           "모든 기간을 4분의 1 짧게·길게 바꿔도 위험 대비 수익이 {lo}~{hi}였어요 (설계대로: {b}).",
                           "把所有期间缩短或延长四分之一，风险调整收益仍在{lo}至{hi}之间（原设计：{b}）。"),
    "eval.robust.warn": _m("With every period a quarter shorter or longer, return per unit of risk moved to {lo}–{hi} (as designed: {b}). "
                           "The result depends on the exact settings.",
                           "모든 기간을 4분의 1 짧게·길게 바꾸면 위험 대비 수익이 {lo}~{hi}로 바뀌어요 (설계대로: {b}). 정확한 설정값에 기대는 결과예요.",
                           "把所有期间缩短或延长四分之一，风险调整收益变为{lo}至{hi}（原设计：{b}）。结果依赖具体设置。"),
    "eval.robust.none": _m("The changed settings couldn't be tested.", "바꾼 설정으로 검사하지 못했어요.", "无法用改动后的设置检验。"),
})


# 변동 예측 (volatility forecast)
M.update({
    "unit.hours": _m("{n} hour{s}", "{n}시간", "{n}小时"),
    "hz.h": _m("{n} hour{s}", "{n}시간", "{n}小时"),
    "hz.1d": _m("1 day (incl. tonight)", "1일 (밤사이 포함)", "1天（含今晚）"),
    "hz.d": _m("{n} trading day{s}", "{n}거래일", "{n}个交易日"),
    "hz.w": _m("{n} week{s}", "{n}주", "{n}周"),
    "hz.m": _m("{n} month{s}", "{n}개월", "{n}个月"),
    "hz.y": _m("{n} year{s}", "{n}년", "{n}年"),
    "fc.ask.horizon": _m("How long do you plan to hold {names}? Pick a period and I'll show how far the price may move over it "
                         "and what buying and selling would cost, checked on past data. For a period that isn't a button "
                         "(e.g. 2 weeks, 18 months), just type it.",
                         "{names} 얼마나 오래 가지고 있을 생각이세요? 기간을 고르면 그동안 가격이 얼마나 오르내릴 수 있는지와 "
                         "사고팔 때 드는 비용을 과거 데이터로 검증해서 보여 드릴게요. 버튼에 없는 기간(예: 2주, 18개월)은 직접 써 주세요.",
                         "你打算持有{names}多久？选好期间后，我会用过去的数据检验并告诉你这段时间价格可能的波动范围以及买卖成本。"
                         "按钮里没有的期间（例如2周、18个月）直接输入即可。"),
    "fc.ask.tickers": _m("Which stocks should I look at? Type up to {n} names or tickers.",
                         "어떤 종목을 볼까요? 종목 이름이나 티커를 {n}개까지 써 주세요.",
                         "要看哪些股票？请输入最多{n}个股票名称或代码。"),
    "fc.ready": _m("Here is the forecast for {h}.", "{h} 예측이에요.", "这是{h}的预测。"),
    "fc.cancel": _m("OK, back to where you were.", "알겠어요. 하던 곳으로 돌아갈게요.", "好的，回到刚才的步骤。"),
    "fc.err.tickers": _m("Name at least one stock.", "종목을 하나 이상 알려 주세요.", "请至少说出一只股票。"),
    "fc.err.unknown": _m("{t} isn't one of the stocks XTXC routes.", "{t}는 XTXC에서 거래하는 종목이 아니에요.", "{t}不在XTXC可交易的股票中。"),
    "fc.err.too_many": _m("Up to {n} stocks at a time.", "한 번에 {n}종목까지 볼 수 있어요.", "一次最多看{n}只股票。"),
    "fc.err.horizon": _m("Pick a period between 1 hour and 3 years.", "1시간에서 3년 사이로 골라 주세요.", "请选择1小时到3年之间的期间。"),
    "fc.err.size": _m("The amount must be between $10 and $1,000,000.", "금액은 $10에서 $1,000,000 사이여야 해요.", "金额须在10美元到100万美元之间。"),
    "fc.err.not_found": _m("Couldn't find that forecast.", "그 예측을 찾지 못했어요.", "找不到该预测。"),
    "fc.err.no_prices": _m("The verified price data isn't ready yet.", "검증된 가격 데이터가 아직 준비되지 않았어요.", "经过验证的价格数据尚未就绪。"),
    "fc.model.token": _m("Token trades, hour by hour", "토큰 시간별 체결", "代币逐小时成交"),
    "fc.model.offhours": _m("Price history + token trades while the US market is closed", "가격 이력 + 미국 장이 닫힌 동안의 토큰 체결",
                            "价格历史 + 美股休市期间的代币成交"),
    "fc.model.price": _m("Price history since 2010 — {method}", "2010년부터의 가격 이력 — {method}", "2010年以来的价格历史 — {method}"),
    "fc.method.har": _m("a model of the last day's, week's, month's, quarter's and year's swings together",
                        "최근 하루·1주·1개월·3개월·1년 흔들림을 함께 보는 모델", "综合最近一天、一周、一个月、三个月和一年波动的模型"),
    "fc.method.hist": _m("last year's swings as they are", "지난 1년 흔들림을 그대로 쓰는 방법", "直接沿用过去一年的波动"),
    "fc.method.ewma": _m("recent swings weighted most", "최근 흔들림일수록 크게 반영하는 방법", "越近的波动权重越大的方法"),
    "fc.method.ewma_token": _m("recent token swings as they are", "최근 토큰 흔들림을 그대로 쓰는 방법", "直接沿用近期代币波动"),
    "fc.bt.simple_won": _m("For this period the simpler method did better, so it's the one used.", "이 기간에는 단순한 방법이 더 나아서 그 방법을 썼어요.",
                           "在这个期间，较简单的方法表现更好，因此采用了它。"),
    "fc.dip.check": _m("Dip check: the fall went past the bad case {r} of the time over {n} past windows (target 10%).",
                       "최저점 검증: 과거 {n}번 중 나쁜 경우보다 더 떨어진 비율 {r} (목표 10%).", "最低点检验：过去{n}次中跌破较差情况的比例为{r}（目标10%）。"),
    "fc.short_history": _m("Listed recently ({n} trading days of history), so the forecast leans on a short record.",
                           "상장한 지 얼마 안 돼서 ({n}거래일 이력) 짧은 기록으로 예측했어요.", "上市时间不长（{n}个交易日的历史），预测依据的记录较短。"),
    "fc.model.none": _m("No data", "데이터 없음", "无数据"),
    "fc.no_token_data": _m("{name}: no token trades recorded yet.", "{name}: 아직 기록된 토큰 체결이 없어요.", "{name}：尚无代币成交记录。"),
    "fc.no_price_data": _m("{name}: not enough verified price history.", "{name}: 검증된 가격 이력이 부족해요.", "{name}：经过验证的价格历史不足。"),
    "fc.ref.token": _m("token price at {at}", "{at} 토큰 가격", "{at}的代币价格"),
    "fc.ref.close": _m("closing price on {d}", "{d} 종가", "{d}收盘价"),
    "fc.ref.implied": _m("{d} close moved by the token since then ({move})", "{d} 종가에 그 뒤 토큰 움직임({move})을 더한 가격",
                         "{d}收盘价加上之后代币的变动（{move}）"),
    "fc.headline": _m("{name}, {h}: likely between {lo} and {hi} ({lop} to {hip}).",
                      "{name} · {h}: {lo} ~ {hi} 사이일 가능성이 높아요 ({lop} ~ {hip}).",
                      "{name} · {h}：大概率在{lo}至{hi}之间（{lop}至{hip}）。"),
    "fc.bt.cover": _m("Checked on {n} past cases the model hadn't seen: the real price ended inside the range {cov} of the time (target 80%).",
                      "모델이 보지 않은 과거 {n}번으로 검증했어요. 실제 가격이 범위 안에 든 비율은 {cov}였어요 (목표 80%).",
                      "用模型未见过的{n}个过去案例检验：实际价格落在区间内的比例为{cov}（目标80%）。"),
    "fc.bt.none": _m("Not enough past data to check this yet.", "아직 검증할 과거 데이터가 부족해요.", "目前还没有足够的过去数据来检验。"),
    "fc.bt.base": _m("Compared with {base}: inside {c0}, range width {w0} → this model: inside {c1}, width {w1}.",
                     "{base}과 비교: 적중 {c0}, 범위 폭 {w0} → 이 모델: 적중 {c1}, 범위 폭 {w1}.",
                     "与{base}相比：命中{c0}，区间宽度{w0} → 本模型：命中{c1}，宽度{w1}。"),
    "fc.bt.overlap": _m("Long periods like {h} overlap a lot in the past ({y0}–{y1}); counted without overlap there are about {n} separate windows.",
                        "{h}처럼 긴 기간은 과거 구간이 많이 겹쳐요 ({y0}–{y1}). 겹치지 않게 세면 약 {n}개 구간이에요.",
                        "像{h}这样的长期间，过去的区间重叠很多（{y0}–{y1}）；不重叠地计算约有{n}个区间。"),
    "fc.exec.compare": _m("Execution data test ({n} nights and weekends): price history alone — inside {c0}, width {w0}, score {s0}; "
                          "with token trades since the close — inside {c1}, width {w1}, score {s1} (score = width plus a penalty for "
                          "misses; lower is better).",
                          "실행 데이터 검증 (밤·주말 {n}번): 가격 이력만 — 적중 {c0}, 범위 폭 {w0}, 점수 {s0} / 장 마감 뒤 토큰 체결 추가 — "
                          "적중 {c1}, 범위 폭 {w1}, 점수 {s1} (점수는 범위 폭에 빗나간 만큼 벌점을 더한 값, 낮을수록 좋아요).",
                          "执行数据检验（夜间和周末{n}次）：仅价格历史 — 命中{c0}，宽度{w0}，得分{s0}；加入收盘后的代币成交 — 命中{c1}，宽度{w1}，"
                          "得分{s1}（得分 = 区间宽度 + 落空惩罚，越低越好）。"),
    "fc.bt.cover_offhours": _m("Checked on {n} past nights and weekends the model hadn't seen: the real close ended inside the range {cov} of the time (target 80%).",
                               "모델이 보지 않은 과거 밤·주말 {n}번으로 검증했어요. 실제 종가가 범위 안에 든 비율은 {cov}였어요 (목표 80%).",
                               "用模型未见过的{n}个过去夜间和周末检验：实际收盘价落在区间内的比例为{cov}（目标80%）。"),
    "fc.exec.used": _m("So this forecast uses the token trades.", "그래서 이 예측은 토큰 체결을 반영했어요.", "因此本预测采用了代币成交数据。"),
    "fc.exec.not_better": _m("The token trades didn't improve it yet, so this forecast uses price history only.",
                             "아직은 토큰 체결이 예측을 개선하지 못해서, 가격 이력만 썼어요.", "代币成交数据目前还没有带来改进，因此本预测只用价格历史。"),
    "fc.exec.not_now": _m("The US market isn't in its overnight window right now, so price history is used.",
                          "지금은 장 마감 뒤~다음 개장 전 시간이 아니라서 가격 이력으로 예측했어요.", "现在不在收盘后到下次开盘前的时段，因此使用价格历史。"),
    "fc.exec.building": _m("Execution data is still building up for this check.", "이 검증에 쓸 실행 데이터가 아직 쌓이는 중이에요.", "用于此检验的执行数据仍在积累中。"),
    "fc.dip": _m("While holding, the lowest point is typically {typ} from your buy price; in a bad case (1 in 10) {bad}.",
                 "보유하는 동안 가장 낮을 때는 보통 산 가격보다 {typ}, 나쁜 경우(10번 중 1번) {bad}까지 내려갔어요.",
                 "持有期间，最低点通常比买入价{typ}；较差情况（十次中一次）为{bad}。"),
    "fc.cost.now": _m("Buying {size} of the token now costs about {bps} ({money}), from a quote {age} ago.",
                      "지금 토큰을 {size}어치 사면 약 {bps}({money})의 비용이 들어요 ({age} 전 호가).",
                      "现在买入{size}的代币，成本约{bps}（{money}），依据{age}前的报价。"),
    "fc.cost.extrap": _m(" That's bigger than the largest recorded quote, so it's an estimate.", " 기록된 가장 큰 호가보다 커서 추정치예요.",
                         " 金额超过已记录的最大报价，所以是估计值。"),
    "fc.cost.range": _m("Last {d} days: {lo} to {hi} ({n} quotes).", "최근 {d}일: {lo} ~ {hi} (호가 {n}번).", "最近{d}天：{lo}至{hi}（{n}次报价）。"),
    "fc.cost.range2": _m("Last {d} days: {lo} to {hi}; typically {o} while the US market is open and {c} while it's closed.",
                         "최근 {d}일: {lo} ~ {hi}. 미국 장이 열려 있을 때 보통 {o}, 닫혀 있을 때 {c}.",
                         "最近{d}天：{lo}至{hi}；美股开市时通常{o}，休市时{c}。"),
    "fc.cost.round": _m("Buying now and selling after {h}: about {bps} in total ({money}), up to {hi} in a costly case.",
                        "지금 사서 {h} 뒤에 팔면 합쳐서 약 {bps}({money}), 비쌀 때는 {hi}까지 들어요.",
                        "现在买入并在{h}后卖出：合计约{bps}（{money}），较贵时可达{hi}。"),
    "fc.cost.none": _m("No quotes recorded yet for this token; the recorder adds them around the clock.",
                       "이 토큰은 아직 기록된 호가가 없어요. 기록기가 24시간 계속 쌓고 있어요.", "该代币尚无报价记录；记录器正全天候持续积累。"),
    "fc.prem": _m("Token vs stock at the close: {now} last time; over {n} sessions between {lo} and {hi}.",
                  "종가 때 토큰과 주식의 가격 차이: 최근 {now}, 지난 {n}거래일 동안 {lo} ~ {hi}.",
                  "收盘时代币与股票的价差：最近{now}；过去{n}个交易日在{lo}至{hi}之间。"),
    "fc.prem.scaled": _m("This token's unit isn't one share, so the price gap isn't shown.", "이 토큰은 1개가 1주가 아니라서 가격 차이는 보여 드리지 않아요.",
                         "该代币1枚不等于1股，因此不显示价差。"),
    "fc.thin": _m("This token trades rarely ({n} hours with trades in the last day), so its price can lag.",
                  "이 토큰은 거래가 드물어요 (최근 하루 중 체결 있던 시간 {n}시간). 가격이 늦게 따라올 수 있어요.",
                  "该代币交易稀少（最近一天有成交的小时数：{n}），价格可能滞后。"),
    "fc.stale": _m("Verified price history ends on {d}; the move since then comes from the token's trades.",
                   "검증된 가격 이력은 {d}까지예요. 그 뒤 움직임은 토큰 체결로 이어 붙였어요.", "经过验证的价格历史截至{d}；之后的变动来自代币成交。"),
    "fc.data": _m("Data: verified prices up to {as_of}; {bars} hourly token bars ({first} to {last}); {quotes} quotes recorded by XTXC.",
                  "데이터: 검증된 가격 {as_of}까지 · 토큰 시간봉 {bars}개 ({first} ~ {last}) · XTXC가 기록한 호가 {quotes}건.",
                  "数据：经过验证的价格截至{as_of}；代币小时K线{bars}根（{first}至{last}）；XTXC记录的报价{quotes}条。"),
    "fc.extended": _m("The verified daily prices end before {d0}; the {n} session{s} from {d0} to {d1} continue with the token's own closing trades.",
                      "검증된 일봉은 {d0} 전까지예요. {d0}~{d1} {n}거래일은 토큰의 종가 무렵 체결 가격으로 이어 붙였어요.",
                      "经过验证的日线截至{d0}之前；{d0}至{d1}的{n}个交易日用代币收盘时的成交价格衔接。"),
    "fc.claim": _m("{name} after {h}: between {lo} and {hi} (80% range)", "{name} {h} 뒤: {lo} ~ {hi} 사이 (80% 범위)",
                   "{name} {h}后：在{lo}至{hi}之间（80%区间）"),
    "fc.stockmesh": _m("XTXC's real orders (StockMesh journal, mainnet): {n} orders, {sent} sent, {f} filled ({u} expired before sending, {x} sent but not filled).",
                       "XTXC 실제 주문 기록(StockMesh, 메인넷): 주문 {n}건 중 보낸 {sent}건, 체결 {f}건 (보내기 전 만료 {u}건, 보냈지만 미체결 {x}건).",
                       "XTXC真实订单记录（StockMesh，主网）：{n}笔订单，已发送{sent}笔，成交{f}笔（发送前过期{u}笔，已发送未成交{x}笔）。"),
    "fc.stockmesh.slip": _m(" Received vs quoted on the {m} filled: median {med} bps, worst {worst} bps.",
                            " 체결된 {m}건은 호가보다 받은 수량이 중앙값 {med}bp, 가장 나쁠 때 {worst}bp 차이였어요.",
                            " 已成交的{m}笔，实际收到数量相对报价：中位数{med}bp，最差{worst}bp。"),
    "fc.stockmesh.not_yet": _m(" With {m} measured fills it is shown only; from {k} fills it widens the cost range.",
                               " 아직 {m}건이라 보여 주기만 하고, {k}건부터 비용 범위 보정에 써요.", " 目前只有{m}笔，仅作展示；满{k}笔后用于修正成本区间。"),
    "fc.stockmesh.used": _m(" It widens the cost range by the bad-case gap between quote and fill.", " 호가와 실제 체결의 나쁜 경우 차이만큼 비용 범위를 넓혀요.",
                            " 按报价与实际成交的较差差距扩大成本区间。"),
    "fc.stockmesh.ticker": _m("{t} real orders: {m} filled, received vs quoted median {med} bps.", "{t} 실제 주문: 체결 {m}건, 호가 대비 받은 수량 중앙값 {med}bp.",
                              "{t}真实订单：成交{m}笔，实际收到相对报价中位数{med}bp。"),
    "fc.own_fills": _m("Our own fills so far: {n} on the {net} (not used in this forecast).",
                       "지금까지 우리 체결 기록: {net}에서 {n}건 (이 예측에는 쓰지 않았어요).", "目前我们自己的成交记录：{net}上{n}笔（本预测未使用）。"),
    "fc.net.localnet": _m("demo chain", "시연용 체인", "演示链"),
    "fc.net.mainnet": _m("main network", "메인넷", "主网"),
    "fc.disclaimer": _m("A range, not a promise: in the past the price ended outside it about 1 time in 5. Not a recommendation to buy or sell.",
                        "약속이 아니라 범위예요. 과거에도 5번 중 1번쯤은 범위 밖으로 나갔어요. 사거나 팔라는 추천이 아니에요.",
                        "这是区间而非承诺：过去大约每5次就有1次落在区间外。并非买卖建议。"),
    "err.brief.is_forecast": _m("That's a question about how much stocks may move. Ask it in the chat and I'll forecast it.",
                                "종목이 얼마나 움직일지에 대한 질문이에요. 대화창에서 물어보면 예측해 드릴게요.", "这是关于股票可能波动多少的问题。请在对话中提问，我会为你预测。"),
    "ledger.forecast": _m("Forecast: {names}, {h}", "변동 예측: {names}, {h}", "波动预测：{names}，{h}"),
})


GLOSSARY_KEYS = ("tokenized", "usdc", "sign", "card", "split", "gap", "presign", "lights", "past", "score")


def glossary() -> dict[str, str]:
    return {tr(f"g.{k}.t"): tr(f"g.{k}.d") for k in GLOSSARY_KEYS}


def missing_translations() -> list[str]:
    """Keys whose languages do not all exist or whose {params} differ (used by tests)."""
    import string
    bad = []
    fmt = string.Formatter()
    for key, entry in M.items():
        if set(entry) != set(LANGS):
            bad.append(key)
            continue
        fields = [{f for _, f, _, _ in fmt.parse(entry[lg]) if f} for lg in LANGS if entry[lg]]
        if any(f - {"s"} != fields[0] - {"s"} for f in fields[1:]) and not key.startswith(("imm.", "ger.", "stem.", "verb.")):
            bad.append(key)
    return bad
