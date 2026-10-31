const markets = [
  { symbol: "EUR / USD", name: "Euro / US Dollar", category: "FX", icon: "€", price: 1.08425, digits: 5, change: 0.12, color: "#78a6ff", aliases: ["EURUSD", "EUROUSDOLLAR"] },
  { symbol: "GBP / USD", name: "British Pound / US Dollar", category: "FX", icon: "£", price: 1.27184, digits: 5, change: -0.08, color: "#d99bff", aliases: ["GBPUSD", "BRITISHPOUNDUSDOLLAR"] },
  { symbol: "USD / JPY", name: "US Dollar / Japanese Yen", category: "FX", icon: "¥", price: 149.382, digits: 3, change: 0.21, color: "#ffad78", aliases: ["USDJPY", "USDOLLARJAPANESEYEN"] },
  { symbol: "BTC / USD", name: "Bitcoin / US Dollar", category: "Crypto", icon: "₿", price: 67428.50, digits: 2, change: 1.24, color: "#f4b94f", aliases: ["BTCUSD", "BITCOINUSD"] },
  { symbol: "ETH / USD", name: "Ethereum / US Dollar", category: "Crypto", icon: "◆", price: 3521.76, digits: 2, change: -0.43, color: "#a694ff", aliases: ["ETHUSD", "ETHEREUMUSD"] },
  { symbol: "AUD / USD", name: "Australian Dollar / US Dollar", category: "FX", icon: "A", price: 0.66218, digits: 5, change: 0.05, color: "#81d6ae", aliases: ["AUDUSD", "AUSTRALIANDOLLARUSDOLLAR"] }
];

const state = {
  selected: 0,
  activeCategory: "Popular",
  balance: 10000,
  trades: [],
  sessionProfit: 0,
  points: [],
  direction: 1,
  lastPrice: 0,
  timeframe: "1m",
  tick: 0
};

const deriv = {
  authenticated: false,
  connected: false,
  accounts: [],
  account: null,
  socket: null,
  connectionId: 0,
  requestId: 0,
  pending: new Map(),
  activeSymbols: [],
  tickSubscription: null,
  enabled: false
};

