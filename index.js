require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST', 'DELETE'] },
});

const PORT = process.env.PORT || 3000;
const MAX_MEMBERS = parseInt(process.env.MAX_MEMBERS || '50');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory party store
// Map<partyId, Party>
// Party: { id, hostSocketId, hostToken, hostName, createdAt, state, members[] }
const parties = new Map();

function generatePartyId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
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

function closeParty(partyId, reason = 'Party closed') {
  const party = parties.get(partyId);
  if (!party) return;
  io.to(`party:${partyId}`).emit('party:closed', { reason });
  parties.delete(partyId);
  io.to('dashboard').emit('dashboard:party-removed', { partyId });
  console.log(`[Party ${partyId}] Closed: ${reason}`);
}

// REST API

// POST /api/party/create
app.post('/api/party/create', (req, res) => {
  const { hostName } = req.body;
  if (!hostName || typeof hostName !== 'string') {
    return res.status(400).json({ error: 'hostName is required' });
  }

  let partyId;
  let attempts = 0;
  do {
    partyId = generatePartyId();
    attempts++;
    if (attempts > 100) return res.status(500).json({ error: 'Could not generate unique party ID' });
  } while (parties.has(partyId));

  const hostToken = uuidv4();
  const party = {
    id: partyId,
    hostSocketId: null,
    hostToken,
    hostName: hostName.trim().slice(0, 32),
    createdAt: Date.now(),
    state: {
      song: '',
      artist: '',
      url: '',
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      thumbnail: '',
    },
    members: [],
  };

  parties.set(partyId, party);

  // Auto-expire if host never connects via socket within 5 minutes
  setTimeout(() => {
    const p = parties.get(partyId);
    if (p && !p.hostSocketId) {
      parties.delete(partyId);
      console.log(`[Party ${partyId}] Expired (host never connected)`);
    }
  }, 5 * 60 * 1000);

  console.log(`[Party ${partyId}] Created by "${party.hostName}"`);
  res.json({ partyId, hostToken });
});

// GET /api/parties
app.get('/api/parties', (_req, res) => {
  const list = [];
  for (const [, party] of parties) {
    if (party.hostSocketId) list.push(partyPublicView(party));
  }
  res.json(list);
});

// GET /api/party/:id
app.get('/api/party/:id', (req, res) => {
  const party = parties.get(req.params.id.toUpperCase());
  if (!party) return res.status(404).json({ error: 'Party not found' });
  res.json(partyPublicView(party, true));
});

// DELETE /api/party/:id
app.delete('/api/party/:id', (req, res) => {
  const party = parties.get(req.params.id.toUpperCase());
  if (!party) return res.status(404).json({ error: 'Party not found' });
  if (party.hostToken !== req.body.hostToken) return res.status(403).json({ error: 'Invalid host token' });
  closeParty(party.id, 'Host ended the party');
  res.json({ ok: true });
});

// Serve party page for any /party/:id
app.get('/party/:id', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'party.html'));
});

// Socket.IO
io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  // Host registers their socket
  socket.on('party:host-connect', ({ partyId, hostToken }) => {
    const id = (partyId || '').toUpperCase();
    const party = parties.get(id);
    if (!party || party.hostToken !== hostToken) {
      socket.emit('party:error', { message: 'Invalid party ID or token' });
      return;
    }

    party.hostSocketId = socket.id;
    socket.join(`party:${id}`);
    socket.data.partyId = id;
    socket.data.isHost = true;

    console.log(`[Party ${id}] Host socket connected`);
    socket.emit('party:host-ready', { partyId: id, memberCount: party.members.length });
    io.to(`party:${id}`).emit('party:host-online', { hostName: party.hostName });
    io.to('dashboard').emit('dashboard:party-added', partyPublicView(party));
  });

  // Member joins via web page
  socket.on('party:join', ({ partyId, displayName }) => {
    const id = (partyId || '').toUpperCase();
    const party = parties.get(id);

    if (!party) {
      socket.emit('party:error', { message: 'Party not found or has ended' });
      return;
    }
    if (!party.hostSocketId) {
      socket.emit('party:error', { message: 'Host is not online yet' });
      return;
    }
    if (party.members.length >= MAX_MEMBERS) {
      socket.emit('party:error', { message: 'Party is full' });
      return;
    }

    const name = (displayName || 'Listener').trim().slice(0, 24) || 'Listener';
    const member = { socketId: socket.id, name };
    party.members.push(member);

    socket.join(`party:${id}`);
    socket.data.partyId = id;
    socket.data.isHost = false;
    socket.data.memberName = name;

    console.log(`[Party ${id}] "${name}" joined (${party.members.length} members)`);

    const membersPublic = party.members.map((m) => ({ name: m.name }));

    socket.emit('party:joined', {
      partyId: id,
      hostName: party.hostName,
      state: party.state,
      members: membersPublic,
    });

    io.to(`party:${id}`).emit('party:member-joined', {
      name,
      members: membersPublic,
    });

    io.to('dashboard').emit('dashboard:party-updated', partyPublicView(party));
  });

  // Host broadcasts playback state
  socket.on('party:state-update', ({ partyId, hostToken, state }) => {
    const id = (partyId || '').toUpperCase();
    const party = parties.get(id);
    if (!party || party.hostToken !== hostToken) return;

    party.state = { ...party.state, ...state };

    socket.to(`party:${id}`).emit('party:sync', {
      ...party.state,
      members: party.members.map((m) => ({ name: m.name })),
      memberCount: party.members.length,
    });

    // Throttled dashboard update (only when song changes)
    if (state.song !== undefined) {
      io.to('dashboard').emit('dashboard:party-updated', partyPublicView(party));
    }
  });

  // Dashboard page subscribes for live updates
  socket.on('dashboard:subscribe', () => {
    socket.join('dashboard');
    const list = [];
    for (const [, p] of parties) {
      if (p.hostSocketId) list.push(partyPublicView(p));
    }
    socket.emit('dashboard:init', { parties: list });
  });

  // Web party page watches a specific party (not a full member join)
  socket.on('party:watch', ({ partyId }) => {
    const id = (partyId || '').toUpperCase();
    if (parties.has(id)) {
      socket.join(`party:${id}`);
      socket.data.partyId = id;
      socket.data.isHost  = false;
      // Don't add to members list — watcher only
    }
  });

  socket.on('disconnect', () => {
    const { partyId, isHost, memberName } = socket.data;
    if (!partyId) return;

    const party = parties.get(partyId);
    if (!party) return;

    if (isHost) {
      closeParty(partyId, 'Host disconnected');
    } else {
      const name = memberName || 'Listener';
      party.members = party.members.filter((m) => m.socketId !== socket.id);
      const membersPublic = party.members.map((m) => ({ name: m.name }));
      io.to(`party:${partyId}`).emit('party:member-left', { name, members: membersPublic });
      io.to('dashboard').emit('dashboard:party-updated', partyPublicView(party));
      console.log(`[Party ${partyId}] "${name}" left (${party.members.length} remaining)`);
    }
  });
});

server.listen(PORT, () => {
  console.log(`\nYT Music Sync Server`);
  console.log(`   Running on http://localhost:${PORT}`);
  console.log(`   Max members per party: ${MAX_MEMBERS}\n`);
});
