const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number.parseInt(process.env.PORT || "8080", 10);
const SESSION_COOKIE = "poker_sid";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_SEATS = 6;

const RANKS = "23456789TJQKA".split("");
const SUITS = ["s", "h", "d", "c"];
const PHASES = ["Preflop", "Flop", "Turn", "River", "Showdown"];

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

const dataDir = path.join(__dirname, "data");
const usersFile = path.join(dataDir, "users.json");
ensureDataFiles();

let users = loadUsers();
const sessions = new Map();
const streamClients = new Set();

const game = createInitialGame();
beginNewHand(true);

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    if (error instanceof Error && error.message === "Invalid JSON body") {
      sendJson(res, 400, { ok: false, message: "Invalid JSON body." });
      return;
    }
    if (error instanceof Error && error.message === "Request body too large") {
      sendJson(res, 413, { ok: false, message: "Request body too large." });
      return;
    }
    console.error("Unhandled request error:", error);
    sendJson(res, 500, { ok: false, message: "Internal server error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Poker server listening on http://${HOST}:${PORT}`);
});

function createInitialGame() {
  const players = [];
  for (let seatIndex = 0; seatIndex < MAX_SEATS; seatIndex += 1) {
    if (seatIndex === 0) {
      players.push({
        seatIndex,
        name: "Robot",
        stack: 1000,
        currentBet: 0,
        folded: false,
        hole: [null, null],
        isRobot: true,
        userId: "robot",
        totalContributed: 0,
      });
    } else {
      players.push(openSeat(seatIndex));
    }
  }

  return {
    players,
    board: Array(5).fill(null),
    phaseIndex: 0,
    currentBet: 0,
    pot: 0,
    pending: [],
    currentTurn: null,
    roundClosed: false,
    dealerIndex: 0,
    actionLog: [],
    cameras: {
      robot: "",
      board: "",
    },
    vision: {
      threshold: 0.8,
      confirmFrames: 1,
      robotVotes: {},
      boardVotes: Array.from({ length: 5 }, () => ({})),
    },
    updatedAt: Date.now(),
  };
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  if (handleCors(req, res)) {
    return;
  }

  if (pathname.startsWith("/api/")) {
    return routeApi(req, res, pathname);
  }
  return serveStatic(req, res, pathname);
}

