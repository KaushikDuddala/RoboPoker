const SUITS = ["s", "h", "d", "c"];
const RANKS = "23456789TJQKA".split("");
const SUIT_SYMBOLS = { s: "S", h: "H", d: "D", c: "C" };
const REVEALED_BY_PHASE = [0, 3, 4, 5, 5];
const API_BASE = deriveApiBase();

const FULL_DECK = [];
for (const rank of RANKS) {
  for (const suit of SUITS) {
    FULL_DECK.push(`${rank}${suit}`);
  }
}

const CARD_META = Object.fromEntries(
  FULL_DECK.map((code) => [
    code,
    {
      rank: "23456789TJQKA".indexOf(code[0]) + 2,
      suit: code[1],
    },
  ]),
);

const app = {
  state: null,
  eventSource: null,
  activeView: "betting",
  lastOdds: [],
  authMode: "login",
};

const els = {};

init();

function init() {
  cacheEls();
  bindEvents();
  bootstrap();
}

function cacheEls() {
  const ids = [
    "auth-panel",
    "app-main",
    "auth-username",
    "auth-password",
    "auth-mode-login",
    "auth-mode-register",
    "btn-auth-submit",
    "btn-toggle-password",
    "btn-logout",
    "auth-status",
    "session-label",
    "connection-label",
    "tab-betting",
    "tab-show",
    "view-betting",
    "view-show",
    "phase-label",
    "pot-label",
    "current-bet-label",
    "to-act-label",
    "hidden-board-cards",
    "table-status",
    "players-body",
    "raise-amount",
    "btn-check-call",
    "btn-raise",
    "btn-fold",
    "betting-status",
    "action-log",
    "robot-cam-url",
    "board-cam-url",
    "apply-robot-cam",
    "apply-board-cam",
    "robot-cam-link",
    "board-cam-link",
    "vision-robot-cards",
    "vision-board-card",
    "vision-board-slot",
    "btn-vision-robot",
    "btn-vision-board",
    "vision-status",
    "hole-input-body",
    "board-inputs",
    "btn-random-hand",
    "btn-clear-cards",
    "cards-status",
    "show-board-cards",
    "show-player-body",
    "sim-count",
    "btn-run-odds",
    "odds-body",
    "odds-status",
    "my-cards-section",
    "my-card-0",
    "my-card-1",
    "my-cards-win-pct",
    "my-cards-status",
  ];

  for (const id of ids) {
    els[id] = document.getElementById(id);
  }
}

function bindEvents() {
  els["auth-mode-login"].addEventListener("click", () => setAuthMode("login"));
  els["auth-mode-register"].addEventListener("click", () => setAuthMode("register"));
  els["btn-auth-submit"].addEventListener("click", () => submitAuth(app.authMode));
  els["btn-toggle-password"].addEventListener("click", togglePasswordVisibility);
  els["btn-logout"].addEventListener("click", logout);

  [els["auth-username"], els["auth-password"]].forEach((node) => {
    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submitAuth(app.authMode);
      }
    });
  });

  [els["tab-betting"], els["tab-show"]].forEach((tab) => {
    tab.addEventListener("click", () => switchView(tab.dataset.view));
  });

  els["btn-check-call"].addEventListener("click", () => doAction("check_call"));
  els["btn-raise"].addEventListener("click", () => {
    const amount = Number.parseInt(els["raise-amount"].value, 10);
    doAction("raise", { amount });
  });
  els["btn-fold"].addEventListener("click", () => doAction("fold"));

  els["apply-robot-cam"].addEventListener("click", () => updateCameras({ robotUrl: els["robot-cam-url"].value.trim() }));
  els["apply-board-cam"].addEventListener("click", () => updateCameras({ boardUrl: els["board-cam-url"].value.trim() }));

  els["btn-vision-robot"].addEventListener("click", sendVisionRobot);
  els["btn-vision-board"].addEventListener("click", sendVisionBoard);

  els["btn-random-hand"].addEventListener("click", randomDemoHand);
  els["btn-clear-cards"].addEventListener("click", clearCards);
  els["btn-run-odds"].addEventListener("click", runOddsSimulation);

  els["players-body"].addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-seat-action]");
    if (!button) return;

    const action = button.dataset.seatAction;
    const seatIndex = Number.parseInt(button.dataset.seatIndex, 10);

    try {
      if (action === "join") {
        await postJson("/api/seat/join", { seatIndex });
        setStatus("table-status", `Joined seat ${seatIndex}.`, "good");
      } else if (action === "leave") {
        await postJson("/api/seat/leave", {});
        setStatus("table-status", "You left your seat.", "good");
      }
    } catch (error) {
      setStatus("table-status", error.message, "bad");
    }
  });

  els["hole-input-body"].addEventListener("change", onHoleInputChange);
  els["board-inputs"].addEventListener("change", onBoardInputChange);

  els["my-card-0"].addEventListener("change", onMyCardChange);
  els["my-card-1"].addEventListener("change", onMyCardChange);
}

