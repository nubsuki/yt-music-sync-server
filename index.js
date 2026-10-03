require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Filter } = require("bad-words");

const profanityFilter = new Filter();

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const MAX_MEMBERS = parseInt(process.env.MAX_MEMBERS || "50");
const MAX_PARTIES = parseInt(process.env.MAX_PARTIES || "500");

/* Security headers */
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'", "wss:", "ws:"],
        imgSrc: [
          "'self'",
          "data:",
          "https://lh3.googleusercontent.com",
          "https://i.ytimg.com",
          "https://yt3.ggpht.com",
        ],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        upgradeInsecureRequests: null,
      },
    },
    crossOriginEmbedderPolicy: false,
  }),
);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST", "DELETE"] },
  maxHttpBufferSize: 1e5, // 100 KB max socket payload
  pingTimeout: 30000,
  pingInterval: 25000,
  connectTimeout: 10000,
});

app.use(cors());
app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

/* Rate limiting */
const createPartyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many parties created. Please wait a minute." },
});

const lookupLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests." },
});

// In-memory party store
// Map<partyId, Party>
// Party: { id, hostSocketId, hostToken, hostName, createdAt, state, members[] }
const parties = new Map();

// Track connections per IP for Socket.IO rate limiting
const ipConnectionCount = new Map();
const MAX_CONNECTIONS_PER_IP = 10;

/* Sanitize a strings */
function sanitizeStr(str, maxLen = 64, filterProfanity = false) {
  if (typeof str !== "string") return "";
  let cleanStr = str
    .replace(/[<>"'&]/g, "")
    .trim()
    .slice(0, maxLen);

  if (filterProfanity && cleanStr) {
    try {
      cleanStr = profanityFilter.clean(cleanStr);
    } catch (e) {
      // Fallback
    }
  }
  return cleanStr;
}

/* Validate thumbnail is from a trusted YouTube CDN */
function isSafeThumbnail(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      /^(lh3\.googleusercontent\.com|i\.ytimg\.com|yt3\.ggpht\.com)$/.test(
        parsed.hostname,
      )
    );
  } catch {
    return false;
  }
}

/* Validate a YouTube Music URL for guest sync */
function isSafeYtMusicUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      /^(music\.youtube\.com|www\.youtube\.com)$/.test(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function generatePartyId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < 6; i++)
    id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

/* Sanitize state received from host before storing / broadcasting */
function sanitizeState(raw) {
  if (!raw || typeof raw !== "object") return {};
  return {
    song: sanitizeStr(raw.song, 200),
    artist: sanitizeStr(raw.artist, 200),
    url: isSafeYtMusicUrl(raw.url) ? raw.url : "",
    thumbnail: isSafeThumbnail(raw.thumbnail) ? raw.thumbnail : "",
    isPlaying: Boolean(raw.isPlaying),
    currentTime: Number.isFinite(Number(raw.currentTime))
      ? Math.max(0, Number(raw.currentTime))
      : 0,
    duration: Number.isFinite(Number(raw.duration))
      ? Math.max(0, Number(raw.duration))
      : 0,
  };
}

function partyPublicView(party, full = false) {
  return {
    id: party.id,
    hostName: party.hostName,
    createdAt: party.createdAt,
    memberCount: party.members.length,
    state: full
      ? party.state
      : {
          song: party.state.song,
          artist: party.state.artist,
          thumbnail: party.state.thumbnail,
          isPlaying: party.state.isPlaying,
        },
    ...(full ? { members: party.members.map((m) => ({ name: m.name })) } : {}),
  };
}

function closeParty(partyId, reason = "Party closed") {
  const party = parties.get(partyId);
  if (!party) return;
  io.to(`party:${partyId}`).emit("party:closed", { reason });
  parties.delete(partyId);
  io.to("dashboard").emit("dashboard:party-removed", { partyId });
  console.log(`[Party ${partyId}] Closed: ${reason}`);
}

// REST API

