"""Runtime configuration. Secrets are read from the private directory only."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

# Public research API defaults to a local, isolated workspace. Never discover a
# production credential directory merely because this module was imported.
ROOT = Path(os.environ.get("STA_WORKSPACE", str(Path(__file__).resolve().parents[3] / ".local")))
WORKSPACE = ROOT
PRIVATE = ROOT / "private"
EVIDENCE = ROOT / "evidence"


def _read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip()
    return values


@dataclass(frozen=True)
class Settings:
    mode: str = "dev"                      # dev | prod
    data_dir: Path = WORKSPACE / "agent" / "data"
    db_path: Path = WORKSPACE / "agent" / "data" / "xtxc.db"
    kiln_base_url: str = ""
    kiln_model: str = ""
    kiln_api_key: str = field(default="", repr=False)
    kiln_user_agent: str = "xtxc-agent/0.1"
    kiln_offline: bool = False
    sidecar_url: str = "http://127.0.0.1:28950"
    chain_network: str = "local"           # local | devnet | mainnet (only local is enabled)
    dev_wallet: bool = True
    fx_krw_per_usdc: str = "1390"          # demo constant; the UI states the reference
    premium_warn_bps: float = 50.0
    premium_block_bps: float = 150.0
    cost_warn_bps: float = 100.0
    cost_block_bps: float = 200.0
    quote_ttl_seconds: int = 45
    daily_token_budget: int | None = None   # demo: cap on Kiln tokens per UTC day across all visitors
    ai_requests_per_10min: int = 20         # demo: per client IP, for requests that call the model (typed chat turns included)
    public: bool = False                    # served through the public reverse proxy
    cookie_secure: bool = False             # demo session cookie only over HTTPS

    @property
    def kiln_configured(self) -> bool:
        return bool(self.kiln_base_url and self.kiln_model and self.kiln_api_key) and not self.kiln_offline


def load_settings() -> Settings:
    kiln = _read_env_file(PRIVATE / "kiln.env")
    mode = os.environ.get("XTXC_MODE", "dev")
    data_dir = Path(os.environ.get("XTXC_DATA_DIR", str(WORKSPACE / "agent" / "data")))
    return Settings(
        mode=mode,
        data_dir=data_dir,
        db_path=Path(os.environ.get("XTXC_DB", str(data_dir / "xtxc.db"))),
        kiln_base_url=kiln.get("KILN_BASE_URL", ""),
        kiln_model=kiln.get("KILN_MODEL_ID", ""),
        kiln_api_key=kiln.get("KILN_API_KEY", ""),
        kiln_offline=os.environ.get("XTXC_KILN_OFFLINE") == "1",
        sidecar_url=os.environ.get("XTXC_SIDECAR_URL", "http://127.0.0.1:28950"),
        chain_network="local",
        dev_wallet=mode in ("dev", "demo") and os.environ.get("XTXC_DEV_WALLET", "1") == "1",
        daily_token_budget=int(os.environ.get("XTXC_DAILY_TOKENS", "2000000")) if mode == "demo" else None,
        public=mode == "demo",
        cookie_secure=mode == "demo" and os.environ.get("XTXC_COOKIE_SECURE", "1") == "1",
    )