async function bootstrap() {
  try {
    await ensureBackendReachable();
    const me = await getJson("/api/auth/me");
    if (!me.ok) {
      showAuth();
      return;
    }
    showApp();
    await refreshState();
    startStream();
  } catch {
    showAuth();
    setStatus(
      "auth-status",
      `Backend unavailable at ${API_BASE || window.location.origin}. Start the Node server with "npm start".`,
      "bad",
    );
  }
}

function showAuth() {
  els["auth-panel"].hidden = false;
  els["app-main"].hidden = true;
  els["btn-logout"].hidden = true;
  els["session-label"].textContent = "Not logged in";
  setConnectionLabel("Offline", "bad");
  setAuthMode("login");
  els["auth-username"].focus();
}

function showApp() {
  els["auth-panel"].hidden = true;
  els["app-main"].hidden = false;
  els["btn-logout"].hidden = false;
}

async function submitAuth(mode) {
  const username = els["auth-username"].value.trim().toLowerCase();
  const password = els["auth-password"].value;

  if (!username || !password) {
    setStatus("auth-status", "Enter username and password.", "bad");
    return;
  }

  const endpoint = mode === "register" ? "/api/auth/register" : "/api/auth/login";

  try {
    await postJson(endpoint, { username, password });
    setStatus("auth-status", mode === "register" ? "Registered and logged in." : "Logged in.", "good");
    els["auth-password"].value = "";
    showApp();
    await refreshState();
    startStream();
  } catch (error) {
    setStatus("auth-status", error.message, "bad");
  }
}

async function logout() {
  try {
    await postJson("/api/auth/logout", {});
  } catch {
    // best effort
  }
  if (app.eventSource) {
    app.eventSource.close();
    app.eventSource = null;
  }
  app.state = null;
  app.lastOdds = [];
  showAuth();
}

async function refreshState() {
  const response = await getJson("/api/state");
  if (!response.ok) throw new Error(response.message || "Failed to fetch state");
  app.state = response.state;
  app.lastOdds = [];
  renderAll();
}

function startStream() {
  if (app.eventSource) {
    app.eventSource.close();
  }

  const source = new EventSource(apiUrl("/api/stream"), { withCredentials: true });
  app.eventSource = source;

  source.addEventListener("open", () => {
    setConnectionLabel("Live", "good");
  });

  source.addEventListener("error", () => {
    setConnectionLabel("Reconnecting", "bad");
  });

  source.addEventListener("state", (event) => {
    try {
      const payload = JSON.parse(event.data);
      app.state = payload;
      app.lastOdds = [];
      renderAll();
    } catch {
      // ignore malformed payload
    }
  });
}

function renderAll() {
  if (!app.state) return;
  renderSession();
  renderBettingView();
  renderShowView();
  renderOdds();
  renderCameraLinks();
}

function renderSession() {
  const me = app.state.me;
  const seatLabel = me.seatIndex == null ? "spectator" : `seat ${me.seatIndex}`;
  els["session-label"].textContent = `${me.username} | ${seatLabel}`;
}

function switchView(viewName) {
  app.activeView = viewName;
  const betting = viewName === "betting";
  els["view-betting"].classList.toggle("is-active", betting);
  els["view-show"].classList.toggle("is-active", !betting);
  els["tab-betting"].classList.toggle("is-active", betting);
  els["tab-show"].classList.toggle("is-active", !betting);
  els["tab-betting"].setAttribute("aria-selected", String(betting));
  els["tab-show"].setAttribute("aria-selected", String(!betting));
}

