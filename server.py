from __future__ import annotations

import base64
import hashlib
import hmac
import json
import mimetypes
import os
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
COOKIE_NAME = "northstar_session"
SESSION_TTL = 12 * 60 * 60
MAX_REQUEST_BYTES = 16_384
DERIV_API = "https://api.derivws.com"
DERIV_OAUTH = "https://auth.deriv.com/oauth2"
SESSIONS: dict[str, dict[str, Any]] = {}
SESSIONS_LOCK = threading.RLock()


class ProviderError(Exception):
    def __init__(self, message: str, status: int = 502) -> None:
        super().__init__(message)
        self.status = status


def load_local_env() -> None:
    env_file = ROOT / ".env"
    try:
        lines = env_file.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return

    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("\"'")
        if key in {"DERIV_CLIENT_ID", "DERIV_REDIRECT_URI", "NORTHSTAR_PORT"}:
            os.environ.setdefault(key, value)


load_local_env()
CLIENT_ID = os.environ.get("DERIV_CLIENT_ID", "").strip()
REDIRECT_URI = os.environ.get(
    "DERIV_REDIRECT_URI",
    "http://localhost:8000/oauth/callback",
).strip()
PORT = int(os.environ.get("NORTHSTAR_PORT", "8000"))


def app_is_configured() -> bool:
    return bool(CLIENT_ID and CLIENT_ID != "YOUR_DERIV_OAUTH_CLIENT_ID")


def encoded_json(data: Any) -> bytes:
    return json.dumps(data, separators=(",", ":")).encode("utf-8")


