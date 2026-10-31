# Northstar demo trading

Northstar can connect to a Deriv **demo Options account** for real-time quotes and virtual-money orders. The built-in simulated practice mode still works without a Deriv connection.

## Local setup

1. Install Python 3.10 or newer.
2. Register an OAuth 2.0 app in Deriv and add this exact redirect URI:
   `http://localhost:8000/oauth/callback`
3. Copy `.env.example` to `.env` and set `DERIV_CLIENT_ID` to the OAuth client ID from Deriv.
4. Run `python server.py` from this folder, then open `http://localhost:8000`.
5. Select **Connect Deriv**, authorize the `trade` scope at Deriv, choose a demo account, and connect it.

The backend uses Authorization Code + PKCE, stores the short-lived access token only in server memory, and keeps the browser session in an HttpOnly cookie. It only lists accounts marked as demo and only requests Deriv's demo WebSocket endpoint. It does not expose a live-account connection path.

This standard-library server is for local development only. Do not expose it to the public internet or use it as a production trading backend. Live trading is deliberately unavailable; a production system needs a properly deployed backend, security review, regulatory review, and explicit live-account safeguards.

API details: [Deriv OAuth 2.0](https://developers.deriv.com/docs/intro/oauth/), [authentication](https://developers.deriv.com/docs/intro/authentication/), and [Options WebSocket setup](https://developers.deriv.com/docs/options/websocket/).