function renderBettingView() {
  const table = app.state.table;
  const phases = app.state.phases;
  const meSeat = app.state.me.seatIndex;

  els["phase-label"].textContent = phases[table.phaseIndex] || "-";
  els["pot-label"].textContent = money(table.pot);
  els["current-bet-label"].textContent = money(table.currentBet);
  els["to-act-label"].textContent = table.currentTurn == null ? "-" : table.players[table.currentTurn].name;

  const toActLabel = table.currentTurn == null ? "No one" : `${table.players[table.currentTurn].name} (seat ${table.currentTurn})`;
  setStatus("table-status", `Dealer seat: ${table.dealerIndex}. To act: ${toActLabel}.`);

  const playerRows = table.players
    .map((player) => {
      const status = player.occupied
        ? player.folded
          ? "Folded"
          : player.stack <= 0
            ? "All-in"
            : "Active"
        : "Open";

      const classes = [
        player.seatIndex === table.currentTurn ? "current" : "",
        player.folded ? "folded" : "",
        player.isRobot ? "robot" : "",
      ]
        .filter(Boolean)
        .join(" ");

      let seatAction = "-";
      if (!player.isRobot) {
        if (!player.occupied) {
          seatAction = `<button class="action secondary" data-seat-action="join" data-seat-index="${player.seatIndex}" type="button">Join</button>`;
        } else if (meSeat === player.seatIndex) {
          seatAction = `<button class="action ghost" data-seat-action="leave" data-seat-index="${player.seatIndex}" type="button">Leave</button>`;
        }
      }

      const contributed = player.totalContributed || 0;
      return `
        <tr class="${classes}">
          <td>${player.seatIndex}</td>
          <td>${escapeHtml(player.name)}</td>
          <td>${money(player.stack)}</td>
          <td>${contributed > 0 ? money(contributed) : "-"}</td>
          <td>${status}</td>
          <td>${seatAction}</td>
        </tr>
      `;
    })
    .join("");

  els["players-body"].innerHTML = playerRows;

  els["hidden-board-cards"].innerHTML = "";
  for (let i = 0; i < 5; i += 1) {
    const card = table.board[i];
    const node = document.createElement("div");
    node.className = card ? "hidden-card revealed" : "hidden-card";
    node.textContent = card ? prettyCard(card) : "-";
    node.style.opacity = card ? "1" : "0.4";
    els["hidden-board-cards"].appendChild(node);
  }

  els["action-log"].innerHTML = table.actionLog.map((line) => `<li>${escapeHtml(line)}</li>`).join("");

  const myTurn = meSeat != null && table.currentTurn === meSeat;
  const myPlayer = meSeat != null ? table.players[meSeat] : null;
  const toCall = myTurn && myPlayer ? Math.max(0, table.currentBet - myPlayer.currentBet) : 0;

  els["btn-check-call"].textContent = toCall === 0 ? "Check" : `Call ${money(toCall)}`;
  els["btn-check-call"].disabled = !myTurn;
  els["btn-raise"].disabled = !myTurn;
  els["btn-fold"].disabled = !myTurn;

  const isSeated = meSeat != null;
  els["my-cards-section"].hidden = !isSeated;
  if (isSeated && myPlayer) {
    const serverCard0 = myPlayer.hole[0] || "";
    const serverCard1 = myPlayer.hole[1] || "";
    if (serverCard0 && els["my-card-0"].value !== serverCard0) els["my-card-0"].value = serverCard0;
    if (serverCard1 && els["my-card-1"].value !== serverCard1) els["my-card-1"].value = serverCard1;
    updateMyCardsWinPct();
  }
}