// POST /api/party/create
app.post("/api/party/create", createPartyLimiter, (req, res) => {
  const { hostName } = req.body;
  if (!hostName || typeof hostName !== "string") {
    return res.status(400).json({ error: "hostName is required" });
  }

  if (parties.size >= MAX_PARTIES) {
    return res
      .status(503)
      .json({ error: "Server is at capacity. Try again later." });
  }

  let partyId;
  let attempts = 0;
  do {
    partyId = generatePartyId();
    attempts++;
    if (attempts > 100)
      return res
        .status(500)
        .json({ error: "Could not generate unique party ID" });
  } while (parties.has(partyId));

  const hostToken = uuidv4();
  const party = {
    id: partyId,
    hostSocketId: null,
    hostToken,
    hostName: sanitizeStr(hostName, 32, true),
    createdAt: Date.now(),
    state: {
      song: "",
      artist: "",
      url: "",
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      thumbnail: "",
    },
    members: [],
  };

  parties.set(partyId, party);

  // Auto-expire if host never connects via socket within 5 minutes
  setTimeout(
    () => {
      const p = parties.get(partyId);
      if (p && !p.hostSocketId) {
        parties.delete(partyId);
        console.log(`[Party ${partyId}] Expired (host never connected)`);
      }
    },
    5 * 60 * 1000,
  );

  console.log(`[Party ${partyId}] Created by "${party.hostName}"`);
  res.json({ partyId, hostToken });
});

// GET /api/parties
app.get("/api/parties", lookupLimiter, (_req, res) => {
  const list = [];
  for (const [, party] of parties) {
    if (party.hostSocketId) list.push(partyPublicView(party));
  }
  res.json(list);
});

// GET /api/party/:id
app.get("/api/party/:id", lookupLimiter, (req, res) => {
  const party = parties.get(req.params.id.toUpperCase());
  if (!party) return res.status(404).json({ error: "Party not found" });
  res.json(partyPublicView(party, true));
});

// DELETE /api/party/:id
app.delete("/api/party/:id", (req, res) => {
  const party = parties.get(req.params.id.toUpperCase());
  if (!party) return res.status(404).json({ error: "Party not found" });
  if (party.hostToken !== req.body.hostToken)
    return res.status(403).json({ error: "Invalid host token" });
  closeParty(party.id, "Host ended the party");
  res.json({ ok: true });
});

// Serve party page for any /party/:id
app.get("/party/:id", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "party.html"));
});

// Socket.IO

/* Connection rate limiting per IP */
io.use((socket, next) => {
  const ip = socket.handshake.address;
  const count = (ipConnectionCount.get(ip) || 0) + 1;
  if (count > MAX_CONNECTIONS_PER_IP) {
    return next(new Error("Too many connections from this IP"));
  }
  ipConnectionCount.set(ip, count);
  socket.on("disconnect", () => {
    const c = (ipConnectionCount.get(ip) || 1) - 1;
    if (c <= 0) ipConnectionCount.delete(ip);
    else ipConnectionCount.set(ip, c);
  });
  next();
});