async function routeApi(req, res, pathname) {
  if (pathname === "/api/health" && req.method === "GET") {
    return sendJson(res, 200, { ok: true, serverTime: new Date().toISOString() });
  }

  if (pathname === "/api/auth/register" && req.method === "POST") {
    const payload = await readJson(req);
    const usernameRaw = typeof payload.username === "string" ? payload.username.trim() : "";
    const password = typeof payload.password === "string" ? payload.password : "";
    const username = usernameRaw.toLowerCase();

    if (!/^[a-z0-9_]{3,20}$/.test(username)) {
      return sendJson(res, 400, { ok: false, message: "Username must be 3-20 chars: letters, numbers, underscore." });
    }
    if (password.length < 6 || password.length > 100) {
      return sendJson(res, 400, { ok: false, message: "Password must be 6-100 characters." });
    }
    if (users.some((user) => user.username === username)) {
      return sendJson(res, 409, { ok: false, message: "Username already exists." });
    }

    const salt = crypto.randomBytes(16).toString("hex");
    const hash = hashPassword(password, salt);
    const user = {
      id: crypto.randomUUID(),
      username,
      salt,
      hash,
      createdAt: new Date().toISOString(),
    };

    users.push(user);
    saveUsers(users);

    const sessionToken = createSession(user.id);
    setSessionCookie(res, sessionToken);
    return sendJson(res, 201, {
      ok: true,
      user: {
        id: user.id,
        username: user.username,
      },
    });
  }

  if (pathname === "/api/auth/login" && req.method === "POST") {
    const payload = await readJson(req);
    const usernameRaw = typeof payload.username === "string" ? payload.username.trim() : "";
    const password = typeof payload.password === "string" ? payload.password : "";
    const username = usernameRaw.toLowerCase();

    const user = users.find((entry) => entry.username === username);
    if (!user || !verifyPassword(password, user.salt, user.hash)) {
      return sendJson(res, 401, { ok: false, message: "Invalid username or password." });
    }

    // Bind the robot's real user ID to seat 0 so requireSeatedUser works.
    if (username === "robot") {
      game.players[0].userId = user.id;
    }

    const sessionToken = createSession(user.id);
    setSessionCookie(res, sessionToken);
    return sendJson(res, 200, {
      ok: true,
      user: {
        id: user.id,
        username: user.username,
      },
    });
  }

  if (pathname === "/api/auth/logout" && req.method === "POST") {
    const sessionToken = getSessionToken(req);
    if (sessionToken) {
      sessions.delete(sessionToken);
    }
    clearSessionCookie(res);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === "/api/auth/me" && req.method === "GET") {
    const auth = requireAuth(req, res);
    if (!auth.ok) return;
    return sendJson(res, 200, {
      ok: true,
      user: {
        id: auth.user.id,
        username: auth.user.username,
      },
    });
  }

  if (pathname === "/api/state" && req.method === "GET") {
    const auth = requireAuth(req, res);
    if (!auth.ok) return;
    return sendJson(res, 200, {
      ok: true,
      state: clientState(auth.user),
    });
  }

  if (pathname === "/api/stream" && req.method === "GET") {
    const auth = requireAuth(req, res);
    if (!auth.ok) return;
    return openEventStream(req, res, auth.user);
  }

  if (pathname === "/api/seat/join" && req.method === "POST") {
    const auth = requireAuth(req, res);
    if (!auth.ok) return;
    const payload = await readJson(req);
    const seatIndex = Number.parseInt(payload.seatIndex, 10);

    if (!Number.isInteger(seatIndex) || seatIndex < 1 || seatIndex >= MAX_SEATS) {
      return sendJson(res, 400, { ok: false, message: "Invalid seat index." });
    }

    const currentSeat = getSeatIndexForUser(auth.user.id);
    if (currentSeat === seatIndex) {
      return sendJson(res, 200, { ok: true, message: "Already in this seat." });
    }

    const targetSeat = game.players[seatIndex];
    if (targetSeat.userId && targetSeat.userId !== auth.user.id) {
      return sendJson(res, 409, { ok: false, message: "Seat already occupied." });
    }

    if (currentSeat != null) {
      removeUserFromSeat(currentSeat);
    }

    targetSeat.userId = auth.user.id;
    targetSeat.name = auth.user.username;
    targetSeat.folded = true;
    targetSeat.currentBet = 0;
    targetSeat.hole = [null, null];
    if (targetSeat.stack <= 0) {
      targetSeat.stack = 1000;
    }

    logAction(`${auth.user.username} joined seat ${seatIndex}.`);
    touchAndBroadcast("seat-join");
    maybeRunRobot();
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === "/api/seat/leave" && req.method === "POST") {
    const auth = requireAuth(req, res);
    if (!auth.ok) return;
    const seatIndex = getSeatIndexForUser(auth.user.id);
    if (seatIndex == null) {
      return sendJson(res, 200, { ok: true, message: "Not seated." });
    }

    removeUserFromSeat(seatIndex);
    logAction(`${auth.user.username} left seat ${seatIndex}.`);
    touchAndBroadcast("seat-leave");
    maybeRunRobot();
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === "/api/action" && req.method === "POST") {
    const auth = requireAuth(req, res);
    if (!auth.ok) return;
    const payload = await readJson(req);
    const type = typeof payload.type === "string" ? payload.type : "";
    const seatIndex = getSeatIndexForUser(auth.user.id);

    if (["check_call", "raise", "fold"].includes(type)) {
      if (seatIndex == null) {
        return sendJson(res, 403, { ok: false, message: "Join a seat first." });
      }
      if (game.currentTurn !== seatIndex) {
        return sendJson(res, 403, { ok: false, message: "It is not your turn." });
      }
    }
    if (type === "check_call") {
      actCheckCall(seatIndex);
      touchAndBroadcast("action-check-call");
      maybeRunRobot();
      return sendJson(res, 200, { ok: true });
    }

    if (type === "raise") {
      const amount = Number.parseInt(payload.amount, 10);
      if (!Number.isInteger(amount) || amount <= 0) {
        return sendJson(res, 400, { ok: false, message: "Raise amount must be a positive integer." });
      }
      const ok = actRaise(seatIndex, amount);
      if (!ok) {
        return sendJson(res, 400, { ok: false, message: "Invalid raise." });
      }
      touchAndBroadcast("action-raise");
      maybeRunRobot();
      return sendJson(res, 200, { ok: true });
    }

    if (type === "fold") {
      actFold(seatIndex);
      touchAndBroadcast("action-fold");
      maybeRunRobot();
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 400, { ok: false, message: "Unknown action type. Use check_call, raise, or fold." });
  }

  if (pathname === "/api/cards/patch" && req.method === "POST") {
    const auth = requireAuth(req, res);
    if (!auth.ok) return;
    if (!requireSeatedUser(auth.user, res)) return;
    const payload = await readJson(req);
    const kind = payload.kind;
    const slot = Number.parseInt(payload.slot, 10);

    if (kind === "hole") {
      const seatIndex = Number.parseInt(payload.seatIndex, 10);
      if (!Number.isInteger(seatIndex) || seatIndex < 0 || seatIndex >= MAX_SEATS || ![0, 1].includes(slot)) {
        return sendJson(res, 400, { ok: false, message: "Invalid hole card target." });
      }
      const card = normalizeCardInput(payload.card);
      const error = setHoleCard(seatIndex, slot, card);
      if (error) {
        return sendJson(res, 400, { ok: false, message: error });
      }
      touchAndBroadcast("cards-hole");
      return sendJson(res, 200, { ok: true });
    }

    if (kind === "board") {
      if (![0, 1, 2, 3, 4].includes(slot)) {
        return sendJson(res, 400, { ok: false, message: "Invalid board slot." });
      }
      const card = normalizeCardInput(payload.card);
      const error = setBoardCard(slot, card);
      if (error) {
        return sendJson(res, 400, { ok: false, message: error });
      }
      touchAndBroadcast("cards-board");
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 400, { ok: false, message: "Invalid card patch kind." });
  }

  if (pathname === "/api/cards/clear" && req.method === "POST") {
    const auth = requireAuth(req, res);
    if (!auth.ok) return;
    if (!requireSeatedUser(auth.user, res)) return;
    clearAllCards();
    touchAndBroadcast("cards-clear");
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === "/api/demo/random" && req.method === "POST") {
    const auth = requireAuth(req, res);
    if (!auth.ok) return;
    if (!requireSeatedUser(auth.user, res)) return;
    randomizeCards();
    touchAndBroadcast("demo-random");
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === "/api/cameras" && req.method === "POST") {
    const auth = requireAuth(req, res);
    if (!auth.ok) return;
    if (!requireSeatedUser(auth.user, res)) return;
    const payload = await readJson(req);
    const robotUrl = typeof payload.robotUrl === "string" ? payload.robotUrl.trim() : null;
    const boardUrl = typeof payload.boardUrl === "string" ? payload.boardUrl.trim() : null;

    if (robotUrl !== null) {
      if (robotUrl !== "" && !isValidAbsoluteUrl(robotUrl)) {
        return sendJson(res, 400, { ok: false, message: "Robot URL must be a valid absolute URL." });
      }
      game.cameras.robot = robotUrl;
    }

    if (boardUrl !== null) {
      if (boardUrl !== "" && !isValidAbsoluteUrl(boardUrl)) {
        return sendJson(res, 400, { ok: false, message: "Board URL must be a valid absolute URL." });
      }
      game.cameras.board = boardUrl;
    }

    logAction(`Camera config updated by ${auth.user.username}.`);
    touchAndBroadcast("camera-update");
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === "/api/vision/robot" && req.method === "POST") {
    const auth = requireAuth(req, res);
    if (!auth.ok) return;
    if (!requireSeatedUser(auth.user, res)) return;
    const payload = await readJson(req);
    const detections = Array.isArray(payload.detections) ? payload.detections : [];

    const applied = [];
    for (const detection of detections) {
      const card = normalizeCardInput(detection.card);
      const confidence = Number(detection.confidence);
      if (!card || !Number.isFinite(confidence) || confidence < game.vision.threshold) {
        continue;
      }
      game.vision.robotVotes[card] = (game.vision.robotVotes[card] || 0) + 1;
      if (game.vision.robotVotes[card] >= game.vision.confirmFrames) {
        const inserted = assignRobotCard(card);
        if (inserted) {
          applied.push(card);
        }
      }
    }

    if (applied.length > 0) {
      touchAndBroadcast("vision-robot");
    }

    return sendJson(res, 200, {
      ok: true,
      applied,
      threshold: game.vision.threshold,
      confirmFrames: game.vision.confirmFrames,
    });
  }

  if (pathname === "/api/vision/board" && req.method === "POST") {
    const auth = requireAuth(req, res);
    if (!auth.ok) return;
    if (!requireSeatedUser(auth.user, res)) return;
    const payload = await readJson(req);
    const detections = Array.isArray(payload.detections) ? payload.detections : [];
    const applied = [];

    for (const detection of detections) {
      const card = normalizeCardInput(detection.card);
      const confidence = Number(detection.confidence);
      if (!card || !Number.isFinite(confidence) || confidence < game.vision.threshold) {
        continue;
      }

      let slot = Number.parseInt(detection.slot, 10);
      if (!Number.isInteger(slot) || slot < 0 || slot > 4) {
        slot = firstEmptyBoardSlot();
      }
      if (slot == null) {
        continue;
      }

      const voteBucket = game.vision.boardVotes[slot];
      voteBucket[card] = (voteBucket[card] || 0) + 1;
      if (voteBucket[card] >= game.vision.confirmFrames) {
        const inserted = assignBoardCard(slot, card);
        if (inserted) {
          applied.push({ slot, card });
        }
      }
    }

    if (applied.length > 0) {
      touchAndBroadcast("vision-board");
    }

    return sendJson(res, 200, {
      ok: true,
      applied,
      threshold: game.vision.threshold,
      confirmFrames: game.vision.confirmFrames,
    });
  }

  if (pathname === "/api/vision/reset" && req.method === "POST") {
    const auth = requireAuth(req, res);
    if (!auth.ok) return;
    if (!requireSeatedUser(auth.user, res)) return;
    game.vision.robotVotes = {};
    game.vision.boardVotes = Array.from({ length: 5 }, () => ({}));
    return sendJson(res, 200, { ok: true });
  }

  // ── Robot controller: act on behalf of seat 0 ──
  // The Python bot authenticates as the "robot" user and posts here.
  // We allow it to act even when it's not strictly "currentTurn" so
  // timing jitter between poll cycles doesn't cause missed turns.
  if (pathname === "/api/robot/action" && req.method === "POST") {
    const auth = requireAuth(req, res);
    if (!auth.ok) return;

    // Only the robot user may call this endpoint
    if (auth.user.username !== "robot") {
      return sendJson(res, 403, { ok: false, message: "Robot account only." });
    }

    const payload = await readJson(req);
    const type    = typeof payload.type === "string" ? payload.type : "";

    if (type === "check_call") {
      actCheckCall(0);
      touchAndBroadcast("robot-action");
      return sendJson(res, 200, { ok: true });
    }

    if (type === "raise") {
      const amount = Number.parseInt(payload.amount, 10);
      if (!Number.isInteger(amount) || amount <= 0) {
        return sendJson(res, 400, { ok: false, message: "Raise amount must be a positive integer." });
      }
      const ok = actRaise(0, amount);
      if (!ok) {
        actCheckCall(0); // fallback to call if raise is invalid
      }
      touchAndBroadcast("robot-action");
      return sendJson(res, 200, { ok: true });
    }

    if (type === "fold") {
      actFold(0);
      touchAndBroadcast("robot-action");
      return sendJson(res, 200, { ok: true });
    }

    if (type === "new_hand") {
      beginNewHand(false);
      touchAndBroadcast("robot-new-hand");
      return sendJson(res, 200, { ok: true });
    }

    if (type === "advance_street") {
      const ok = advanceStreet();
      if (!ok) {
        return sendJson(res, 400, { ok: false, message: "Cannot advance street right now." });
      }
      touchAndBroadcast("robot-advance-street");
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 400, { ok: false, message: "Unknown robot action type." });
  }

  sendJson(res, 404, { ok: false, message: "Not found" });
}