async function onMyCardChange() {
  if (!app.state) return;
  const meSeat = app.state.me.seatIndex;
  if (meSeat == null) return;

  const raw0 = els["my-card-0"].value.trim();
  const raw1 = els["my-card-1"].value.trim();
  const card0 = normalizeCardInput(raw0);
  const card1 = normalizeCardInput(raw1);

  if (raw0 && !card0) { setStatus("my-cards-status", `Invalid card: ${raw0}`, "bad"); return; }
  if (raw1 && !card1) { setStatus("my-cards-status", `Invalid card: ${raw1}`, "bad"); return; }

  const patches = [];
  if (card0 !== null || raw0 === "") patches.push(postJson("/api/cards/patch", { kind: "hole", seatIndex: meSeat, slot: 0, card: card0 }));
  if (card1 !== null || raw1 === "") patches.push(postJson("/api/cards/patch", { kind: "hole", seatIndex: meSeat, slot: 1, card: card1 }));

  try {
    await Promise.all(patches);
    setStatus("my-cards-status", "Cards saved.", "good");
    updateMyCardsWinPct();
  } catch (err) {
    setStatus("my-cards-status", err.message, "bad");
  }
}

function updateMyCardsWinPct() {
  if (!app.state) return;
  const meSeat = app.state.me.seatIndex;
  if (meSeat == null) { els["my-cards-win-pct"].textContent = ""; return; }

  const card0 = normalizeCardInput(els["my-card-0"].value);
  const card1 = normalizeCardInput(els["my-card-1"].value);
  if (!card0 || !card1) { els["my-cards-win-pct"].textContent = ""; return; }

  const board        = app.state.table.board.filter(Boolean);
  const allKnown     = [card0, card1, ...board];
  const remaining    = FULL_DECK.filter((c) => !allKnown.includes(c));
  const cardsNeeded  = 5 - board.length;
  const iterations   = 800;
  let wins = 0, ties = 0, total = 0;

  for (let i = 0; i < iterations; i++) {
    if (remaining.length < cardsNeeded + 2) break;
    const sample  = drawSample(remaining, cardsNeeded + 2);
    const simBoard = [...board, ...sample.slice(0, cardsNeeded)];
    const opp     = sample.slice(cardsNeeded);
    const myScore  = evaluateSeven([card0, card1, ...simBoard]);
    const oppScore = evaluateSeven([...opp, ...simBoard]);
    if (!myScore.score || !oppScore.score) continue;
    const cmp = compareScore(myScore.score, oppScore.score);
    if (cmp > 0) wins++;
    else if (cmp === 0) ties++;
    total++;
  }

  if (total === 0) { els["my-cards-win-pct"].textContent = ""; return; }
  const pct = ((wins + ties * 0.5) / total * 100).toFixed(1);
  els["my-cards-win-pct"].textContent = `Win: ${pct}%`;
}

function drawSample(deck, n) {
  const copy = [...deck];
  const out  = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(Math.random() * (copy.length - i)) + i;
    [copy[i], copy[idx]] = [copy[idx], copy[i]];
    out.push(copy[i]);
  }
  return out;
}


function renderShowView() {
  const table = app.state.table;

  els["show-board-cards"].innerHTML = "";
  table.board.forEach((card) => {
    const node = document.createElement("div");
    node.className = `card-pill ${card ? "" : "missing"}`.trim();
    node.textContent = card ? prettyCard(card) : "??";
    els["show-board-cards"].appendChild(node);
  });

  const showRows = table.players
    .filter((player) => player.occupied)
    .map((player) => {
      const cards = player.hole.map((card) => (card ? prettyCard(card) : "??")).join("  ");
      const knownHole = player.hole.filter(Boolean);
      const knownBoard = table.board.filter(Boolean);
      const allKnown = [...knownHole, ...knownBoard];
      let best = "-";
      if (!player.folded && knownHole.length === 2) {
        if (allKnown.length >= 5) {
          try {
            const evaluated = evaluateSeven(allKnown);
            best = evaluated.score ? `${handName(evaluated.score)} (${evaluated.bestFive.map(prettyCard).join(" ")})` : "-";
          } catch (e) {
            best = "-";
          }
        } else if (knownHole.length === 2) {
          // Pre-flop or partial board: show hole card ranks only
          best = `Hole: ${knownHole.map(prettyCard).join(" ")}`;
        }
      }

      // Win probability from last odds simulation
      const oddsEntry = app.lastOdds.find((o) => o.name === player.name);
      const winPct = oddsEntry ? `${oddsEntry.winPct.toFixed(1)}%` : "-";

      return `
        <tr class="${player.folded ? "folded" : ""} ${player.isRobot ? "robot" : ""}">
          <td>${player.seatIndex}</td>
          <td>${escapeHtml(player.name)}</td>
          <td>${cards}</td>
          <td>${player.folded ? "Folded" : "Live"}</td>
          <td>${escapeHtml(best)}</td>
        </tr>
      `;
    })
    .join("");
  els["show-player-body"].innerHTML = showRows;

  renderCardInputs();

  els["robot-cam-url"].value = table.cameras.robot || "";
  els["board-cam-url"].value = table.cameras.board || "";
}