def provider_json(
    path: str,
    token: str,
    method: str = "GET",
    body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    request_body = encoded_json(body) if body is not None else None
    request = urllib.request.Request(
        f"{DERIV_API}{path}",
        data=request_body,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            **({"Content-Type": "application/json"} if request_body is not None else {}),
        },
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            error_payload = json.loads(error.read().decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            error_payload = {}
        errors = error_payload.get("errors", []) if isinstance(error_payload, dict) else []
        detail = errors[0].get("message") if errors and isinstance(errors[0], dict) else None
        raise ProviderError(detail or f"Deriv returned HTTP {error.code}.", 502) from None
    except (urllib.error.URLError, TimeoutError):
        raise ProviderError("Could not reach Deriv. Check the connection and try again.", 502) from None
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ProviderError("Deriv returned an unreadable response.", 502) from None

    if not isinstance(payload, dict):
        raise ProviderError("Deriv returned an unexpected response.", 502)
    return payload


class NorthstarHandler(BaseHTTPRequestHandler):
    server_version = "NorthstarLocal/1.0"
    session_id: str | None = None

    def log_message(self, _format_string: str, *_args: Any) -> None:
        del _format_string, _args
        safe_path = urllib.parse.urlsplit(self.path).path
        print(f"{self.command} {safe_path}")

    def _session(self, create: bool = False) -> dict[str, Any] | None:
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except CookieError:
            cookie = SimpleCookie()
        morsel = cookie.get(COOKIE_NAME)
        now = time.time()
        with SESSIONS_LOCK:
            for session_key in [
                key for key, value in SESSIONS.items() if value.get("expires_at", 0) <= now
            ]:
                del SESSIONS[session_key]
            if morsel:
                found = SESSIONS.get(morsel.value)
                if found is not None:
                    found["expires_at"] = now + SESSION_TTL
                    self.session_id = morsel.value
                    return found
            if not create:
                return None
            self.session_id = secrets.token_urlsafe(32)
            session: dict[str, Any] = {"expires_at": now + SESSION_TTL}
            SESSIONS[self.session_id] = session
            return session

    def _cookie_header(self, clear: bool = False) -> str:
        if clear:
            return f"{COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
        secure = "; Secure" if os.environ.get("NORTHSTAR_COOKIE_SECURE") == "1" else ""
        return (
            f"{COOKIE_NAME}={self.session_id}; Path=/; HttpOnly; SameSite=Lax; "
            f"Max-Age={SESSION_TTL}{secure}"
        )

    def _send_json(self, status: int, payload: dict[str, Any], clear_cookie: bool = False) -> None:
        content = encoded_json(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        if clear_cookie or self.session_id is not None:
            self.send_header("Set-Cookie", self._cookie_header(clear=clear_cookie))
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def _send_file(self, path: Path) -> None:
        try:
            content = path.read_bytes()
        except FileNotFoundError:
            self._send_json(404, {"error": "Page not found."})
            return
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def _request_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length < 0 or length > MAX_REQUEST_BYTES:
            raise ValueError("Request body is too large.")
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("Request body must be valid JSON.") from error
        if not isinstance(payload, dict):
            raise ValueError("Request body must be a JSON object.")
        return payload

    def _same_origin(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return True
        parsed_origin = urllib.parse.urlsplit(origin)
        return parsed_origin.netloc.casefold() == self.headers.get("Host", "").casefold()

    def _valid_token(self, session: dict[str, Any] | None) -> str | None:
        if session is None:
            return None
        token = session.get("access_token")
        if not isinstance(token, str) or session.get("token_expires_at", 0) <= time.time():
            return None
        return token

    def do_GET(self) -> None:
        path = urllib.parse.urlsplit(self.path).path
        if path == "/oauth/callback":
            query = urllib.parse.urlsplit(self.path).query
            destination = "/" + (f"?{query}" if query else "")
            self.send_response(303)
            self.send_header("Location", destination)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if path == "/":
            self._send_file(ROOT / "index.html")
            return
        static_files = {
            "/styles.css": ROOT / "styles.css",
            "/app.js": ROOT / "app.js",
        }
        if path in static_files:
            self._send_file(static_files[path])
            return
        if path == "/api/status":
            session = self._session()
            self._send_json(
                200,
                {
                    "configured": app_is_configured(),
                    "authenticated": self._valid_token(session) is not None,
                    "live_trading_enabled": False,
                },
            )
            return
        if path == "/api/accounts":
            self._list_demo_accounts()
            return
        self._send_json(404, {"error": "Page not found."})

    def do_POST(self) -> None:
        path = urllib.parse.urlsplit(self.path).path
        if not self._same_origin():
            self._send_json(403, {"error": "Cross-origin requests are not allowed."})
            return
        try:
            payload = self._request_json()
        except ValueError as error:
            self._send_json(400, {"error": str(error)})
            return
        if path == "/api/oauth/start":
            self._start_oauth()
        elif path == "/api/oauth/exchange":
            self._exchange_oauth(payload)
        elif path == "/api/deriv/demo-websocket":
            self._demo_websocket(payload)
        elif path == "/api/logout":
            self._logout()
        else:
            self._send_json(404, {"error": "Endpoint not found."})

    def _start_oauth(self) -> None:
        if not app_is_configured():
            self._send_json(503, {"error": "Set DERIV_CLIENT_ID in .env before connecting."})
            return
        redirect = urllib.parse.urlsplit(REDIRECT_URI)
        if redirect.path != "/oauth/callback" or redirect.hostname not in {
            "127.0.0.1",
            "localhost",
        }:
            self._send_json(
                503,
                {"error": "For this local build, redirect URI must use /oauth/callback on localhost."},
            )
            return
        session = self._session(create=True)
        if session is None:
            self._send_json(500, {"error": "Could not create an OAuth session."})
            return
        verifier = secrets.token_urlsafe(64)
        challenge = base64.urlsafe_b64encode(
            hashlib.sha256(verifier.encode("ascii")).digest()
        ).rstrip(b"=").decode("ascii")
        state = secrets.token_urlsafe(32)
        session["oauth_state"] = state
        session["oauth_verifier"] = verifier
        session["oauth_started_at"] = time.time()
        authorization_url = "https://auth.deriv.com/oauth2/auth?" + urllib.parse.urlencode(
            {
                "response_type": "code",
                "client_id": CLIENT_ID,
                "redirect_uri": REDIRECT_URI,
                "scope": "trade",
                "state": state,
                "code_challenge": challenge,
                "code_challenge_method": "S256",
            }
        )
        self._send_json(200, {"authorization_url": authorization_url})

    def _exchange_oauth(self, payload: dict[str, Any]) -> None:
        session = self._session()
        if not app_is_configured() or session is None:
            self._send_json(401, {"error": "Start the Deriv sign-in flow first."})
            return
        code = payload.get("code")
        state = payload.get("state")
        expected_state = session.pop("oauth_state", None)
        verifier = session.pop("oauth_verifier", None)
        started_at = session.pop("oauth_started_at", 0)
        if (
            not isinstance(code, str)
            or not code
            or len(code) > 4096
            or not isinstance(state, str)
            or not isinstance(expected_state, str)
            or not hmac.compare_digest(state, expected_state)
            or not isinstance(verifier, str)
            or time.time() - started_at > 600
        ):
            self._send_json(400, {"error": "Deriv sign-in could not be verified. Please try again."})
            return

        form = urllib.parse.urlencode(
            {
                "grant_type": "authorization_code",
                "client_id": CLIENT_ID,
                "code": code,
                "redirect_uri": REDIRECT_URI,
                "code_verifier": verifier,
            }
        ).encode("ascii")
        request = urllib.request.Request(
            f"{DERIV_OAUTH}/token",
            data=form,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                token_payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            self._send_json(
                502,
                {"error": f"Deriv token exchange failed (HTTP {error.code}). Check OAuth app settings."},
            )
            return
        except urllib.error.URLError:
            self._send_json(502, {"error": "Could not reach Deriv sign-in. Try again."})
            return
        except (TimeoutError, UnicodeDecodeError, json.JSONDecodeError):
            self._send_json(502, {"error": "Deriv returned an invalid token response."})
            return
        access_token = token_payload.get("access_token") if isinstance(token_payload, dict) else None
        expires_in = token_payload.get("expires_in") if isinstance(token_payload, dict) else None
        if not isinstance(access_token, str) or not access_token or not isinstance(expires_in, (int, float)):
            self._send_json(502, {"error": "Deriv did not return a usable access token."})
            return
        session["access_token"] = access_token
        session["token_expires_at"] = time.time() + max(0, expires_in)
        session.pop("demo_account_ids", None)
        self._send_json(200, {"authenticated": True})

    def _list_demo_accounts(self) -> None:
        session = self._session()
        token = self._valid_token(session)
        if session is None or token is None:
            self._send_json(401, {"error": "Connect your Deriv account first."})
            return
        try:
            response = provider_json("/trading/v1/options/accounts", token)
        except ProviderError as error:
            self._send_json(error.status, {"error": str(error)})
            return
        accounts = response.get("data")
        if not isinstance(accounts, list):
            self._send_json(502, {"error": "Deriv returned an unexpected account list."})
            return

        safe_accounts: list[dict[str, str]] = []
        account_ids: set[str] = set()
        for account in accounts:
            if not isinstance(account, dict):
                continue
            if str(account.get("account_type", "")).lower() != "demo":
                continue
            account_id = account.get("account_id") or account.get("id")
            if not isinstance(account_id, str) or not account_id:
                continue
            account_ids.add(account_id)
            loginid = account.get("loginid")
            currency = account.get("currency")
            safe_accounts.append(
                {
                    "account_id": account_id,
                    "loginid": loginid if isinstance(loginid, str) else "Deriv demo",
                    "currency": currency if isinstance(currency, str) else "USD",
                    "account_type": "demo",
                }
            )
        session["demo_account_ids"] = account_ids
        self._send_json(200, {"accounts": safe_accounts})

    def _demo_websocket(self, payload: dict[str, Any]) -> None:
        session = self._session()
        token = self._valid_token(session)
        account_id = payload.get("account_id")
        known_demo_accounts = session.get("demo_account_ids") if session else None
        if session is None or token is None:
            self._send_json(401, {"error": "Connect your Deriv account first."})
            return
        if (
            not isinstance(account_id, str)
            or not isinstance(known_demo_accounts, set)
            or account_id not in known_demo_accounts
        ):
            self._send_json(403, {"error": "Only a listed Deriv demo account can be connected."})
            return
        encoded_account = urllib.parse.quote(account_id, safe="")
        try:
            response = provider_json(
                f"/trading/v1/options/accounts/{encoded_account}/otp",
                token,
                method="POST",
            )
        except ProviderError as error:
            self._send_json(error.status, {"error": str(error)})
            return
        data = response.get("data")
        websocket_url = data.get("url") if isinstance(data, dict) else None
        parsed = urllib.parse.urlsplit(websocket_url) if isinstance(websocket_url, str) else None
        if (
            parsed is None
            or parsed.scheme != "wss"
            or parsed.netloc != "api.derivws.com"
            or parsed.path != "/trading/v1/options/ws/demo"
            or not parsed.query.startswith("otp=")
        ):
            self._send_json(502, {"error": "Deriv did not return a demo-only WebSocket URL."})
            return
        self._send_json(200, {"websocket_url": websocket_url})

    def _logout(self) -> None:
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except CookieError:
            cookie = SimpleCookie()
        morsel = cookie.get(COOKIE_NAME)
        if morsel:
            with SESSIONS_LOCK:
                SESSIONS.pop(morsel.value, None)
        self.session_id = None
        self._send_json(200, {"authenticated": False}, clear_cookie=True)


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", PORT), NorthstarHandler)
    print(f"Northstar local demo server: http://localhost:{PORT}")
    print("Live-money trading is not available in this build.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Northstar.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
