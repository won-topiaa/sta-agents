"""STA research collector for the fixed 58-instrument presentation universe.

The historical filename describes inspiration, not Man Group affiliation or
supplied code. Yahoo/yfinance provides retrospective adjusted history. ArcticDB
versions preserve ingestion history; they do NOT turn it into point-in-time
fundamentals or a survivorship-bias-free universe. Missing prices are omitted,
never synthesized. Collection and redistribution require appropriate data rights.
"""

import os
import sys
import json
import math
from datetime import datetime, timedelta
from pathlib import Path

# Ensure UTF-8 output on Windows
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

import numpy as np
import pandas as pd
import yfinance as yf
import arcticdb as adb

# 58개 종목 정의 및 매핑
TICKER_MAP = {
    # Ticker on XTXC -> yfinance ticker
    "BRK.B": "BRK-B",
}

# 58개 전체 유니버스
ALL_58_INSTRUMENTS = [
    # 1. ETFs (5)
    {"symbol": "SPY", "name": "S&P 500 ETF", "type": "ETF"},
    {"symbol": "QQQ", "name": "Nasdaq 100 ETF", "type": "ETF"},
    {"symbol": "VTI", "name": "Vanguard Total Stock Market ETF", "type": "ETF"},
    {"symbol": "TQQQ", "name": "ProShares UltraPro QQQ 3x", "type": "ETF"},
    {"symbol": "SLV", "name": "iShares Silver Trust", "type": "ETF"},

    # 2. Listed Equities (47)
    {"symbol": "AAPL", "name": "Apple", "type": "Stock"},
    {"symbol": "ABT", "name": "Abbott", "type": "Stock"},
    {"symbol": "ACN", "name": "Accenture", "type": "Stock"},
    {"symbol": "AMD", "name": "AMD", "type": "Stock"},
    {"symbol": "AMZN", "name": "Amazon", "type": "Stock"},
    {"symbol": "ASML", "name": "ASML Holding NV", "type": "Stock"},
    {"symbol": "AVGO", "name": "Broadcom", "type": "Stock"},
    {"symbol": "AZN", "name": "AstraZeneca", "type": "Stock"},
    {"symbol": "BMNR", "name": "BitMine Immersion Tech", "type": "Stock"},
    {"symbol": "BRK.B", "name": "Berkshire Hathaway", "type": "Stock"},
    {"symbol": "CMCSA", "name": "Comcast", "type": "Stock"},
    {"symbol": "COIN", "name": "Coinbase", "type": "Stock"},
    {"symbol": "CSCO", "name": "Cisco Systems", "type": "Stock"},
    {"symbol": "CVX", "name": "Chevron", "type": "Stock"},
    {"symbol": "F", "name": "Ford Motor", "type": "Stock"},
    {"symbol": "GME", "name": "GameStop", "type": "Stock"},
    {"symbol": "GOOGL", "name": "Alphabet", "type": "Stock"},
    {"symbol": "HOOD", "name": "Robinhood Markets", "type": "Stock"},
    {"symbol": "IBM", "name": "IBM", "type": "Stock"},
    {"symbol": "INTC", "name": "Intel", "type": "Stock"},
    {"symbol": "JNJ", "name": "Johnson & Johnson", "type": "Stock"},
    {"symbol": "JPM", "name": "JPMorgan Chase", "type": "Stock"},
    {"symbol": "KO", "name": "Coca-Cola", "type": "Stock"},
    {"symbol": "LIN", "name": "Linde plc", "type": "Stock"},
    {"symbol": "LLY", "name": "Eli Lilly", "type": "Stock"},
    {"symbol": "MA", "name": "Mastercard", "type": "Stock"},
    {"symbol": "META", "name": "Meta Platforms", "type": "Stock"},
    {"symbol": "MRNA", "name": "Moderna", "type": "Stock"},
    {"symbol": "MRVL", "name": "Marvell Technology", "type": "Stock"},
    {"symbol": "MSTR", "name": "Strategy", "type": "Stock"},
    {"symbol": "MU", "name": "Micron Technology", "type": "Stock"},
    {"symbol": "NFLX", "name": "Netflix", "type": "Stock"},
    {"symbol": "NVDA", "name": "NVIDIA", "type": "Stock"},
    {"symbol": "NVO", "name": "Novo Nordisk", "type": "Stock"},
    {"symbol": "ORCL", "name": "Oracle", "type": "Stock"},
    {"symbol": "PEP", "name": "PepsiCo", "type": "Stock"},
    {"symbol": "PFE", "name": "Pfizer", "type": "Stock"},
    {"symbol": "PG", "name": "Procter & Gamble", "type": "Stock"},
    {"symbol": "PLTR", "name": "Palantir Technologies", "type": "Stock"},
    {"symbol": "TMO", "name": "Thermo Fisher Scientific", "type": "Stock"},
    {"symbol": "TSLA", "name": "Tesla", "type": "Stock"},
    {"symbol": "TSM", "name": "Taiwan Semiconductor", "type": "Stock"},
    {"symbol": "UBER", "name": "Uber Technologies", "type": "Stock"},
    {"symbol": "UNH", "name": "UnitedHealth", "type": "Stock"},
    {"symbol": "V", "name": "Visa", "type": "Stock"},
    {"symbol": "WMT", "name": "Walmart", "type": "Stock"},
    {"symbol": "XOM", "name": "Exxon Mobil", "type": "Stock"},

    # 3. Special / Pre-IPO / Tokenized Assets (6)
    {"symbol": "SPCX", "name": "SpaceX (Pre-IPO Token)", "type": "Tokenized_PreIPO"},
    {"symbol": "CRCL", "name": "Circle Internet Group", "type": "Tokenized_PreIPO"},
    {"symbol": "STRC", "name": "Strategy Stretch Preferred", "type": "Tokenized_Special"},
    {"symbol": "DFDV", "name": "DFDV Digital Venture", "type": "Tokenized_Special"},
    {"symbol": "VIDA", "name": "Vida Global", "type": "Tokenized_Special"},
    {"symbol": "AMBR", "name": "Amber", "type": "Tokenized_Special"},
]