function renderCardInputs() {
  const table = app.state.table;

  const holeRows = table.players
    .filter((player) => player.occupied)
    .map((player) => {
      const c1 = player.hole[0] || "";
      const c2 = player.hole[1] || "";
      return `
        <tr>
          <td>${player.seatIndex}</td>
          <td>${escapeHtml(player.name)}</td>
          <td><input class="hole-input" data-kind="hole" data-seat-index="${player.seatIndex}" data-slot="0" maxlength="2" value="${c1}" placeholder="As"></td>
          <td><input class="hole-input" data-kind="hole" data-seat-index="${player.seatIndex}" data-slot="1" maxlength="2" value="${c2}" placeholder="Kd"></td>
        </tr>
      `;
    })
    .join("");

  els["hole-input-body"].innerHTML = holeRows;

  els["board-inputs"].innerHTML = "";
  for (let slot = 0; slot < 5; slot += 1) {
    const input = document.createElement("input");
    input.className = "hole-input";
    input.dataset.kind = "board";
    input.dataset.slot = String(slot);
    input.maxLength = 2;
    input.placeholder = `B${slot + 1}`;
    input.value = table.board[slot] || "";
    els["board-inputs"].appendChild(input);
  }
}

function renderOdds() {
  if (app.lastOdds.length === 0) {
    els["odds-body"].innerHTML = "";
    return;
  }

  els["odds-body"].innerHTML = app.lastOdds
    .map(
      (entry) => `
      <tr>
        <td>${escapeHtml(entry.name)}</td>
        <td>${entry.winPct.toFixed(2)}%</td>
        <td>${entry.equityPct.toFixed(2)}%</td>
      </tr>
    `,
    )
    .join("");
}

function renderCameraLinks() {
  const cameras = app.state.table.cameras;
  setCameraLink("robot-cam-link", cameras.robot);
  setCameraLink("board-cam-link", cameras.board);
}

function setCameraLink(id, url) {
  const link = els[id];
  if (!url) {
    link.textContent = "No source set";
    link.href = "#";
    return;
  }
  link.textContent = url;
  link.href = url;
}

async function doAction(type, extra = {}) {
  try {
    await postJson("/api/action", { type, ...extra });
    setStatus("betting-status", "Action submitted.", "good");
  } catch (error) {
    setStatus("betting-status", error.message, "bad");
  }
}

async function updateCameras(payload) {
  try {
    await postJson("/api/cameras", payload);
    setStatus("cards-status", "Camera sources updated.", "good");
  } catch (error) {
    setStatus("cards-status", error.message, "bad");
  }
}

async function sendVisionRobot() {
  const value = els["vision-robot-cards"].value.trim();
  if (!value) {
    setStatus("vision-status", "Enter at least one robot card.", "bad");
    return;
  }

  const cards = value
    .split(",")
    .map((item) => normalizeCardInput(item))
    .filter(Boolean);

  if (cards.length === 0) {
    setStatus("vision-status", "No valid cards parsed.", "bad");
    return;
  }

  try {
    const response = await postJson("/api/vision/robot", {
      detections: cards.map((card) => ({ card, confidence: 0.99 })),
    });
    setStatus(
      "vision-status",
      response.applied.length > 0
        ? `Applied robot cards: ${response.applied.join(", ")}`
        : "Detection accepted; waiting for confirmation frames.",
      "good",
    );
  } catch (error) {
    setStatus("vision-status", error.message, "bad");
  }
}

