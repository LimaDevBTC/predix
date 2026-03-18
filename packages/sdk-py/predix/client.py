"""
PredixClient — Python SDK for the Predix prediction market.

For write operations (bet, mint, approve), uses a server-side
sign-and-submit approach via the build-tx + sponsor flow.
Stacks signing requires a Node.js subprocess (no mature Python lib).
"""

import subprocess
import json
import os
from typing import Optional

import httpx

from predix.types import (
    MarketData,
    OpportunitiesData,
    PositionsData,
    HistoryData,
    BetResult,
    TxResult,
)
from predix.errors import (
    PredixError,
    TradingClosedError,
    RateLimitError,
    AuthenticationError,
)

DEFAULT_BASE_URL = "https://www.predix.live"


class PredixClient:
    def __init__(
        self,
        api_key: Optional[str] = None,
        private_key: Optional[str] = None,
        base_url: str = DEFAULT_BASE_URL,
        network: str = "testnet",
    ):
        self.api_key = api_key or ""
        self.private_key = private_key
        self.base_url = base_url.rstrip("/")
        self.network = network
        self._http = httpx.Client(
            base_url=self.base_url,
            headers={"Content-Type": "application/json"},
            timeout=15.0,
        )
        self._address: Optional[str] = None
        self._auto_registered = False

    @property
    def address(self) -> str:
        if self._address is None:
            if not self.private_key:
                raise PredixError("private_key required to derive address")
            self._address = self._derive_address()
        return self._address

    def _signer_script_path(self) -> str:
        return os.path.join(os.path.dirname(__file__), "_signer.js")

    def _call_signer(self, action: str, **kwargs) -> dict:
        """Single Node.js subprocess call for all signing operations."""
        cmd = json.dumps({"action": action, "privateKey": self.private_key, **kwargs})
        try:
            result = subprocess.run(
                ["node", self._signer_script_path()],
                input=cmd,
                capture_output=True, text=True, timeout=15,
            )
            if result.returncode != 0:
                raise PredixError(f"Signer failed: {result.stderr.strip()}")
            data = json.loads(result.stdout.strip())
            if "error" in data:
                raise PredixError(f"Signer error: {data['error']}")
            return data
        except FileNotFoundError:
            raise PredixError("Node.js required for Stacks signing (install from nodejs.org)")

    def _derive_address(self) -> str:
        """Derive Stacks address via unified Node.js signer. Also caches public key."""
        data = self._call_signer("derive", network=self.network)
        self._public_key = data["publicKey"]
        return data["address"]

    def _ensure_api_key(self):
        """Auto-register if no API key but private key is available."""
        if self.api_key:
            return
        if not self.private_key:
            raise AuthenticationError("No api_key or private_key configured")
        if self._auto_registered:
            raise AuthenticationError("Auto-registration already attempted")
        self._auto_registered = True
        self.register()

    def register(self, name: str = "Python Agent") -> str:
        """Register agent and get API key. Called automatically if only private_key is set."""
        if not self.private_key:
            raise PredixError("private_key required for registration")
        import time
        timestamp = int(time.time())
        message = f"Predix Agent Registration {timestamp}"
        signature = self._sign_message(message)
        data = self._raw_request("POST", "/api/agent/register", json={
            "wallet": self.address,
            "signature": signature,
            "message": message,
            "name": name,
        })
        if not data.get("apiKey"):
            raise PredixError("Auto-registration failed: " + data.get("error", "no key returned"))
        self.api_key = data["apiKey"]
        return self.api_key

    def _sign_message(self, message: str) -> str:
        data = self._call_signer("signMessage", message=message)
        return data["signature"]

    def _raw_request(self, method: str, path: str, **kwargs) -> dict:
        """Request without API key header (for registration)."""
        res = self._http.request(method, path, **kwargs)
        data = res.json()
        if not res.is_success or data.get("error"):
            raise PredixError(data.get("error", f"API error: {res.status_code}"), res.status_code)
        return data

    def _request(self, method: str, path: str, **kwargs) -> dict:
        self._ensure_api_key()
        headers = kwargs.pop("headers", {})
        headers["X-Predix-Key"] = self.api_key
        res = self._http.request(method, path, headers=headers, **kwargs)
        data = res.json()

        if res.status_code == 401:
            raise AuthenticationError(data.get("error", "Unauthorized"))
        if res.status_code == 429:
            raise RateLimitError()
        if not res.is_success or data.get("error"):
            raise PredixError(data.get("error", f"API error: {res.status_code}"), res.status_code)
        return data

    # ---- Read ----

    def market(self) -> MarketData:
        data = self._request("GET", "/api/agent/market")
        return MarketData(**data)

    def opportunities(self) -> OpportunitiesData:
        data = self._request("GET", "/api/agent/opportunities")
        return OpportunitiesData(**data)

    def positions(self) -> PositionsData:
        data = self._request("GET", f"/api/agent/positions?address={self.address}")
        return PositionsData(**data)

    def history(self, page: int = 1, page_size: int = 20) -> HistoryData:
        data = self._request("GET", f"/api/agent/history?address={self.address}&page={page}&pageSize={page_size}")
        return HistoryData(**data)

    # ---- Write ----

    def bet(self, side: str, amount: float) -> BetResult:
        if not self.private_key:
            raise PredixError("private_key required for betting")

        # Check market
        mkt = self.market()
        if not mkt.round.tradingOpen:
            raise TradingClosedError()

        # Build + sign + sponsor via Node.js subprocess
        public_key = self._get_public_key()
        build_data = self._request("POST", "/api/agent/build-tx", json={
            "action": "place-bet",
            "publicKey": public_key,
            "params": {"side": side, "amount": amount},
        })

        signed_hex = self._sign_tx(build_data["txHex"])
        sponsor_data = self._request("POST", "/api/sponsor", json={"txHex": signed_hex})

        return BetResult(
            txid=sponsor_data["txid"],
            roundId=build_data["details"].get("roundId", 0),
            side=side,
            amount=amount,
        )

    def mint(self) -> TxResult:
        return self._execute_action("mint")

    def approve(self) -> TxResult:
        return self._execute_action("approve")

    def _execute_action(self, action: str) -> TxResult:
        if not self.private_key:
            raise PredixError(f"private_key required for {action}")

        public_key = self._get_public_key()
        build_data = self._request("POST", "/api/agent/build-tx", json={
            "action": action,
            "publicKey": public_key,
            "params": {},
        })

        signed_hex = self._sign_tx(build_data["txHex"])
        sponsor_data = self._request("POST", "/api/sponsor", json={"txHex": signed_hex})
        return TxResult(txid=sponsor_data["txid"])

    def _get_public_key(self) -> str:
        if hasattr(self, "_public_key") and self._public_key:
            return self._public_key
        # derive also caches public key
        self._derive_address()
        return self._public_key

    def _sign_tx(self, tx_hex: str) -> str:
        data = self._call_signer("sign", txHex=tx_hex)
        return data["signedHex"]

    def close(self):
        self._http.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
