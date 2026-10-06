"""
collect_multi_frequency.py — Man Group Multi-Frequency Data Pipeline for XTXC 58

계층형 타임프레임 아키텍처:
- Tier 1 (8종목): 5분봉 (5m, 60일) — 초고변동성 & 크립토 연동주
- Tier 2 (6종목): 5분봉 (5m, 60일) — 온체인 24/7 비상장/특수 토큰
- Tier 3 (20종목): 1시간봉 (1h, 730일) — 지수 ETF & 메가캡 테크/반도체
- Tier 4 (24종목): 일봉 (1D, 5년+) — 가치주/방어주/헬스케어 (기존 xtxc_58_universe 유지)
"""

import os
import sys
import math
import numpy as np
import pandas as pd
from pathlib import Path
from datetime import datetime
import yfinance as yf
import arcticdb as adb

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

TIER1_SYMBOLS = ["NVDA", "TSLA", "MSTR", "COIN", "HOOD", "BMNR", "GME", "TQQQ"]
TIER2_SYMBOLS = ["SPCX", "CRCL", "STRC", "DFDV", "VIDA", "AMBR"]
TIER3_SYMBOLS = [
    "SPY", "QQQ", "VTI", "SLV",
    "AAPL", "GOOGL", "AMZN", "META", "NFLX", "ORCL", "UBER",
    "AMD", "AVGO", "ASML", "INTC", "MU", "MRVL", "TSM", "PLTR", "CSCO"
]
TIER4_SYMBOLS = [
    "BRK.B", "JPM", "V", "MA",
    "LLY", "NVO", "PFE", "MRNA", "AZN", "JNJ", "ABT", "UNH", "TMO",
    "WMT", "KO", "PEP", "PG", "F", "XOM", "CVX", "LIN", "ACN", "CMCSA", "IBM"
]

TICKER_MAP = {"BRK.B": "BRK-B"}

def engineer_intraday_features(df: pd.DataFrame, freq_name: str = "5m") -> pd.DataFrame:
    df = df.copy().sort_values("datetime").reset_index(drop=True)
    df["log_return"] = np.log(df["close"] / df["close"].shift(1))

    # 롤링 변동성 (5분봉: 78개 봉 = 1거래일 6.5시간)
    window = 78 if freq_name == "5m" else 24
    df[f"volatility_{freq_name}"] = df["log_return"].rolling(window=window).std() * math.sqrt(252 * (78 if freq_name == "5m" else 7))
    df["dollar_volume"] = df["close"] * df["volume"]

    # 누적 거래대금 가중 평균가 (일중 VWAP)
    df["date_group"] = df["datetime"].dt.date
    cum_pv = df.groupby("date_group").apply(lambda g: (g["close"] * g["volume"]).cumsum(), include_groups=False).reset_index(level=0, drop=True)
    cum_vol = df.groupby("date_group")["volume"].cumsum()
    df["vwap"] = cum_pv / cum_vol.replace(0, np.nan)
    df["vwap"] = df["vwap"].fillna(df["close"])
    df.drop(columns=["date_group"], inplace=True)
    return df

def generate_synthetic_5m_token(symbol: str, base_5m_df: pd.DataFrame) -> pd.DataFrame:
    """Historical compatibility guard: generated values must never become market data."""
    raise RuntimeError("Synthetic price generation is disabled; missing observations remain missing.")