async function sendVisionBoard() {
  const rawCard = els["vision-board-card"].value.trim();
  const card = normalizeCardInput(rawCard);
  if (!card) {
    setStatus("vision-status", "Enter a valid board card like 7h.", "bad");
    return;
  }

  const slotRaw = els["vision-board-slot"].value.trim();
  const slot = slotRaw ? Number.parseInt(slotRaw, 10) - 1 : null;

  try {
    const response = await postJson("/api/vision/board", {
      detections: [
        {
          card,
          slot,
          confidence: 0.99,
        },
      ],
    });
    if (response.applied.length > 0) {
      const text = response.applied.map((entry) => `[${entry.slot + 1}] ${entry.card}`).join(", ");
      setStatus("vision-status", `Applied board cards: ${text}`, "good");
    } else {
      setStatus("vision-status", "Detection accepted; waiting for confirmation frames.", "good");
    }
  } catch (error) {
    setStatus("vision-status", error.message, "bad");
  }
}

async function randomDemoHand() {
  try {
    await postJson("/api/demo/random", {});
    setStatus("cards-status", "Random demo hand generated.", "good");
  } catch (error) {
    setStatus("cards-status", error.message, "bad");
  }
}

async function clearCards() {
  try {
    await postJson("/api/cards/clear", {});
    setStatus("cards-status", "Cards cleared.", "good");
  } catch (error) {
    setStatus("cards-status", error.message, "bad");
  }
}

async function onHoleInputChange(event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || input.dataset.kind !== "hole") return;

  const seatIndex = Number.parseInt(input.dataset.seatIndex, 10);
  const slot = Number.parseInt(input.dataset.slot, 10);
  const card = normalizeCardInput(input.value);

  if (input.value.trim() !== "" && !card) {
    setStatus("cards-status", `Invalid card: ${input.value}`, "bad");
    input.value = "";
    return;
  }

  input.value = card || "";
  try {
    await postJson("/api/cards/patch", {
      kind: "hole",
      seatIndex,
      slot,
      card,
    });
    setStatus("cards-status", "Card updated.", "good");
  } catch (error) {
    setStatus("cards-status", error.message, "bad");
    renderAll();
  }
}

async function onBoardInputChange(event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || input.dataset.kind !== "board") return;

  const slot = Number.parseInt(input.dataset.slot, 10);
  const card = normalizeCardInput(input.value);

  if (input.value.trim() !== "" && !card) {
    setStatus("cards-status", `Invalid card: ${input.value}`, "bad");
    input.value = "";
    return;
  }

  input.value = card || "";
  try {
    await postJson("/api/cards/patch", {
      kind: "board",
      slot,
      card,
    });
    setStatus("cards-status", "Board updated.", "good");
  } catch (error) {
    setStatus("cards-status", error.message, "bad");
    renderAll();
  }
}

function runOddsSimulation() {
  if (!app.state) return;

  const table = app.state.table;
  const active = table.players.filter((player) => player.occupied && !player.folded);
  if (active.length < 2) {
    setStatus("odds-status", "Need at least two active players.", "bad");
    return;
  }

  const knownValidation = validateKnownCards(table.players, table.board);
  if (!knownValidation.ok) {
    setStatus("odds-status", knownValidation.message, "bad");
    return;
  }

  const iterations = clampInt(
    Number.parseInt(els["sim-count"].value, 10),
    200,
    30000,
    3000,
  );

  const wins = Object.fromEntries(active.map((player) => [player.seatIndex, 0]));
  const equity = Object.fromEntries(active.map((player) => [player.seatIndex, 0]));

  for (let i = 0; i < iterations; i += 1) {
    const deck = [...knownValidation.remainingDeck];
    const board = [...table.board];
    const holeBySeat = {};

    active.forEach((player) => {
      const hole = [...player.hole];
      if (!hole[0]) hole[0] = drawRandom(deck);
      if (!hole[1]) hole[1] = drawRandom(deck);
      holeBySeat[player.seatIndex] = hole;
    });

    for (let slot = 0; slot < board.length; slot += 1) {
      if (!board[slot]) {
        board[slot] = drawRandom(deck);
      }
    }

    const scored = active.map((player) => {
      const seven = [...holeBySeat[player.seatIndex], ...board];
      const evaluated = evaluateSeven(seven);
      return {
        seatIndex: player.seatIndex,
        score: evaluated.score,
      };
    });

    let bestScore = scored[0].score;
    scored.forEach((entry) => {
      if (compareScore(entry.score, bestScore) > 0) bestScore = entry.score;
    });

    const winners = scored.filter((entry) => compareScore(entry.score, bestScore) === 0);
    if (winners.length === 1) {
      wins[winners[0].seatIndex] += 1;
    }
    const split = 1 / winners.length;
    winners.forEach((winner) => {
      equity[winner.seatIndex] += split;
    });
  }

  app.lastOdds = active
    .map((player) => ({
      name: player.name,
      winPct: (wins[player.seatIndex] * 100) / iterations,
      equityPct: (equity[player.seatIndex] * 100) / iterations,
    }))
    .sort((a, b) => b.equityPct - a.equityPct);

  renderOdds();
  setStatus("odds-status", `Ran ${iterations.toLocaleString()} simulations.`, "good");
}

