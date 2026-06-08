const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 30000,
  pingInterval: 10000,
});

app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory state ────────────────────────────────────────────────────────
// queue: [{ socket, nickname, tags }]
// partners: Map<socketId, socketId>
const queue    = [];
const partners = new Map();

// ── Helpers ────────────────────────────────────────────────────────────────
function generateId() {
  return String(Math.floor(Math.random() * 9000) + 1000);
}

function getCommonTags(a, b) {
  return a.filter(t => b.includes(t));
}

function broadcastOnlineCount() {
  io.emit('onlineCount', io.engine.clientsCount);
}

// Remove socket from the waiting queue (no-op if not present).
function dequeue(socketId) {
  const idx = queue.findIndex(u => u.socket.id === socketId);
  if (idx !== -1) queue.splice(idx, 1);
}

// Disconnect socket from its current partner, optionally notifying the partner.
function leaveChat(socket, notifyPartner) {
  dequeue(socket.id);

  const partnerId = partners.get(socket.id);
  if (!partnerId) return;

  partners.delete(socket.id);
  partners.delete(partnerId);

  if (notifyPartner) {
    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (partnerSocket) partnerSocket.emit('strangerLeft');
  }
}

// Try to pair socket with someone already in queue, or enqueue it.
function tryMatch(socket) {
  // Find a waiting user that isn't this socket.
  const idx = queue.findIndex(u => u.socket.id !== socket.id);

  if (idx === -1) {
    queue.push({ socket, nickname: socket.nickname, tags: socket.tags });
    socket.emit('waiting');
    return;
  }

  const other      = queue.splice(idx, 1)[0];
  const commonTags = getCommonTags(socket.tags, other.socket.tags);

  partners.set(socket.id,       other.socket.id);
  partners.set(other.socket.id, socket.id);

  socket.emit('matched', { strangerName: other.socket.nickname, commonTags });
  other.socket.emit('matched', { strangerName: socket.nickname, commonTags });
}

// ── Socket.IO ──────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  const id          = generateId();
  socket.strangerId = id;
  socket.nickname   = `Stranger #${id}`;
  socket.tags       = [];

  broadcastOnlineCount();

  // User enters the matchmaking queue.
  socket.on('join', ({ nickname, tags } = {}) => {
    socket.nickname = (typeof nickname === 'string' && nickname.trim())
      ? nickname.trim().slice(0, 20)
      : `Stranger #${socket.strangerId}`;
    socket.tags = Array.isArray(tags) ? tags.slice(0, 15) : [];

    tryMatch(socket);
  });

  // Forward a chat message to the partner.
  socket.on('message', ({ text } = {}) => {
    if (typeof text !== 'string') return;
    const trimmed = text.trim().slice(0, 1000);
    if (!trimmed) return;

    const partnerId = partners.get(socket.id);
    if (!partnerId) return;

    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (partnerSocket) partnerSocket.emit('message', { text: trimmed });
  });

  // Forward typing state to the partner.
  socket.on('typing', ({ isTyping } = {}) => {
    const partnerId = partners.get(socket.id);
    if (!partnerId) return;
    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (partnerSocket) partnerSocket.emit('typing', { isTyping: Boolean(isTyping) });
  });

  // User skips — notify partner, then re-enter queue.
  socket.on('skip', () => {
    leaveChat(socket, true);
    tryMatch(socket);
  });

  // User explicitly ends chat — notify partner, don't re-queue.
  socket.on('end', () => {
    leaveChat(socket, true);
  });

  // Browser tab closed / network drop.
  socket.on('disconnect', () => {
    leaveChat(socket, true);
    broadcastOnlineCount();
  });
});

// ── Start server ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Yaaro.chat running → http://localhost:${PORT}`);
});