def main():
    base_dir = Path(__file__).resolve().parent
    store_dir = base_dir / "arctic_store"
    store_dir.mkdir(parents=True, exist_ok=True)

    arctic = adb.Arctic(f"lmdb://{store_dir.as_posix()}")

    # ArcticDB 라이브러리 준비
    lib_5m = arctic.get_library("xtxc_intraday_5m", create_if_missing=True)
    lib_1h = arctic.get_library("xtxc_hourly_1h", create_if_missing=True)

    dir_5m = base_dir / "data" / "intraday_5m"
    dir_1h = base_dir / "data" / "hourly_1h"
    dir_5m.mkdir(parents=True, exist_ok=True)
    dir_1h.mkdir(parents=True, exist_ok=True)

    print("=" * 75)
    print(" 🚀 Man Group Multi-Frequency Pipeline: 58 Universe")
    print(f" 저장소: {store_dir}")
    print("=" * 75)

    # ── Phase 1: Tier 1 (5분봉 수집 - 8종목) ──
    print("\n[Phase 1] Tier 1: 초고변동성 / 크립토 연동 5분봉(5m) 수집 (60일치)")
    tier1_frames = []
    base_nvda_5m = None

    # 2026-09-29: Tier 2 (listed tokenized names) is downloaded here too; nothing is generated
    for sym in TIER1_SYMBOLS + TIER2_SYMBOLS:
        print(f" - [{sym.ljust(5)}] 5분봉 다운로드 중...", end=" ", flush=True)
        try:
            ticker = yf.Ticker(sym)
            raw = ticker.history(period="60d", interval="5m").reset_index()
            raw.columns = [c.lower() for c in raw.columns]

            # datetime 컬럼 정리
            dt_col = "datetime" if "datetime" in raw.columns else "date"
            raw.rename(columns={dt_col: "datetime"}, inplace=True)
            if getattr(raw["datetime"].dt, "tz", None) is not None:
                raw["datetime"] = raw["datetime"].dt.tz_localize(None)

            raw["symbol"] = sym
            cols = ["datetime", "open", "high", "low", "close", "volume", "symbol"]
            df = raw[[c for c in cols if c in raw.columns]]
            df = engineer_intraday_features(df, freq_name="5m")
            df["source"] = "yfinance"

            lib_5m.write(sym, df)
            df.to_parquet(dir_5m / f"{sym}_5m.parquet", index=False)
            tier1_frames.append(df)
            if sym == "NVDA":
                base_nvda_5m = df
            print(f"✅ 완료 ({len(df):,} 봉, ArcticDB 'xtxc_intraday_5m')")
        except Exception as e:
            print(f"❌ 실패: {e}")

    # ── Phase 2 (removed 2026-09-29): Tier 2 used to be generated here; it is now downloaded in Phase 1.

    # Tier 1+2 5분봉 마스터 저장
    if tier1_frames:
        master_5m = pd.concat(tier1_frames, ignore_index=True)
        master_5m.to_parquet(base_dir / "data" / "xtxc_tier1_tier2_5m_master.parquet", index=False)
        lib_5m.write("TIER1_TIER2_5M_MASTER", master_5m)
        print(f"  🎯 5분봉 마스터 저장 완료: 총 {len(master_5m):,} 행")

    # ── Phase 3: Tier 3 (1시간봉 수집 - 20종목) ──
    print("\n[Phase 3] Tier 3: 메가캡 테크 & 지수 ETF 1시간봉(1h) 수집 (730일 / 2년치)")
    tier3_frames = []

    for sym in TIER3_SYMBOLS:
        print(f" - [{sym.ljust(5)}] 1시간봉 다운로드 중...", end=" ", flush=True)
        try:
            ticker = yf.Ticker(sym)
            raw = ticker.history(period="730d", interval="1h").reset_index()
            raw.columns = [c.lower() for c in raw.columns]

            dt_col = "datetime" if "datetime" in raw.columns else "date"
            raw.rename(columns={dt_col: "datetime"}, inplace=True)
            if getattr(raw["datetime"].dt, "tz", None) is not None:
                raw["datetime"] = raw["datetime"].dt.tz_localize(None)

            raw["symbol"] = sym
            cols = ["datetime", "open", "high", "low", "close", "volume", "symbol"]
            df = raw[[c for c in cols if c in raw.columns]]
            df = engineer_intraday_features(df, freq_name="1h")
            df["source"] = "yfinance"

            lib_1h.write(sym, df)
            df.to_parquet(dir_1h / f"{sym}_1h.parquet", index=False)
            tier3_frames.append(df)
            print(f"✅ 완료 ({len(df):,} 봉, ArcticDB 'xtxc_hourly_1h')")
        except Exception as e:
            print(f"❌ 실패: {e}")

    # Tier 3 1시간봉 마스터 저장
    if tier3_frames:
        master_1h = pd.concat(tier3_frames, ignore_index=True)
        master_1h.to_parquet(base_dir / "data" / "xtxc_tier3_1h_master.parquet", index=False)
        lib_1h.write("TIER3_1H_MASTER", master_1h)
        print(f"  🎯 1시간봉 마스터 저장 완료: 총 {len(master_1h):,} 행")

    # ── Phase 4: Tier 4 현황 점검 (24종목) ──
    print("\n[Phase 4] Tier 4: 가치주/방어주/헬스케어 (일봉 1D 전용 유지 확인)")
    lib_daily = arctic.get_library("xtxc_58_universe")
    daily_symbols = lib_daily.list_symbols()
    t4_present = [s for s in TIER4_SYMBOLS if s in daily_symbols]
    print(f"  - Tier 4 종목 24개 중 {len(t4_present)}개 정상 보관 중 (일봉 유지로 오버헤드 방지)")

    print("\n" + "=" * 75)
    print(" 🏁 Man Group Multi-Frequency 파이프라인 전체 완료 요약")
    print(f" 1. 5분봉(5m) 보관소: {lib_5m} (종목 {len(lib_5m.list_symbols())}개)")
    print(f" 2. 1시간봉(1h) 보관소: {lib_1h} (종목 {len(lib_1h.list_symbols())}개)")
    print(f" 3. 일봉(1D) 보관소: {lib_daily} (58개 전체 유니버스 마스터)")
    print("=" * 75)

if __name__ == "__main__":
    main()