function requireAuth(req, res) {
  const sessionToken = getSessionToken(req);
  if (!sessionToken) {
    sendJson(res, 401, { ok: false, message: "Not authenticated." });
    return { ok: false };
  }
  const session = sessions.get(sessionToken);
  if (!session || session.expiresAt < Date.now()) {
    if (sessionToken) sessions.delete(sessionToken);
    clearSessionCookie(res);
    sendJson(res, 401, { ok: false, message: "Session expired." });
    return { ok: false };
  }

  session.expiresAt = Date.now() + SESSION_TTL_MS;
  const user = users.find((entry) => entry.id === session.userId);
  if (!user) {
    sessions.delete(sessionToken);
    clearSessionCookie(res);
    sendJson(res, 401, { ok: false, message: "Unknown user." });
    return { ok: false };
  }

  return { ok: true, user };
}

function requireSeatedUser(user, res) {
  const seatIndex = getSeatIndexForUser(user.id);
  if (seatIndex == null) {
    sendJson(res, 403, { ok: false, message: "Join a seat first." });
    return false;
  }
  return true;
}

function setSessionCookie(res, token) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, {
    userId,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return token;
}

function getSessionToken(req) {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const [key, ...rest] = part.trim().split("=");
    if (key === SESSION_COOKIE) {
      return rest.join("=");
    }
  }
  return null;
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error("Request body too large");
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error("Invalid JSON body");
  }
}