const $ = (selector) => document.querySelector(selector);
const canvas = $("#price-chart");
const context = canvas.getContext("2d");
const money = (amount) => `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const currentMarket = () => markets[state.selected];

function formatPrice(market, value = market.price) {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: market.digits,
    maximumFractionDigits: market.digits
  });
}

function seedPoints() {
  const market = currentMarket();
  let value = market.price * (1 - (Math.random() * 0.003));
  state.points = [];
  for (let i = 0; i < 80; i += 1) {
    const open = value;
    value += (Math.random() - 0.48) * market.price * 0.00024;
    state.points.push({ open, close: value, high: Math.max(open, value) + Math.random() * market.price * 0.00009, low: Math.min(open, value) - Math.random() * market.price * 0.00009 });
  }
  state.lastPrice = state.points.at(-1).close;
  state.direction = state.lastPrice >= state.points.at(-2).close ? 1 : -1;
}

function drawChart() {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  context.setTransform(dpr, 0, 0, dpr, 0, 0);

  const width = rect.width;
  const height = rect.height;
  const pad = { top: 15, right: 60, bottom: 24, left: 10 };
  const chartWidth = width - pad.left - pad.right;
  const chartHeight = height - pad.top - pad.bottom;
  const allValues = state.points.flatMap((point) => [point.high, point.low]);
  const low = Math.min(...allValues);
  const high = Math.max(...allValues);
  const range = high - low || 1;
  const y = (value) => pad.top + ((high - value) / range) * chartHeight;
  const x = (index) => pad.left + (index + 0.5) * (chartWidth / state.points.length);
  const candleWidth = Math.max(2, Math.min(7, chartWidth / state.points.length * 0.58));

  context.clearRect(0, 0, width, height);
  context.font = "10px DM Sans, Segoe UI, sans-serif";
  context.textBaseline = "middle";
  context.lineWidth = 1;

  for (let i = 0; i <= 4; i += 1) {
    const gridY = pad.top + (chartHeight / 4) * i;
    context.strokeStyle = "#222a33";
    context.setLineDash([3, 5]);
    context.beginPath();
    context.moveTo(pad.left, gridY);
    context.lineTo(width - pad.right + 6, gridY);
    context.stroke();
    context.setLineDash([]);
    const value = high - (range / 4) * i;
    context.fillStyle = "#778391";
    context.textAlign = "left";
    context.fillText(formatPrice(currentMarket(), value), width - pad.right + 12, gridY);
  }

  const labelStep = Math.max(1, Math.floor(state.points.length / 6));
  for (let i = 0; i < state.points.length; i += labelStep) {
    const labelX = x(i);
    context.strokeStyle = "#202832";
    context.setLineDash([2, 6]);
    context.beginPath();
    context.moveTo(labelX, pad.top);
    context.lineTo(labelX, height - pad.bottom);
    context.stroke();
    context.setLineDash([]);
    context.fillStyle = "#778391";
    context.textAlign = "center";
    const secondsAgo = (state.points.length - i) * timeframeSeconds() / 6;
    context.fillText(`${Math.max(1, Math.round(secondsAgo))}m`, labelX, height - 10);
  }

  state.points.forEach((point, index) => {
    const rising = point.close >= point.open;
    const color = rising ? "#58d69a" : "#ff777c";
    const centerX = x(index);
    context.strokeStyle = color;
    context.fillStyle = color;
    context.beginPath();
    context.moveTo(centerX, y(point.high));
    context.lineTo(centerX, y(point.low));
    context.stroke();
    const candleY = Math.min(y(point.open), y(point.close));
    const candleHeight = Math.max(1, Math.abs(y(point.open) - y(point.close)));
    context.fillRect(centerX - candleWidth / 2, candleY, candleWidth, candleHeight);
  });

  const last = state.points.at(-1).close;
  const lastY = y(last);
  context.strokeStyle = "#c6f36a";
  context.setLineDash([4, 4]);
  context.beginPath();
  context.moveTo(pad.left, lastY);
  context.lineTo(width - pad.right + 5, lastY);
  context.stroke();
  context.setLineDash([]);
  context.fillStyle = "#c6f36a";
  context.fillRect(width - pad.right + 7, lastY - 9, pad.right - 9, 18);
  context.fillStyle = "#11170d";
  context.textAlign = "center";
  context.fillText(formatPrice(currentMarket(), last), width - pad.right + 7 + (pad.right - 9) / 2, lastY);
}

function timeframeSeconds() {
  return Number.parseInt(state.timeframe, 10) || 1;
}

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers }
  });
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Start python server.py and open Northstar at http://localhost:8000 before connecting Deriv.");
    }
    throw error;
  }
  if (!response.ok) throw new Error(payload.error || `Local server returned HTTP ${response.status}.`);
  return payload;
}

function updateConnectionUi() {
  $("#deriv-connect").textContent = deriv.authenticated ? "Disconnect Deriv" : "Connect Deriv";
  $("#deriv-connect").disabled = false;
  $("#deriv-connection").hidden = !deriv.authenticated || deriv.connected;
  $("#deriv-account-connect").disabled = !deriv.authenticated || deriv.connected || !deriv.accounts.length;
  $("#mode-pill").lastChild.textContent = deriv.connected ? " DERIV DEMO" : " PRACTICE MODE";
  $("#balance-label").textContent = deriv.connected ? "DERIV DEMO BALANCE" : "DEMO BALANCE";
  $("#order-disclaimer").textContent = deriv.connected
    ? "Demo account only. Orders use virtual funds."
    : "Practice only. No real money is used.";
  $("#market-note").innerHTML = deriv.connected
    ? `<span class="live-dot"></span> Deriv demo quotes <span>·</span> Virtual account`
    : `<span class="live-dot"></span> Simulated prices <span>·</span> For practice only`;
  $("#chart-data-status").innerHTML = deriv.connected
    ? `<i class="live-dot"></i> Deriv demo feed`
    : `<i class="live-dot"></i> Simulated data`;
}

async function loadDemoAccounts() {
  const response = await apiRequest("/api/accounts");
  deriv.accounts = response.accounts;
  const selector = $("#deriv-account");
  selector.replaceChildren();
  deriv.accounts.forEach((account) => {
    const option = document.createElement("option");
    option.value = account.account_id;
    option.textContent = `${account.loginid} · ${account.currency} demo`;
    selector.append(option);
  });
  updateConnectionUi();
  if (!deriv.accounts.length) {
    showToast("No Deriv demo Options account was found. Create one in your Deriv account, then reconnect.");
  }
}

async function connectToDeriv() {
  try {
    const status = await apiRequest("/api/status");
    if (!status.configured) {
      showToast("Set up the Deriv OAuth client in .env and run python server.py first.");
      return;
    }
    if (status.authenticated) {
      deriv.authenticated = true;
      await loadDemoAccounts();
      return;
    }
    const response = await apiRequest("/api/oauth/start", { method: "POST", body: "{}" });
    window.location.assign(response.authorization_url);
  } catch (error) {
    showToast(error.message || "Could not start Deriv sign-in. Start the local server and try again.");
  }
}

async function handleOAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const oauthState = params.get("state");
  const oauthError = params.get("error");
  if (!code && !oauthError) return;
  window.history.replaceState(null, "", window.location.pathname);
  if (oauthError) {
    showToast("Deriv sign-in was cancelled or denied.");
    return;
  }
  try {
    await apiRequest("/api/oauth/exchange", {
      method: "POST",
      body: JSON.stringify({ code, state: oauthState })
    });
    deriv.authenticated = true;
    await loadDemoAccounts();
    showToast("Deriv connected. Choose a demo account to continue.");
  } catch (error) {
    showToast(error.message || "Deriv sign-in could not be completed.");
  }
}

function rejectPendingRequests(message) {
  deriv.pending.forEach((request) => {
    clearTimeout(request.timeout);
    request.reject(new Error(message));
  });
  deriv.pending.clear();
}

function sendDerivRequest(payload, expectedType) {
  if (!deriv.socket || deriv.socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("Deriv demo connection is not open."));
  }
  const reqId = ++deriv.requestId;
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      deriv.pending.delete(reqId);
      reject(new Error("Deriv did not respond in time. Please try again."));
    }, 12000);
    deriv.pending.set(reqId, { expectedType, resolve, reject, timeout });
    try {
      deriv.socket.send(JSON.stringify({ ...payload, req_id: reqId }));
    } catch (error) {
      clearTimeout(timeout);
      deriv.pending.delete(reqId);
      reject(error);
    }
  });
}

function matchDerivMarkets(activeSymbols) {
  deriv.activeSymbols = activeSymbols;
  markets.forEach((market) => {
    const symbol = activeSymbols.find((entry) => {
      const code = String(entry.underlying_symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      const name = String(entry.underlying_symbol_name || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      return market.aliases.some((alias) => code.endsWith(alias) || name.includes(alias));
    });
    market.derivSymbol = symbol ? symbol.underlying_symbol : null;
    market.basePrice = null;
  });
  const firstSupported = markets.findIndex((market) => market.derivSymbol);
  if (firstSupported < 0) throw new Error("No matching supported markets are active on this Deriv demo account.");
  if (!currentMarket().derivSymbol) state.selected = firstSupported;
  renderSelectedMarket();
}

async function loadDerivHistory(market = currentMarket()) {
  if (!market.derivSymbol) return;
  const response = await sendDerivRequest({
    ticks_history: market.derivSymbol,
    count: 80,
    end: "latest",
    style: "ticks"
  }, "history");
  const prices = response.history && response.history.prices;
  if (!Array.isArray(prices) || !prices.length) {
    throw new Error(`Deriv did not provide price history for ${market.symbol}.`);
  }
  state.points = prices.map((price, index) => {
    const close = Number(price);
    const open = index ? Number(prices[index - 1]) : close;
    return { open, close, high: Math.max(open, close), low: Math.min(open, close) };
  }).filter((point) => Number.isFinite(point.open) && Number.isFinite(point.close));
  if (!state.points.length) throw new Error(`Deriv returned invalid price history for ${market.symbol}.`);
  state.lastPrice = state.points.at(-1).close;
  state.tick = 0;
  market.price = state.lastPrice;
  renderSelectedMarket();
}

function applyDerivTick(tick) {
  const market = markets.find((item) => item.derivSymbol === tick.symbol);
  const quote = Number(tick.quote);
  if (!market || !Number.isFinite(quote)) return;
  const previous = market.price;
  if (!market.basePrice) market.basePrice = quote;
  market.price = quote;
  market.digits = Number.isFinite(Number(tick.pip_size)) ? Number(tick.pip_size) : market.digits;
  market.change = market.basePrice ? ((quote - market.basePrice) / market.basePrice) * 100 : 0;
  if (market !== currentMarket()) {
    renderMarkets();
    return;
  }
  state.direction = quote >= previous ? 1 : -1;
  state.lastPrice = quote;
  if (!state.points.length) {
    state.points.push({ open: quote, close: quote, high: quote, low: quote });
  }
  const currentPoint = state.points.at(-1);
  currentPoint.close = quote;
  currentPoint.high = Math.max(currentPoint.high, quote);
  currentPoint.low = Math.min(currentPoint.low, quote);
  state.tick += 1;
  if (state.tick % 3 === 0) {
    state.points.push({ open: quote, close: quote, high: quote, low: quote });
    if (state.points.length > 80) state.points.shift();
  }
  renderSelectedMarket();
}

function handleOpenContract(contract) {
  const trade = state.trades.find((item) => item.contractId === contract.contract_id);
  if (!trade) return;
  if (contract.is_sold) {
    const profit = Number(contract.profit);
    if (!Number.isFinite(profit)) {
      showToast("Deriv closed the contract without a readable result.");
      return;
    }
    trade.status = profit >= 0 ? "Won" : "Lost";
    trade.statusClass = profit >= 0 ? "won" : "lost";
    trade.result = profit;
    state.sessionProfit += profit;
    renderTrades();
  }
}

function handleDerivMessage(message) {
  if (message.error) {
    const error = new Error(message.error.message || "Deriv returned an error.");
    const pending = deriv.pending.get(message.req_id);
    if (pending) {
      clearTimeout(pending.timeout);
      deriv.pending.delete(message.req_id);
      pending.reject(error);
    } else {
      showToast(error.message);
    }
    return;
  }
  const pending = deriv.pending.get(message.req_id);
  if (pending && message.msg_type === pending.expectedType) {
    clearTimeout(pending.timeout);
    deriv.pending.delete(message.req_id);
    pending.resolve(message);
  }
  if (message.msg_type === "tick" && message.tick) applyDerivTick(message.tick);
  if (message.msg_type === "balance" && message.balance) {
    state.balance = Number(message.balance.balance);
    if (Number.isFinite(state.balance)) $("#balance").textContent = money(state.balance);
  }
  if (message.msg_type === "proposal_open_contract" && message.proposal_open_contract) {
    handleOpenContract(message.proposal_open_contract);
  }
}

async function initializeDerivSocket(connectionId) {
  const symbolsResponse = await sendDerivRequest({ active_symbols: "brief" }, "active_symbols");
  if (connectionId !== deriv.connectionId) return;
  matchDerivMarkets(symbolsResponse.active_symbols || []);
  const balanceResponse = await sendDerivRequest({ balance: 1, subscribe: 1 }, "balance");
  state.balance = Number(balanceResponse.balance && balanceResponse.balance.balance);
  if (!Number.isFinite(state.balance)) throw new Error("Deriv returned an invalid demo balance.");
  $("#balance").textContent = money(state.balance);
  const tickSymbols = markets.filter((market) => market.derivSymbol).map((market) => market.derivSymbol);
  if (!tickSymbols.length) throw new Error("No supported Deriv demo markets are available.");
  await loadDerivHistory();
  await sendDerivRequest({ ticks: tickSymbols, subscribe: 1 }, "tick");
  if (connectionId !== deriv.connectionId) return;
  deriv.connected = true;
  deriv.enabled = true;
  state.trades = [];
  state.sessionProfit = 0;
  renderTrades();
  updateConnectionUi();
  renderSelectedMarket();
  showToast("Deriv demo account connected. Orders use virtual funds only.");
}

async function connectDemoAccount() {
  const accountId = $("#deriv-account").value;
  if (!accountId) {
    showToast("Choose a Deriv demo account first.");
    return;
  }
  const button = $("#deriv-account-connect");
  button.disabled = true;
  try {
    const response = await apiRequest("/api/deriv/demo-websocket", {
      method: "POST",
      body: JSON.stringify({ account_id: accountId })
    });
    deriv.account = deriv.accounts.find((account) => account.account_id === accountId) || null;
    state.trades.forEach((trade) => {
      if (trade.timerId) window.clearTimeout(trade.timerId);
    });
    state.trades = [];
    state.sessionProfit = 0;
    state.balance = 10000;
    renderTrades();
    if (deriv.socket) deriv.socket.close();
    const connectionId = ++deriv.connectionId;
    const socket = new WebSocket(response.websocket_url);
    deriv.socket = socket;
    socket.addEventListener("open", () => {
      if (connectionId !== deriv.connectionId) return;
      deriv.connected = true;
      deriv.enabled = true;
      updateConnectionUi();
      initializeDerivSocket(connectionId).catch((error) => {
        if (connectionId !== deriv.connectionId) return;
        showToast(error.message || "Could not initialize Deriv demo data.");
        socket.close();
      });
    });
    socket.addEventListener("message", (event) => {
      if (connectionId !== deriv.connectionId) return;
      try {
        handleDerivMessage(JSON.parse(event.data));
      } catch (error) {
        showToast(error instanceof SyntaxError
          ? "Deriv sent an unreadable WebSocket message."
          : error.message || "Could not process a Deriv WebSocket message.");
      }
    });
    socket.addEventListener("error", () => {
      if (connectionId === deriv.connectionId) showToast("Deriv WebSocket connection failed.");
    });
    socket.addEventListener("close", () => {
      if (connectionId !== deriv.connectionId) return;
      deriv.connected = false;
      deriv.enabled = false;
      rejectPendingRequests("Deriv demo connection closed.");
      updateConnectionUi();
      showToast("Deriv connection closed. Reconnect it or disconnect Deriv to use simulation.");
    });
  } catch (error) {
    showToast(error.message || "Could not connect the Deriv demo account.");
  } finally {
    button.disabled = false;
  }
}

async function disconnectDeriv() {
  if (deriv.connected && state.trades.some((trade) => trade.status === "Open")) {
    showToast("Wait for open Deriv demo trades to settle before disconnecting.");
    return;
  }
  deriv.connectionId += 1;
  if (deriv.socket) {
    deriv.socket.close();
    deriv.socket = null;
  }
  rejectPendingRequests("Deriv demo account disconnected.");
  try {
    await apiRequest("/api/logout", { method: "POST", body: "{}" });
  } catch (error) {
    showToast(error.message || "Could not clear the local Deriv session.");
  }
  deriv.authenticated = false;
  deriv.connected = false;
  deriv.enabled = false;
  deriv.accounts = [];
  deriv.account = null;
  markets.forEach((market) => { market.derivSymbol = null; market.basePrice = null; });
  state.balance = 10000;
  state.trades = [];
  state.sessionProfit = 0;
  seedPoints();
  renderTrades();
  renderSelectedMarket();
  updateConnectionUi();
}

function renderMarkets() {
  const query = $("#market-search").value.trim().toLowerCase();
  const visible = markets.map((market, index) => ({ market, index })).filter(({ market }) => {
    if (deriv.connected && !market.derivSymbol) return false;
    const categoryMatches = state.activeCategory === "Popular" || market.category === state.activeCategory;
    return categoryMatches && `${market.symbol} ${market.name}`.toLowerCase().includes(query);
  });

  $("#market-list").innerHTML = visible.map(({ market, index }) => `
    <button class="market-row ${index === state.selected ? "selected" : ""}" data-market="${index}" aria-pressed="${index === state.selected}">
      <span class="market-icon" style="color:${market.color}">${market.icon}</span>
      <span class="market-meta"><strong>${market.symbol}</strong><span>${market.name}</span></span>
      <span class="market-value"><strong>${formatPrice(market)}</strong><span class="${market.change >= 0 ? "positive" : "negative"}">${market.change >= 0 ? "+" : ""}${market.change.toFixed(2)}%</span></span>
    </button>
  `).join("") || `<div class="market-empty">No markets match your search.</div>`;
}

function renderSelectedMarket() {
  const market = currentMarket();
  $("#instrument-name").textContent = market.symbol;
  $("#instrument-subtitle").innerHTML = `${market.name} <i class="live-dot"></i>`;
  $("#instrument-icon").textContent = market.icon;
  $("#instrument-icon").style.color = market.color;
  $("#order-market-icon").textContent = market.icon;
  $("#order-market-icon").style.color = market.color;
  $("#order-market-name").textContent = market.symbol;
  $("#current-price").textContent = formatPrice(market, state.lastPrice);
  $("#price-change").textContent = `${market.change >= 0 ? "+" : ""}${market.change.toFixed(2)}%`;
  $("#price-change").className = market.change >= 0 ? "positive" : "negative";
  renderMarkets();
  drawChart();
}

async function placeDerivTrade(direction, amount, duration) {
  const market = currentMarket();
  if (!deriv.connected || !market.derivSymbol || !deriv.account) {
    showToast("Connect a Deriv demo account and select an available market first.");
    return;
  }
  const buttons = [$("#buy-button"), $("#sell-button")];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const quote = await sendDerivRequest({
      proposal: 1,
      amount,
      basis: "stake",
      contract_type: direction === "up" ? "CALL" : "PUT",
      currency: deriv.account.currency,
      duration,
      duration_unit: "s",
      underlying_symbol: market.derivSymbol
    }, "proposal");
    const proposal = quote.proposal;
    if (!proposal || typeof proposal.id !== "string" || !Number.isFinite(Number(proposal.ask_price))) {
      throw new Error("Deriv returned an invalid price proposal.");
    }
    const payout = Number(proposal.payout);
    if (Number.isFinite(payout)) {
      $("#potential-return").textContent = money(Math.max(0, payout - amount));
      $("#potential-return-sign").hidden = false;
    }
    const result = await sendDerivRequest({
      buy: proposal.id,
      price: Number(proposal.ask_price)
    }, "buy");
    if (!result.buy || !Number.isFinite(Number(result.buy.contract_id))) {
      throw new Error("Deriv did not confirm the demo order.");
    }
    const trade = {
      id: `${Date.now()}-${Math.random()}`,
      contractId: Number(result.buy.contract_id),
      direction,
      amount: Number(result.buy.buy_price),
      duration,
      symbol: market.symbol,
      status: "Open",
      statusClass: "",
      result: null,
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    };
    state.trades.unshift(trade);
    if (Number.isFinite(Number(result.buy.balance_after))) {
      state.balance = Number(result.buy.balance_after);
      $("#balance").textContent = money(state.balance);
    }
    renderTrades();
    showToast(`Deriv demo order placed on ${market.symbol}. No real money is used.`);
    sendDerivRequest({
      proposal_open_contract: 1,
      contract_id: trade.contractId,
      subscribe: 1
    }, "proposal_open_contract").catch((error) => showToast(error.message));
  } catch (error) {
    showToast(error.message || "Deriv could not place the demo order.");
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

function renderTrades() {
  const count = state.trades.length;
  $("#trade-count").textContent = `${count} ${count === 1 ? "trade" : "trades"}`;
  $("#open-trades").textContent = state.trades.filter((trade) => trade.status === "Open").length;
  const pl = $("#session-pl");
  pl.textContent = `${state.sessionProfit >= 0 ? "+" : "-"}${money(Math.abs(state.sessionProfit))}`;
  pl.className = state.sessionProfit > 0 ? "positive" : state.sessionProfit < 0 ? "negative" : "neutral";

  if (!count) {
    $("#trade-list").innerHTML = `<div class="empty-state"><span class="empty-icon"><svg viewBox="0 0 24 24"><path d="M4 19V5m0 14h16M7 15l4-4 3 2 5-7"/></svg></span><strong>No trades yet</strong><span>Your practice trades will appear here.</span></div>`;
    return;
  }

  $("#trade-list").innerHTML = state.trades.slice(0, 5).map((trade) => `
    <div class="trade-row">
      <div class="trade-description">
        <span class="direction-icon ${trade.direction}"><svg viewBox="0 0 24 24"><path d="${trade.direction === "up" ? "M7 17 17 7M7 7h10v10" : "M7 7 17 17M17 7v10H7"}"/></svg></span>
        <div><strong>${trade.symbol} · ${trade.direction === "up" ? "Up" : "Down"}</strong><span>${money(trade.amount)} · ${trade.duration}s</span></div>
      </div>
      <span class="trade-status ${trade.statusClass}">${trade.status}</span>
      <div class="trade-result"><strong class="${trade.result === null ? "" : trade.result >= 0 ? "positive" : "negative"}">${trade.result === null ? "—" : `${trade.result >= 0 ? "+" : "-"}${money(Math.abs(trade.result))}`}</strong><span>${trade.time}</span></div>
    </div>
  `).join("");
}

function updatePotentialReturn() {
  const amount = Number($("#trade-amount").value);
  const valid = Number.isFinite(amount) && amount >= 1 && amount <= 10000;
  $("#potential-return-sign").hidden = !valid;
  $("#potential-return").textContent = valid
    ? money(amount * 0.8)
    : "—";
}

function showToast(message) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  $("#toast-region").append(toast);
  window.setTimeout(() => toast.remove(), 3500);
}

function placeTrade(direction) {
  const amount = Number($("#trade-amount").value);
  const duration = Number($("#trade-duration").value);
  if (!Number.isFinite(amount) || amount < 1 || amount > 10000) {
    showToast("Enter a trade amount from $1 to $10,000.");
    $("#trade-amount").focus();
    return;
  }
  if (amount > state.balance) {
    showToast("That amount is higher than your demo balance.");
    $("#trade-amount").focus();
    return;
  }

  if (deriv.authenticated || deriv.enabled) {
    if (!deriv.connected) {
      showToast("Reconnect the Deriv demo account before placing an order.");
      return;
    }
    placeDerivTrade(direction, amount, duration);
    return;
  }

  state.balance -= amount;
  $("#balance").textContent = money(state.balance);
  const trade = {
    id: `${Date.now()}-${Math.random()}`,
    direction,
    amount,
    duration,
    symbol: currentMarket().symbol,
    startPrice: state.lastPrice,
    status: "Open",
    statusClass: "",
    result: null,
    time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
  };
  state.trades.unshift(trade);
  renderTrades();
  showToast(`${direction === "up" ? "Up" : "Down"} practice trade opened on ${trade.symbol}.`);

  trade.timerId = window.setTimeout(() => {
    const closePrice = currentMarket().symbol === trade.symbol ? state.lastPrice : trade.startPrice * (1 + (Math.random() - 0.5) * 0.0004);
    const won = direction === "up" ? closePrice > trade.startPrice : closePrice < trade.startPrice;
    const payout = won ? amount * 0.8 : -amount;
    trade.status = won ? "Won" : "Lost";
    trade.statusClass = won ? "won" : "lost";
    trade.result = payout;
    state.balance += won ? amount * 1.8 : 0;
    state.sessionProfit += payout;
    $("#balance").textContent = money(state.balance);
    renderTrades();
    showToast(won ? `Practice trade won: +${money(amount * 0.8)} demo return.` : "Practice trade closed: demo stake was lost.");
  }, duration * 1000);
}

function advancePrice() {
  const market = currentMarket();
  const previous = state.lastPrice;
  const volatility = market.price * (market.category === "Crypto" ? 0.00012 : 0.000035);
  const move = (Math.random() - 0.49) * volatility;
  state.lastPrice += move;
  market.price += move;
  state.direction = state.lastPrice >= previous ? 1 : -1;
  state.tick += 1;

  const last = state.points.at(-1);
  last.close = state.lastPrice;
  last.high = Math.max(last.high, state.lastPrice);
  last.low = Math.min(last.low, state.lastPrice);
  if (state.tick % 3 === 0) {
    const open = state.points.at(-1).close;
    let close = open + (Math.random() - 0.49) * volatility * 2;
    state.points.push({ open, close, high: Math.max(open, close), low: Math.min(open, close) });
    if (state.points.length > 80) state.points.shift();
  }

  market.change += (Math.random() - 0.5) * 0.01;
  renderSelectedMarket();
}

$("#market-list").addEventListener("click", (event) => {
  const row = event.target.closest("[data-market]");
  if (!row) return;
  state.selected = Number(row.dataset.market);
  renderSelectedMarket();
  if (deriv.connected) {
    loadDerivHistory().catch((error) => showToast(error.message));
  } else {
    seedPoints();
    renderSelectedMarket();
  }
});

$("#market-search").addEventListener("input", renderMarkets);
document.querySelectorAll(".market-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".market-tab").forEach((item) => {
      item.classList.toggle("is-selected", item === tab);
      item.setAttribute("aria-selected", item === tab ? "true" : "false");
    });
    state.activeCategory = tab.textContent.trim();
    renderMarkets();
  });
});

document.querySelectorAll(".amount-presets button").forEach((button) => {
  button.addEventListener("click", () => {
    $("#trade-amount").value = button.dataset.amount;
    document.querySelectorAll(".amount-presets button").forEach((item) => item.classList.toggle("preset-active", item === button));
    updatePotentialReturn();
  });
});

$("#trade-amount").addEventListener("input", () => {
  document.querySelectorAll(".amount-presets button").forEach((button) => button.classList.toggle("preset-active", Number(button.dataset.amount) === Number($("#trade-amount").value)));
  updatePotentialReturn();
});
$("#buy-button").addEventListener("click", () => placeTrade("up"));
$("#sell-button").addEventListener("click", () => placeTrade("down"));
$("#deriv-connect").addEventListener("click", () => {
  if (deriv.authenticated) disconnectDeriv();
  else connectToDeriv();
});
$("#deriv-account-connect").addEventListener("click", connectDemoAccount);

document.querySelectorAll(".timeframe").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".timeframe").forEach((item) => item.classList.toggle("is-current", item === button));
    state.timeframe = button.textContent.trim();
    drawChart();
  });
});

canvas.addEventListener("mousemove", (event) => {
  const rect = canvas.getBoundingClientRect();
  const index = Math.floor(((event.clientX - rect.left - 10) / (rect.width - 70)) * state.points.length);
  const point = state.points[Math.max(0, Math.min(state.points.length - 1, index))];
  const tooltip = $("#chart-tooltip");
  tooltip.textContent = formatPrice(currentMarket(), point.close);
  tooltip.style.display = "block";
  tooltip.style.left = `${Math.min(event.clientX - rect.left + 10, rect.width - 105)}px`;
  tooltip.style.top = `${Math.max(4, event.clientY - rect.top - 27)}px`;
});
canvas.addEventListener("mouseleave", () => { $("#chart-tooltip").style.display = "none"; });
window.addEventListener("resize", drawChart);

$(".search-trigger").addEventListener("click", () => $("#market-search").focus());
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    $("#market-search").focus();
  }
});

seedPoints();
renderSelectedMarket();
renderTrades();
updatePotentialReturn();
updateConnectionUi();
handleOAuthCallback();
apiRequest("/api/status").then(async (status) => {
  if (status.authenticated) {
    deriv.authenticated = true;
    await loadDemoAccounts();
  }
  updateConnectionUi();
}).catch(() => {
  $("#deriv-connect").title = "Start the local server with python server.py to connect Deriv.";
});
window.setInterval(() => {
  if (!deriv.enabled) advancePrice();
}, 1000);