io.on("connection", (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  // Clock sync
  socket.on("clock:ping", ({ t1 }, ack) => {
    if (typeof ack === "function") {
      ack({ t1, t2: Date.now() });
    }
  });

  // Host registers their socket
  socket.on("party:host-connect", ({ partyId, hostToken }) => {
    const id = (partyId || "").toUpperCase().slice(0, 6);
    const party = parties.get(id);
    if (!party || party.hostToken !== hostToken) {
      socket.emit("party:error", { message: "Invalid party ID or token" });
      return;
    }

    party.hostSocketId = socket.id;
    socket.join(`party:${id}`);
    socket.data.partyId = id;
    socket.data.isHost = true;

    console.log(`[Party ${id}] Host socket connected`);
    socket.emit("party:host-ready", {
      partyId: id,
      memberCount: party.members.length,
    });
    io.to(`party:${id}`).emit("party:host-online", {
      hostName: party.hostName,
    });
    io.to("dashboard").emit("dashboard:party-added", partyPublicView(party));
  });

  // Member joins via app
  socket.on("party:join", ({ partyId, displayName }) => {
    const id = (partyId || "").toUpperCase().slice(0, 6);
    const party = parties.get(id);

    if (!party) {
      socket.emit("party:error", { message: "Party not found or has ended" });
      return;
    }
    if (!party.hostSocketId) {
      socket.emit("party:error", { message: "Host is not online yet" });
      return;
    }
    if (party.members.length >= MAX_MEMBERS) {
      socket.emit("party:error", { message: "Party is full" });
      return;
    }

    const name = sanitizeStr(displayName || "Listener", 24, true) || "Listener";
    const member = { socketId: socket.id, name };
    party.members.push(member);

    socket.join(`party:${id}`);
    socket.data.partyId = id;
    socket.data.isHost = false;
    socket.data.memberName = name;

    console.log(
      `[Party ${id}] "${name}" joined (${party.members.length} members)`,
    );

    const membersPublic = party.members.map((m) => ({ name: m.name }));

    socket.emit("party:joined", {
      partyId: id,
      hostName: party.hostName,
      state: party.state,
      members: membersPublic,
    });

    io.to(`party:${id}`).emit("party:member-joined", {
      name,
      members: membersPublic,
    });

    io.to("dashboard").emit("dashboard:party-updated", partyPublicView(party));
  });

  // Host broadcasts playback state
  socket.on("party:state-update", ({ partyId, hostToken, state }) => {
    const id = (partyId || "").toUpperCase().slice(0, 6);
    const party = parties.get(id);
    if (!party || party.hostToken !== hostToken) return;

    const safeState = sanitizeState(state);
    // Use host-provided timestamp or fall back to now
    const serverTimestamp = Number.isFinite(Number(state?.serverTimestamp))
      ? Number(state.serverTimestamp)
      : Date.now();

    party.state = { ...party.state, ...safeState, serverTimestamp };

    socket.to(`party:${id}`).emit("party:sync", {
      ...party.state,
      serverTimestamp,
      members: party.members.map((m) => ({ name: m.name })),
      memberCount: party.members.length,
    });

    // Update dashboard only when song changes
    if (safeState.song !== undefined) {
      io.to("dashboard").emit(
        "dashboard:party-updated",
        partyPublicView(party),
      );
    }
  });

  // Dashboard page subscribes for live updates
  socket.on("dashboard:subscribe", () => {
    socket.join("dashboard");
    const list = [];
    for (const [, p] of parties) {
      if (p.hostSocketId) list.push(partyPublicView(p));
    }
    socket.emit("dashboard:init", { parties: list });
  });

  // Web party page watches a specific party (not a full member join)
  socket.on("party:watch", ({ partyId }) => {
    const id = (partyId || "").toUpperCase().slice(0, 6);
    if (parties.has(id)) {
      socket.join(`party:${id}`);
      socket.data.partyId = id;
      socket.data.isHost = false;
      // Watcher only — not added to members list
    }
  });

  socket.on("disconnect", () => {
    const { partyId, isHost, memberName } = socket.data;
    if (!partyId) return;

    const party = parties.get(partyId);
    if (!party) return;

    if (isHost) {
      closeParty(partyId, "Host disconnected");
    } else {
      const name = memberName || "Listener";
      party.members = party.members.filter((m) => m.socketId !== socket.id);
      const membersPublic = party.members.map((m) => ({ name: m.name }));
      io.to(`party:${partyId}`).emit("party:member-left", {
        name,
        members: membersPublic,
      });
      io.to("dashboard").emit(
        "dashboard:party-updated",
        partyPublicView(party),
      );
      console.log(
        `[Party ${partyId}] "${name}" left (${party.members.length} remaining)`,
      );
    }
  });
});

server.listen(PORT, () => {
  console.log(`\nYT Music Sync Server`);
  console.log(`   Running on http://localhost:${PORT}`);
  console.log(`   Max members per party: ${MAX_MEMBERS}`);
  console.log(`   Max active parties: ${MAX_PARTIES}\n`);
});