def engineer_man_group_features(df: pd.DataFrame) -> pd.DataFrame:
    """
    Man Group (AHL) 스타일 팩터 피처 산출:
    - Log Returns
    - Realized Volatility (20-day annualized)
    - Momentum (20-day cumulative)
    - Dollar Volume (Close * Volume)
    - Normalized Volume
    """
    df = df.copy().sort_values("date").reset_index(drop=True)
    df["log_return"] = np.log(df["close"] / df["close"].shift(1))
    df["volatility_20d"] = df["log_return"].rolling(window=20).std() * math.sqrt(252)
    df["momentum_20d"] = df["close"] / df["close"].shift(20) - 1.0
    df["dollar_volume"] = df["close"] * df["volume"]
    df["rolling_volume_20d"] = df["volume"].rolling(window=20).mean()
    df["volume_ratio"] = df["volume"] / df["rolling_volume_20d"].replace(0, np.nan)
    return df

def generate_synthetic_token_series(symbol: str, name: str, base_series_df: pd.DataFrame) -> pd.DataFrame:
    """Historical compatibility guard: generated values must never become market data."""
    raise RuntimeError("Synthetic price generation is disabled; missing observations remain missing.")

def main():
    start_date = "2010-01-01"
    end_date = os.environ.get("XTXC_QUANT_END") or datetime.now().strftime("%Y-%m-%d")  # daily_refresh: day after the last closed session

    print("=" * 70)
    print(" 🚀 Man Group (Man AHL) Quantitative Data Engine: 58 Universe (2010~Present)")
    print(f" 기간: {start_date} ~ {end_date} (16+ 년간 데이터)")
    print(f" 총 수집 대상: {len(ALL_58_INSTRUMENTS)} 개 종목")
    print("=" * 70)

    # 1. ArcticDB 연결
    base_dir = Path(__file__).resolve().parent.parent if Path(__file__).resolve().parent.name == "data" else Path(__file__).resolve().parent
    store_dir = base_dir / "arctic_store"
    store_dir.mkdir(parents=True, exist_ok=True)
    arctic = adb.Arctic(f"lmdb://{store_dir.as_posix()}")

    lib_name = "xtxc_58_universe"
    if lib_name not in arctic.list_libraries():
        arctic.create_library(lib_name)
    lib = arctic[lib_name]
    print(f" [OK] ArcticDB 라이브러리 연결 완료: '{lib_name}' @ {store_dir}")

    data_out_dir = base_dir / "data" / "universe_58"
    data_out_dir.mkdir(parents=True, exist_ok=True)

    all_frames = []
    success_count = 0
    fail_count = 0

    # 기준 캘린더를 얻기 위해 SPY 먼저 수집
    spy_df = None

    for idx, item in enumerate(ALL_58_INSTRUMENTS, 1):
        sym = item["symbol"]
        name = item["name"]
        asset_type = item["type"]
        yf_sym = TICKER_MAP.get(sym, sym)

        print(f"[{idx:2d}/{len(ALL_58_INSTRUMENTS)}] 수집 중: {sym.ljust(6)} ({name[:22].ljust(22)}) [{asset_type}] ...", end=" ", flush=True)

        try:
            # 2026-09-29: every symbol -- the tokenized listed names included -- is downloaded like any listed
            # stock. Prices are never generated; a failed download leaves the symbol missing.
            ticker = yf.Ticker(yf_sym)
            raw = ticker.history(start=start_date, end=end_date)
            if raw.empty:
                # fallback
                raise ValueError(f"데이터 빈 값 ({yf_sym})")
            raw = raw.reset_index()
            raw.columns = [c.lower() for c in raw.columns]
            # 타임존 정리
            if "date" in raw.columns:
                if getattr(raw["date"].dt, "tz", None) is not None:
                    raw["date"] = raw["date"].dt.tz_localize(None)
            raw["symbol"] = sym
            cols = ["date", "open", "high", "low", "close", "volume", "symbol"]
            df = raw[[c for c in cols if c in raw.columns]]
            df = engineer_man_group_features(df)
            source = "TradFi Market Feed"
            df["source"] = "yfinance"  # provenance is stored with every row
            if sym == "SPY":
                spy_df = df

            # ArcticDB에 Man Group 방식으로 저장 (버전 관리 지원)
            ver_item = lib.write(sym, df)
            ver = ver_item.version

            # 로컬 Parquet 아카이브 저장
            parquet_path = data_out_dir / f"{sym}.parquet"
            df.to_parquet(parquet_path, index=False)

            all_frames.append(df)
            success_count += 1
            print(f"✅ 완료 ({len(df)} 행, ArcticDB v{ver}, {source})")

        except Exception as e:
            # 2026-09-29: no generated fallback -- a failed download stays missing and is reported
            fail_count += 1
            print(f"❌ 실패 (저장하지 않음, 가격을 만들어 넣지 않음): {e}")

    # 4. 전체 58개 유니버스 마스터 매트릭스 생성
    if all_frames:
        master_df = pd.concat(all_frames, ignore_index=True)
        master_parquet = base_dir / "data" / "xtxc_58_master.parquet"
        master_csv = base_dir / "data" / "xtxc_58_master.csv"

        master_df.to_parquet(master_parquet, index=False)
        master_df.to_csv(master_csv, index=False)

        # ArcticDB에도 전체 유니버스 마스터 테이블 저장
        lib.write("XTXC_58_UNIVERSE_MASTER", master_df)

        print("\n" + "=" * 70)
        print(" 🎯 Man Group 데이터 수집 및 정합 완료 요약")
        print(f" - 성공 종목 수: {success_count} / {len(ALL_58_INSTRUMENTS)}")
        print(f" - 실패 종목 수: {fail_count}")
        print(f" - 총 수집 데이터 레코드: {len(master_df):,} 행")
        print(f" - ArcticDB 스토어: {store_dir} (라이브러리: '{lib_name}')")
        print(f" - 마스터 Parquet 파일: {master_parquet} ({master_parquet.stat().st_size / (1024*1024):.2f} MB)")
        print(f" - 마스터 CSV 파일: {master_csv} ({master_csv.stat().st_size / (1024*1024):.2f} MB)")
        print("=" * 70)

if __name__ == "__main__":
    main()