function serveStatic(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendText(res, 405, "Method not allowed");
  }

  let relativePath = pathname === "/" ? "/index.html" : pathname;
  relativePath = path.normalize(relativePath).replace(/^\/+/, "");
  if (relativePath.startsWith("..")) {
    return sendText(res, 403, "Forbidden");
  }

  const filePath = path.join(__dirname, relativePath);
  if (!filePath.startsWith(__dirname)) {
    return sendText(res, 403, "Forbidden");
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return sendText(res, 404, "Not found");
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
  }[ext] || "application/octet-stream";

  const data = fs.readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": data.length,
  });
  if (req.method === "HEAD") {
    return res.end();
  }
  res.end(data);
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function ensureDataFiles() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  if (!fs.existsSync(usersFile)) {
    fs.writeFileSync(usersFile, "[]\n", "utf8");
  }
}

function handleCors(req, res) {
  const origin = req.headers.origin;
  if (origin && isAllowedCorsOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

function isAllowedCorsOrigin(origin) {
  try {
    const parsed = new URL(origin);
    return ["localhost", "127.0.0.1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function loadUsers() {
  try {
    const raw = fs.readFileSync(usersFile, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch (error) {
    console.error("Failed to load users file:", error);
    return [];
  }
}

function saveUsers(nextUsers) {
  fs.writeFileSync(usersFile, `${JSON.stringify(nextUsers, null, 2)}\n`, "utf8");
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
}

function verifyPassword(password, salt, expectedHash) {
  const calculated = hashPassword(password, salt);
  const a = Buffer.from(calculated, "hex");
  const b = Buffer.from(expectedHash, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function openSeat(seatIndex) {
  return {
    seatIndex,
    name: `Open Seat ${seatIndex}`,
    stack: 1000,
    currentBet: 0,
    totalContributed: 0,
    folded: true,
    hole: [null, null],
    isRobot: false,
    userId: null,
  };
}

function getSeatIndexForUser(userId) {
  const found = game.players.find((player) => player.userId === userId);
  return found ? found.seatIndex : null;
}

function removeUserFromSeat(seatIndex) {
  const seat = game.players[seatIndex];
  if (!seat || seat.isRobot) return;

  if (!seat.folded) {
    seat.folded = true;
    removeFromPending(seatIndex);
    checkImmediateWinner();
    advanceTurn(seatIndex);
  }

  game.players[seatIndex] = openSeat(seatIndex);
}

function beginNewHand(firstLoad) {
  const participants = participantSeats();
  if (participants.length === 0) {
    game.pending = [];
    game.currentTurn = null;
    game.roundClosed = true;
    return;
  }

  if (!firstLoad) {
    game.dealerIndex = nextDealerIndex(game.dealerIndex, participants);
  }

  game.phaseIndex = 0;
  game.currentBet = 0;
  game.pot = 0;
  game.board = Array(5).fill(null);
  clearVisionVotes();

  game.players.forEach((player) => {
    player.currentBet = 0;
    player.totalContributed = 0;
    player.hole = [null, null];
    if (isParticipant(player)) {
      player.folded = player.stack <= 0;
    } else {
      player.folded = true;
    }
  });

  game.pending = getActableIndices();
  game.currentTurn = game.pending.length > 0 ? game.pending[0] : null;
  game.roundClosed = game.pending.length <= 1;

  game.actionLog = [];
  logAction(`New hand started. Dealer seat: ${game.dealerIndex}`);
}

function participantSeats() {
  return game.players.filter((player) => isParticipant(player)).map((player) => player.seatIndex);
}

function isParticipant(player) {
  return player.isRobot || Boolean(player.userId);
}

function nextDealerIndex(currentDealer, participants) {
  const sorted = [...participants].sort((a, b) => a - b);
  for (const seatIndex of sorted) {
    if (seatIndex > currentDealer) {
      return seatIndex;
    }
  }
  return sorted[0];
}

function getActableIndices() {
  return game.players
    .filter((player) => isParticipant(player) && !player.folded && player.stack > 0)
    .map((player) => player.seatIndex);
}

function canStillAct(seatIndex) {
  const player = game.players[seatIndex];
  return player && isParticipant(player) && !player.folded && player.stack > 0;
}

function nextPendingAfter(previousSeat) {
  if (game.pending.length === 0) return null;

  for (let offset = 1; offset <= MAX_SEATS; offset += 1) {
    const nextSeat = (previousSeat + offset) % MAX_SEATS;
    if (game.pending.includes(nextSeat)) {
      return nextSeat;
    }
  }
  return game.pending[0] || null;
}

function removeFromPending(seatIndex) {
  game.pending = game.pending.filter((entry) => entry !== seatIndex);
}

function advanceTurn(previousSeat) {
  game.pending = game.pending.filter((seatIndex) => canStillAct(seatIndex));
  if (game.pending.length === 0) {
    game.currentTurn = null;
    game.roundClosed = true;
    return;
  }
  game.currentTurn = nextPendingAfter(previousSeat);
  game.roundClosed = false;
}

function actCheckCall(seatIndex) {
  const player = game.players[seatIndex];
  const toCall = Math.max(0, game.currentBet - player.currentBet);

  if (toCall === 0) {
    logAction(`${player.name} checks.`);
    removeFromPending(seatIndex);
    advanceTurn(seatIndex);
    return;
  }

  const paid = Math.min(player.stack, toCall);
  player.stack -= paid;
  player.currentBet += paid;
  player.totalContributed += paid;
  game.pot += paid;

  if (paid < toCall) {
    logAction(`${player.name} calls all-in for $${paid}.`);
  } else {
    logAction(`${player.name} calls $${paid}.`);
  }

  removeFromPending(seatIndex);
  if (checkImmediateWinner()) {
    return;
  }
  advanceTurn(seatIndex);
}

function actRaise(seatIndex, amount) {
  const player = game.players[seatIndex];
  if (!player || player.stack <= 0) {
    return false;
  }

  const target = game.currentBet === 0 ? amount : game.currentBet + amount;
  const needed = Math.max(0, target - player.currentBet);
  if (needed <= 0) return false;

  const contributed = Math.min(needed, player.stack);
  player.stack -= contributed;
  player.currentBet += contributed;
  player.totalContributed += contributed;
  game.pot += contributed;

  const oldCurrentBet = game.currentBet;
  if (player.currentBet > oldCurrentBet) {
    game.currentBet = player.currentBet;
    if (oldCurrentBet === 0) {
      logAction(`${player.name} bets to $${player.currentBet}.`);
    } else {
      logAction(`${player.name} raises to $${player.currentBet}.`);
    }
    game.pending = getActableIndices().filter((idx) => idx !== seatIndex);
  } else {
    logAction(`${player.name} is all-in for $${player.currentBet}.`);
    removeFromPending(seatIndex);
  }

  if (checkImmediateWinner()) {
    return true;
  }

  advanceTurn(seatIndex);
  return true;
}

function actFold(seatIndex) {
  const player = game.players[seatIndex];
  if (!player || player.folded) return;
  player.folded = true;
  logAction(`${player.name} folds.`);
  removeFromPending(seatIndex);
  if (checkImmediateWinner()) {
    return;
  }
  advanceTurn(seatIndex);
}

function advanceStreet() {
  if (!game.roundClosed) {
    return false;
  }

  if (game.phaseIndex >= PHASES.length - 1) {
    return false;
  }

  const active = activePlayers();
  if (active.length <= 1) {
    return false;
  }

  game.phaseIndex += 1;
  game.currentBet = 0;
  for (const player of game.players) {
    player.currentBet = 0;
  }

  if (game.phaseIndex === PHASES.length - 1) {
    game.pending = [];
    game.currentTurn = null;
    game.roundClosed = true;
    logAction("Reached showdown.");
    resolveShowdownIfPossible();
    return true;
  }

  game.pending = getActableIndices();
  game.currentTurn = game.pending.length > 0 ? game.pending[0] : null;
  game.roundClosed = game.pending.length <= 1;
  logAction(`Moved to ${PHASES[game.phaseIndex]}.`);
  return true;
}

function activePlayers() {
  return game.players.filter((player) => isParticipant(player) && !player.folded);
}

function checkImmediateWinner() {
  const active = activePlayers();
  if (active.length !== 1) {
    return false;
  }

  const winner = active[0];
  if (game.pot > 0) {
    winner.stack += game.pot;
    logAction(`${winner.name} wins pot of $${game.pot} (everyone else folded).`);
    game.pot = 0;
  }

  game.phaseIndex = PHASES.length - 1;
  game.currentBet = 0;
  game.pending = [];
  game.currentTurn = null;
  game.roundClosed = true;
  game.players.forEach((player) => {
    player.currentBet = 0;
  });
  return true;
}

function resolveShowdownIfPossible() {
  const active = activePlayers();
  if (active.length === 0 || game.pot <= 0) {
    return;
  }

  if (!game.board.every(Boolean)) {
    logAction("Showdown waiting: board is not complete.");
    return;
  }

  for (const player of active) {
    if (!player.hole[0] || !player.hole[1]) {
      logAction(`Showdown waiting: ${player.name} hole cards incomplete.`);
      return;
    }
  }

  const scored = active.map((player) => {
    const seven = [...player.hole, ...game.board];
    const evaluated = evaluateSeven(seven);
    return {
      player,
      score: evaluated.score,
      label: handName(evaluated.score),
    };
  });

  let best = scored[0].score;
  for (const entry of scored) {
    if (compareScore(entry.score, best) > 0) {
      best = entry.score;
    }
  }

  const winners = scored.filter((entry) => compareScore(entry.score, best) === 0);
  const split = Math.floor(game.pot / winners.length);
  const remainder = game.pot % winners.length;

  winners.forEach((entry, index) => {
    const payout = split + (index < remainder ? 1 : 0);
    entry.player.stack += payout;
  });

  const winnerNames = winners.map((entry) => `${entry.player.name} (${entry.label})`).join(", ");
  logAction(`Showdown payout: ${winnerNames}. Pot $${game.pot} distributed.`);
  game.pot = 0;
}

function normalizeCardInput(raw) {
  if (raw == null) return null;
  const value = String(raw).trim().toUpperCase();
  if (!value) return null;
  const match = value.match(/^([2-9TJQKA])([SHDC])$/);
  if (!match) return null;
  return `${match[1]}${match[2].toLowerCase()}`;
}

function collectKnownCards() {
  const known = [];
  for (const player of game.players) {
    for (const card of player.hole) {
      if (card) known.push({ source: `seat-${player.seatIndex}`, card });
    }
  }
  for (let slot = 0; slot < game.board.length; slot += 1) {
    const card = game.board[slot];
    if (card) known.push({ source: `board-${slot}`, card });
  }
  return known;
}

function validateUniqueCards() {
  const seen = new Map();
  for (const entry of collectKnownCards()) {
    if (seen.has(entry.card)) {
      return `Duplicate card: ${entry.card}`;
    }
    seen.set(entry.card, entry.source);
  }
  return null;
}

function setHoleCard(seatIndex, slot, card) {
  const player = game.players[seatIndex];
  if (!player) return "Unknown seat.";

  if (card && !CARD_META[card]) return "Invalid card code.";

  const prev = player.hole[slot];
  player.hole[slot] = card;
  const duplicateError = validateUniqueCards();
  if (duplicateError) {
    player.hole[slot] = prev;
    return duplicateError;
  }

  resolveShowdownIfPossible();
  return null;
}

function setBoardCard(slot, card) {
  if (card && !CARD_META[card]) return "Invalid card code.";

  const prev = game.board[slot];
  game.board[slot] = card;
  const duplicateError = validateUniqueCards();
  if (duplicateError) {
    game.board[slot] = prev;
    return duplicateError;
  }

  resolveShowdownIfPossible();
  return null;
}

function clearAllCards() {
  game.players.forEach((player) => {
    player.hole = [null, null];
  });
  game.board = Array(5).fill(null);
  clearVisionVotes();
}

function randomizeCards() {
  clearAllCards();
  const deck = [...FULL_DECK];

  for (const player of game.players) {
    if (!isParticipant(player) || player.folded) continue;
    player.hole[0] = drawRandom(deck);
    player.hole[1] = drawRandom(deck);
  }

  for (let i = 0; i < 5; i += 1) {
    game.board[i] = drawRandom(deck);
  }

  resolveShowdownIfPossible();
}

function drawRandom(deck) {
  const index = Math.floor(Math.random() * deck.length);
  return deck.splice(index, 1)[0];
}

function clearVisionVotes() {
  game.vision.robotVotes = {};
  game.vision.boardVotes = Array.from({ length: 5 }, () => ({}));
}

function assignRobotCard(card) {
  const robot = game.players[0];
  if (robot.hole.includes(card)) return false;
  if (isCardAlreadyUsed(card)) return false;

  const slot = robot.hole.findIndex((entry) => !entry);
  if (slot === -1) return false;

  robot.hole[slot] = card;
  game.vision.robotVotes[card] = 0;
  resolveShowdownIfPossible();
  return true;
}

function assignBoardCard(slot, card) {
  if (isCardAlreadyUsed(card, { boardSlot: slot })) {
    return false;
  }

  const previous = game.board[slot];
  game.board[slot] = card;
  const duplicateError = validateUniqueCards();
  if (duplicateError) {
    game.board[slot] = previous;
    return false;
  }

  game.vision.boardVotes[slot] = {};
  resolveShowdownIfPossible();
  return true;
}

function firstEmptyBoardSlot() {
  const idx = game.board.findIndex((card) => !card);
  return idx === -1 ? null : idx;
}

function isCardAlreadyUsed(card, options = {}) {
  const { boardSlot = null } = options;
  for (const player of game.players) {
    if (player.hole.includes(card)) {
      return true;
    }
  }
  for (let slot = 0; slot < game.board.length; slot += 1) {
    if (boardSlot === slot) continue;
    if (game.board[slot] === card) {
      return true;
    }
  }
  return false;
}

function maybeRunRobot() {
  const robot = game.players[0];
  if (game.currentTurn === 0 && (robot.folded || robot.stack <= 0)) {
    removeFromPending(0);
    advanceTurn(0);
    touchAndBroadcast("robot-skip", false);
  }
}

function clientState(user) {
  const seatIndex = getSeatIndexForUser(user.id);
  return {
    serverTime: new Date().toISOString(),
    phases: PHASES,
    me: {
      id: user.id,
      username: user.username,
      seatIndex,
    },
    table: {
      phaseIndex: game.phaseIndex,
      currentBet: game.currentBet,
      pot: game.pot,
      currentTurn: game.currentTurn,
      roundClosed: game.roundClosed,
      dealerIndex: game.dealerIndex,
      board: game.board,
      players: game.players.map((player) => ({
        seatIndex: player.seatIndex,
        name: player.name,
        stack: player.stack,
        currentBet: player.currentBet,
        totalContributed: player.totalContributed || 0,
        folded: player.folded,
        hole: player.hole,
        isRobot: player.isRobot,
        occupied: player.isRobot || Boolean(player.userId),
        userId: player.userId,
      })),
      actionLog: game.actionLog,
      cameras: game.cameras,
      vision: {
        threshold: game.vision.threshold,
        confirmFrames: game.vision.confirmFrames,
      },
    },
  };
}

function touchAndBroadcast(eventName, touch = true) {
  if (touch) {
    game.updatedAt = Date.now();
  }

  for (const client of [...streamClients]) {
    if (client.res.destroyed) {
      streamClients.delete(client);
      continue;
    }

    const payload = clientState(client.user);
    sendSse(client.res, "state", payload);
  }
}

function openEventStream(req, res, user) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  res.write("retry: 2000\n\n");
  sendSse(res, "state", clientState(user));

  const client = { res, user };
  streamClients.add(client);

  const keepAlive = setInterval(() => {
    if (!res.destroyed) {
      res.write(`: heartbeat ${Date.now()}\n\n`);
    }
  }, 20000);

  req.on("close", () => {
    clearInterval(keepAlive);
    streamClients.delete(client);
  });
}

function sendSse(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function isValidAbsoluteUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function logAction(message) {
  game.actionLog.unshift(`[${PHASES[game.phaseIndex]}] ${message}`);
  game.actionLog = game.actionLog.slice(0, 80);
}

function evaluateSeven(cards) {
  let best = null;
  for (let a = 0; a < cards.length - 4; a += 1) {
    for (let b = a + 1; b < cards.length - 3; b += 1) {
      for (let c = b + 1; c < cards.length - 2; c += 1) {
        for (let d = c + 1; d < cards.length - 1; d += 1) {
          for (let e = d + 1; e < cards.length; e += 1) {
            const combo = [cards[a], cards[b], cards[c], cards[d], cards[e]];
            const score = evaluateFive(combo);
            if (!best || compareScore(score, best) > 0) {
              best = score;
            }
          }
        }
      }
    }
  }
  return { score: best };
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
  if (byCount[0].count === 3 && byCount[1].count === 2) {
    return [6, byCount[0].rank, byCount[1].rank];
  }
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
    const pairRank = byCount[0].rank;
    const kickers = byCount.filter((entry) => entry.count === 1).map((entry) => entry.rank);
    return [1, pairRank, ...kickers];
  }
  return [0, ...ranks];
}

function getStraightHigh(ranksDesc) {
  const unique = [...new Set(ranksDesc)];
  if (unique.includes(14)) unique.push(1);

  for (let i = 0; i <= unique.length - 5; i += 1) {
    const start = unique[i];
    let ok = true;
    for (let j = 1; j < 5; j += 1) {
      if (unique[i + j] !== start - j) {
        ok = false;
        break;
      }
    }
    if (ok) return start;
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