function validateKnownCards(players, board) {
  const seen = new Set();
  for (const player of players) {
    for (const card of player.hole) {
      if (!card) continue;
      if (!CARD_META[card]) {
        return { ok: false, message: `Unknown card code: ${card}` };
      }
      if (seen.has(card)) {
        return { ok: false, message: `Duplicate card found: ${card}` };
      }
      seen.add(card);
    }
  }

  for (const card of board) {
    if (!card) continue;
    if (!CARD_META[card]) {
      return { ok: false, message: `Unknown board card: ${card}` };
    }
    if (seen.has(card)) {
      return { ok: false, message: `Duplicate card found: ${card}` };
    }
    seen.add(card);
  }

  return {
    ok: true,
    remainingDeck: FULL_DECK.filter((card) => !seen.has(card)),
  };
}

function evaluateSeven(cards) {
  let best = null;
  let bestFive = null;
  for (let a = 0; a < cards.length - 4; a += 1) {
    for (let b = a + 1; b < cards.length - 3; b += 1) {
      for (let c = b + 1; c < cards.length - 2; c += 1) {
        for (let d = c + 1; d < cards.length - 1; d += 1) {
          for (let e = d + 1; e < cards.length; e += 1) {
            const combo = [cards[a], cards[b], cards[c], cards[d], cards[e]];
            const score = evaluateFive(combo);
            if (!best || compareScore(score, best) > 0) {
              best = score;
              bestFive = combo;
            }
          }
        }
      }
    }
  }
  return { score: best, bestFive };
}

function evaluateFive(cards) {
  const ranks = cards.map((card) => CARD_META[card].rank).sort((a, b) => b - a);
  const suits = cards.map((card) => CARD_META[card].suit);
  const isFlush = suits.every((suit) => suit === suits[0]);
  const straightHigh = getStraightHigh(ranks);

  const counts = new Map();
  ranks.forEach((rank) => counts.set(rank, (counts.get(rank) || 0) + 1));
  const byCount = [...counts.entries()]
    .map(([rank, count]) => ({ rank, count }))
    .sort((x, y) => y.count - x.count || y.rank - x.rank);

  if (isFlush && straightHigh) return [8, straightHigh];
  if (byCount[0].count === 4) {
    const kicker = byCount.find((entry) => entry.count === 1).rank;
    return [7, byCount[0].rank, kicker];
  }
  if (byCount[0].count === 3 && byCount[1].count === 2) return [6, byCount[0].rank, byCount[1].rank];
  if (isFlush) return [5, ...ranks];
  if (straightHigh) return [4, straightHigh];
  if (byCount[0].count === 3) {
    const kickers = byCount.filter((entry) => entry.count === 1).map((entry) => entry.rank);
    return [3, byCount[0].rank, ...kickers];
  }
  if (byCount[0].count === 2 && byCount[1].count === 2) {
    const highPair = Math.max(byCount[0].rank, byCount[1].rank);
    const lowPair = Math.min(byCount[0].rank, byCount[1].rank);
    const kicker = byCount.find((entry) => entry.count === 1).rank;
    return [2, highPair, lowPair, kicker];
  }
  if (byCount[0].count === 2) {
    const pair = byCount[0].rank;
    const kickers = byCount.filter((entry) => entry.count === 1).map((entry) => entry.rank);
    return [1, pair, ...kickers];
  }
  return [0, ...ranks];
}

function getStraightHigh(ranksDesc) {
  const unique = [...new Set(ranksDesc)];
  if (unique.includes(14)) unique.push(1);

  for (let i = 0; i <= unique.length - 5; i += 1) {
    const start = unique[i];
    let valid = true;
    for (let j = 1; j < 5; j += 1) {
      if (unique[i + j] !== start - j) {
        valid = false;
        break;
      }
    }
    if (valid) return start;
  }

  return null;
}

function compareScore(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const ai = a[i] || 0;
    const bi = b[i] || 0;
    if (ai > bi) return 1;
    if (ai < bi) return -1;
  }
  return 0;
}

function handName(score) {
  return [
    "High Card",
    "One Pair",
    "Two Pair",
    "Three of a Kind",
    "Straight",
    "Flush",
    "Full House",
    "Four of a Kind",
    "Straight Flush",
  ][score[0]];
}

function normalizeCardInput(raw) {
  const value = String(raw || "").trim().toUpperCase();
  if (!value) return null;
  const match = value.match(/^([2-9TJQKA])([SHDC])$/);
  if (!match) return null;
  return `${match[1]}${match[2].toLowerCase()}`;
}

function prettyCard(card) {
  return `${card[0]}${SUIT_SYMBOLS[card[1]]}`;
}

function money(amount) {
  return `$${amount}`;
}

function clampInt(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function drawRandom(deck) {
  const idx = Math.floor(Math.random() * deck.length);
  return deck.splice(idx, 1)[0];
}

function setConnectionLabel(text, type) {
  els["connection-label"].textContent = text;
  els["connection-label"].classList.remove("good", "bad");
  if (type) {
    els["connection-label"].classList.add(type);
  }
}

function setStatus(id, message, type) {
  const node = els[id];
  node.textContent = message || "";
  node.classList.remove("good", "bad");
  if (type) node.classList.add(type);
}

async function getJson(url) {
  const response = await fetch(apiUrl(url), {
    method: "GET",
    credentials: "include",
    cache: "no-store",
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.message || `Request failed (${response.status})`;
    throw new Error(message);
  }
  return data;
}

async function postJson(url, payload) {
  const response = await fetch(apiUrl(url), {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload || {}),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.message || `Request failed (${response.status})`;
    throw new Error(message);
  }
  return data;
}

function escapeHtml(input) {
  return String(input)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setAuthMode(mode) {
  app.authMode = mode === "register" ? "register" : "login";
  const isRegister = app.authMode === "register";

  els["auth-mode-login"].classList.toggle("is-active", !isRegister);
  els["auth-mode-register"].classList.toggle("is-active", isRegister);
  els["auth-mode-login"].setAttribute("aria-selected", String(!isRegister));
  els["auth-mode-register"].setAttribute("aria-selected", String(isRegister));
  els["btn-auth-submit"].textContent = isRegister ? "Create Account" : "Login";
}

function togglePasswordVisibility() {
  const showing = els["auth-password"].type === "text";
  els["auth-password"].type = showing ? "password" : "text";
  els["btn-toggle-password"].textContent = showing ? "Show" : "Hide";
}

function apiUrl(path) {
  if (!API_BASE) return path;
  return `${API_BASE}${path}`;
}

async function ensureBackendReachable() {
  const response = await fetch(apiUrl("/api/health"), {
    method: "GET",
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error("Backend health check failed.");
  }
}

function deriveApiBase() {
  if (window.location.protocol === "file:") {
    return "http://127.0.0.1:8080";
  }

  if (!window.location.port || window.location.port === "8080") {
    return "";
  }

  const protocol = window.location.protocol === "https:" ? "https:" : "http:";
  const host = window.location.hostname || "127.0.0.1";
  return `${protocol}//${host}:8080`;
}