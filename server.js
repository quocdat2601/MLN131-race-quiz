const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Load questions
const QUESTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf-8'));

const GROUPS = ['Nhóm 1', 'Nhóm 2', 'Nhóm 3', 'Nhóm 5', 'Nhóm 6', 'Nhóm 7', 'Giảng Viên'];
const ITEMS = [
  { id: 'blooper', emoji: '🦑', name: 'Mực Che Mắt', type: 'offensive' },
  { id: 'banana',  emoji: '🍌', name: 'Vỏ Chuối',    type: 'offensive' },
  { id: 'magnet',  emoji: '🧲', name: 'Nam Châm',     type: 'auto'      },
  { id: 'brick',   emoji: '🧱', name: 'Gạch',         type: 'offensive' },
  { id: 'shield',  emoji: '🛡️', name: 'Khiên',        type: 'self'      },
];
const MILESTONES = [50, 100, 150, 200, 250];

const STATES = {
  LOBBY:          'LOBBY',
  QUESTION:       'QUESTION',
  PAUSED:         'PAUSED',
  REVEAL:         'REVEAL',
  BETWEEN_ROUNDS: 'BETWEEN_ROUNDS',
  GAME_OVER:      'GAME_OVER',
};

// ──────────────────────────────────────────────────────────────
// Timer
// ──────────────────────────────────────────────────────────────
class Timer {
  constructor(duration, onTick, onComplete) {
    this.duration   = duration;
    this.remaining  = duration;
    this.paused     = false;
    this.intervalId = null;
    this.onTick     = onTick;
    this.onComplete = onComplete;
  }

  start() {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => {
      if (this.paused) return;
      this.remaining--;
      this.onTick(this.remaining);
      if (this.remaining <= 0) {
        this.stop();
        this.onComplete();
      }
    }, 1000);
  }

  pause()  { this.paused = true;  }
  resume() { this.paused = false; }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}

// ──────────────────────────────────────────────────────────────
// GameRoom
// ──────────────────────────────────────────────────────────────
class GameRoom {
  constructor(roomCode) {
    this.roomCode     = roomCode;
    this.state        = STATES.LOBBY;
    this.hostSocketId = null;

    // groupName → { members: Set<socketId>, steps, inventory, frozen, shielded, lastMilestone }
    this.groups = {};
    GROUPS.forEach(g => {
      this.groups[g] = { members: new Set(), steps: 0, inventory: [], frozen: false, shielded: false, lastMilestone: 0 };
    });

    this.questions      = [...QUESTIONS].slice(0, 25);
    this.currentQ        = -1;
    this.timer           = null;
    this.startTime       = null;
    this.roundAnswers    = [];
    this.betweenTimer    = null;
    this.betweenCountdown = null;
  }

  getMemberCounts() {
    const counts = {};
    for (const [name, data] of Object.entries(this.groups)) {
      counts[name] = data.members.size;
    }
    return counts;
  }

  addMember(socketId, groupName) {
    const group = this.groups[groupName];
    if (!group) return { error: 'invalid' };
    const maxSize = groupName === 'Giảng Viên' ? 1 : 4;
    if (group.members.size >= maxSize) return { error: 'full', maxSize };
    group.members.add(socketId);
    return { ok: true };
  }

  removeMember(socketId) {
    for (const [name, data] of Object.entries(this.groups)) {
      if (data.members.has(socketId)) {
        data.members.delete(socketId);
        return name;
      }
    }
    return null;
  }

  getGroupBySocket(socketId) {
    return Object.entries(this.groups).find(([, d]) => d.members.has(socketId));
  }

  getPositions() {
    const pos = {};
    for (const [name, data] of Object.entries(this.groups)) {
      if (data.members.size > 0) pos[name] = data.steps;
    }
    return pos;
  }

  getRankings() {
    return Object.entries(this.groups)
      .filter(([, d]) => d.members.size > 0)
      .map(([name, data]) => ({ group: name, steps: data.steps }))
      .sort((a, b) => b.steps - a.steps);
  }

  giveRandomItem(groupName) {
    const item = ITEMS[Math.floor(Math.random() * ITEMS.length)];
    this.groups[groupName].inventory.push(item);
    return item;
  }

  giveCatchupItem(groupName) {
    const rankings = this.getRankings();
    const rank = rankings.findIndex(r => r.group === groupName); // 0 = leader
    const total = rankings.length;
    let item;
    if (rank === 0) {
      // Leader gets shield only
      item = ITEMS.find(i => i.id === 'shield');
    } else if (rank >= total - 2) {
      // Last or second-to-last: 70% offensive, 30% shield
      const offensiveItems = ITEMS.filter(i => i.type === 'offensive' || i.type === 'auto');
      item = Math.random() < 0.7
        ? offensiveItems[Math.floor(Math.random() * offensiveItems.length)]
        : ITEMS.find(i => i.id === 'shield');
    } else {
      item = ITEMS[Math.floor(Math.random() * ITEMS.length)];
    }
    if (!item) item = ITEMS[0];
    this.groups[groupName].inventory.push(item);
    io.to(this.roomCode + '_' + groupName).emit('inventory:update', { items: this.groups[groupName].inventory });
    io.to(this.hostSocketId).emit('item:gained', { groupName, item });
    return item;
  }

  checkMilestone(groupName) {
    const group = this.groups[groupName];
    const nextMilestone = MILESTONES[group.lastMilestone];
    if (nextMilestone !== undefined && group.steps >= nextMilestone) {
      group.lastMilestone++;
      this.giveCatchupItem(groupName);
    }
  }

  startQuestion() {
    this.currentQ++;
    if (this.currentQ >= this.questions.length) {
      this.endGame();
      return;
    }
    // Cancel any pending between-rounds auto-advance
    if (this.betweenTimer) { clearTimeout(this.betweenTimer); this.betweenTimer = null; }
    if (this.betweenCountdown) { clearInterval(this.betweenCountdown); this.betweenCountdown = null; }
    this.state        = STATES.QUESTION;
    this.roundAnswers = [];
    this.startTime    = Date.now();

    const q = this.questions[this.currentQ];
    io.to(this.roomCode).emit('question:shown', {
      number:    this.currentQ + 1,
      total:     this.questions.length,
      text:      q.text,
      options:   q.options,
      timeLimit: 25,
    });

    this.timer = new Timer(
      25,
      (remaining) => {
        io.to(this.roomCode).emit('timer:tick', { remaining });
      },
      () => this.revealAnswer()
    );
    this.timer.start();
  }

  pauseTimer() {
    if (this.state !== STATES.QUESTION) return;
    if (!this.timer) return;
    this.timer.pause();
    this.state = STATES.PAUSED;
    io.to(this.roomCode).emit('timer:paused', { remaining: this.timer.remaining });
  }

  resumeTimer() {
    if (this.state !== STATES.PAUSED) return;
    if (!this.timer) return;
    this.timer.resume();
    this.state = STATES.QUESTION;
    io.to(this.roomCode).emit('timer:resumed');
  }

  submitAnswer(socketId, answer) {
    if (this.state !== STATES.QUESTION && this.state !== STATES.PAUSED) return;

    const entry = this.getGroupBySocket(socketId);
    if (!entry) return;
    const [groupName] = entry;

    // No duplicate
    if (this.roundAnswers.find(a => a.groupName === groupName)) return;

    this.roundAnswers.push({ groupName, answer, serverTime: Date.now() });

    // Notify host of count
    io.to(this.hostSocketId).emit('answers:count', { count: this.roundAnswers.length });

    // Broadcast to all team members: lock + highlight chosen answer
    io.to(this.roomCode + '_' + groupName).emit('team:locked', { answer });
  }

  revealAnswer() {
    if (this.timer) this.timer.stop();
    this.state = STATES.REVEAL;

    const q = this.questions[this.currentQ];
    const correct = q.correct;
    const now = Date.now();

    // Sort correct answers by submission time
    const correctAnswers = this.roundAnswers
      .filter(a => a.answer === correct)
      .sort((a, b) => a.serverTime - b.serverTime);

    const movements = [];

    // Apply frozen state BEFORE awarding steps
    const frozenGroups = Object.entries(this.groups)
      .filter(([, d]) => d.frozen)
      .map(([name]) => name);

    correctAnswers.forEach((a, idx) => {
      const group = this.groups[a.groupName];
      let pts  = 0;
      let item = null;

      if (frozenGroups.includes(a.groupName)) {
        pts = 0;
      } else if (idx === 0 || idx === 1) {
        // Time-based: max 25 pts minus elapsed seconds
        const elapsed = (a.serverTime - this.startTime) / 1000;
        pts = Math.max(0, parseFloat((25 - elapsed).toFixed(2)));
        item = this.giveRandomItem(a.groupName);
        group.steps = parseFloat((group.steps + pts).toFixed(2));
      } else {
        const elapsed = (a.serverTime - this.startTime) / 1000;
        pts = Math.max(0, parseFloat((Math.min(10, 25 - elapsed)).toFixed(2)));
        group.steps = parseFloat((group.steps + pts).toFixed(2));
      }

      // Check milestone after updating steps
      this.checkMilestone(a.groupName);

      movements.push({
        groupName:    a.groupName,
        correct:      true,
        stepsGained:  pts,
        itemReceived: item,
        frozen:       frozenGroups.includes(a.groupName),
      });

      io.to(this.roomCode + '_' + a.groupName).emit('answer:result', {
        correct:      true,
        stepsGained:  pts,
        itemReceived: item,
      });
      if (item) {
        io.to(this.roomCode + '_' + a.groupName).emit('inventory:update', { items: group.inventory });
      }
    });

    // Wrong / no answer
    for (const [name, data] of Object.entries(this.groups)) {
      if (data.members.size === 0) continue;
      const answered = this.roundAnswers.find(a => a.groupName === name);
      if (!answered || answered.answer !== correct) {
        movements.push({ groupName: name, correct: false, stepsGained: 0 });
        io.to(this.roomCode + '_' + name).emit('answer:result', { correct: false, stepsGained: 0 });
      }
    }

    // Unfreeze
    for (const [, data] of Object.entries(this.groups)) {
      data.frozen = false;
    }

    io.to(this.roomCode).emit('answer:revealed', {
      correctAnswer: correct,
      explanation:   q.explanation,
      movements,
    });
    io.to(this.roomCode).emit('ducks:updated', { positions: this.getPositions() });

    this.state = STATES.BETWEEN_ROUNDS;

    // Auto-advance or end game
    if (this.currentQ + 1 >= this.questions.length) {
      io.to(this.roomCode).emit('round:between', { autoAdvanceIn: 0, isLast: true });
      setTimeout(() => this.endGame(), 3000);
    } else {
      let autoSec = 5;
      io.to(this.roomCode).emit('round:between', { autoAdvanceIn: autoSec });
      this.betweenCountdown = setInterval(() => {
        autoSec--;
        io.to(this.roomCode).emit('between:countdown', { remaining: autoSec });
        if (autoSec <= 0) { clearInterval(this.betweenCountdown); this.betweenCountdown = null; }
      }, 1000);
      this.betweenTimer = setTimeout(() => {
        this.betweenTimer = null;
        if (this.state === STATES.BETWEEN_ROUNDS) this.startQuestion();
      }, 5000);
    }
  }

  useItem(socketId, itemId, targetGroup) {
    if (this.state === STATES.LOBBY || this.state === STATES.GAME_OVER) return { error: 'Game not active' };

    const entry = this.getGroupBySocket(socketId);
    if (!entry) return { error: 'Not a player' };
    const [groupName, groupData] = entry;

    const itemIdx = groupData.inventory.findIndex(i => i.id === itemId);
    if (itemIdx === -1) return { error: 'Item not in inventory' };

    const item = groupData.inventory[itemIdx];

    // Validate target for offensive items
    if (item.type === 'offensive') {
      if (!targetGroup || !this.groups[targetGroup]) return { error: 'Invalid target' };
      if (targetGroup === groupName) return { error: 'Cannot target yourself' };
    }

    // Remove from inventory
    groupData.inventory.splice(itemIdx, 1);
    io.to(this.roomCode + '_' + groupName).emit('inventory:update', { items: groupData.inventory });

    if (item.id === 'shield') {
      groupData.shielded = true;
      io.to(this.roomCode + '_' + groupName).emit('effect:shield-gained');
      io.to(this.roomCode).emit('item:used', {
        byGroup: groupName, itemEmoji: item.emoji, itemName: item.name,
        targetGroup: groupName, effect: `${groupName} trang bị Khiên!`, shake: null,
      });
      return { ok: true };
    }

    if (item.id === 'magnet') {
      // Find group ranked just above this one
      const rankings = this.getRankings();
      const myRank = rankings.findIndex(r => r.group === groupName);
      const aboveIdx = myRank > 0 ? myRank - 1 : null;
      const autoTarget = aboveIdx !== null ? rankings[aboveIdx].group : null;
      if (autoTarget) {
        const target = this.groups[autoTarget];
        const steal = Math.min(5, target.steps);
        target.steps = parseFloat((target.steps - steal).toFixed(2));
        groupData.steps = parseFloat((groupData.steps + steal).toFixed(2));
        io.to(this.roomCode).emit('ducks:updated', { positions: this.getPositions() });
        io.to(this.roomCode).emit('item:used', {
          byGroup: groupName, itemEmoji: item.emoji, itemName: item.name,
          targetGroup: autoTarget, effect: `${groupName} hút ${steal.toFixed(2)} điểm từ ${autoTarget}!`, shake: autoTarget,
        });
      }
      return { ok: true };
    }

    // Offensive: blooper, banana, brick
    const target = this.groups[targetGroup];
    if (!target) return { error: 'Invalid target' };

    if (target.shielded) {
      target.shielded = false;
      io.to(this.roomCode + '_' + targetGroup).emit('shield:blocked');
      io.to(this.roomCode).emit('item:used', {
        byGroup: groupName, itemEmoji: item.emoji, itemName: item.name,
        targetGroup, effect: `${item.name} bị chặn bởi Khiên của ${targetGroup}!`, shake: null,
      });
      return { ok: true };
    }

    let effect = '';
    if (item.id === 'blooper') {
      io.to(this.roomCode + '_' + targetGroup).emit('effect:blooper');
      effect = `${targetGroup} bị che mắt 4 giây!`;
    } else if (item.id === 'banana') {
      io.to(this.roomCode + '_' + targetGroup).emit('effect:banana');
      effect = `Đáp án của ${targetGroup} bị xáo trộn!`;
    } else if (item.id === 'brick') {
      const loss = Math.min(5, target.steps);
      target.steps = parseFloat((target.steps - loss).toFixed(2));
      io.to(this.roomCode).emit('ducks:updated', { positions: this.getPositions() });
      effect = `${targetGroup} mất ${loss.toFixed(2)} điểm!`;
    }

    io.to(this.roomCode).emit('item:used', {
      byGroup: groupName, itemEmoji: item.emoji, itemName: item.name,
      targetGroup, effect, shake: targetGroup,
    });
    return { ok: true };
  }

  endGame() {
    this.state = STATES.GAME_OVER;
    if (this.timer) this.timer.stop();
    io.to(this.roomCode).emit('game:over', { rankings: this.getRankings() });
  }
}

// ──────────────────────────────────────────────────────────────
// Single room instance (one game at a time)
// ──────────────────────────────────────────────────────────────
let currentRoom = null;

function generateRoomCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

// ──────────────────────────────────────────────────────────────
// Socket.io handlers
// ──────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  // ── HOST ──────────────────────────────────────────────────
  socket.on('host:create-room', () => {
    const code = generateRoomCode();
    currentRoom = new GameRoom(code);
    currentRoom.hostSocketId = socket.id;
    socket.join(code);
    socket.emit('host:room-created', { roomCode: code });
  });

  socket.on('host:start-game', () => {
    if (!currentRoom || currentRoom.hostSocketId !== socket.id) return;
    if (currentRoom.state !== STATES.LOBBY) return;
    const activeGroups = Object.entries(currentRoom.groups)
      .filter(([, d]) => d.members.size > 0)
      .map(([name]) => name);
    io.to(currentRoom.roomCode).emit('game:started', { activeGroups });
    currentRoom.startQuestion();
  });

  socket.on('host:pause-timer', () => {
    if (!currentRoom) return;
    currentRoom.pauseTimer();
  });

  socket.on('host:resume-timer', () => {
    if (!currentRoom) return;
    currentRoom.resumeTimer();
  });

  socket.on('host:reveal-answer', () => {
    if (!currentRoom) return;
    if (currentRoom.state !== STATES.QUESTION && currentRoom.state !== STATES.PAUSED) return;
    currentRoom.revealAnswer();
  });

  socket.on('host:next-question', () => {
    if (!currentRoom) return;
    if (currentRoom.state !== STATES.BETWEEN_ROUNDS) return;
    if (currentRoom.betweenTimer) { clearTimeout(currentRoom.betweenTimer); currentRoom.betweenTimer = null; }
    if (currentRoom.betweenCountdown) { clearInterval(currentRoom.betweenCountdown); currentRoom.betweenCountdown = null; }
    currentRoom.startQuestion();
  });

  socket.on('host:end-game', () => {
    if (!currentRoom) return;
    currentRoom.endGame();
  });

  // ── CLIENT ────────────────────────────────────────────────
  socket.on('client:peek-room', ({ roomCode }) => {
    if (!roomCode || typeof roomCode !== 'string') return;
    if (!currentRoom || currentRoom.roomCode !== roomCode) {
      socket.emit('lobby:member-counts', null);
      return;
    }
    socket.join(roomCode);
    // Broadcast to whole room so all waiting clients get refreshed counts
    io.to(roomCode).emit('lobby:member-counts', currentRoom.getMemberCounts());
  });

  socket.on('client:join', ({ roomCode, groupName }) => {
    if (!roomCode || typeof roomCode !== 'string') return;
    if (!groupName || !GROUPS.includes(groupName)) {
      socket.emit('join:error', { message: 'Tên nhóm không hợp lệ.' });
      return;
    }

    if (!currentRoom || currentRoom.roomCode !== roomCode) {
      socket.emit('join:error', { message: 'Mã phòng không đúng.' });
      return;
    }

    if (currentRoom.state !== STATES.LOBBY) {
      socket.emit('join:error', { message: 'Game đã bắt đầu.' });
      return;
    }

    const result = currentRoom.addMember(socket.id, groupName);
    if (result.error === 'full') {
      const max = result.maxSize || 4;
      socket.emit('join:error', { message: `${groupName} đã đủ ${max} thành viên.` });
      return;
    }

    socket.join(roomCode);
    socket.join(roomCode + '_' + groupName);
    socket.emit('join:success', { groupName });
    io.to(currentRoom.roomCode).emit('lobby:member-counts', currentRoom.getMemberCounts());
  });

  socket.on('client:submit-answer', ({ answer }) => {
    if (!currentRoom) return;
    if (!['A', 'B', 'C', 'D'].includes(answer)) return;
    currentRoom.submitAnswer(socket.id, answer);
  });

  socket.on('client:use-item', ({ itemId, targetGroup }) => {
    if (!currentRoom) return;
    const result = currentRoom.useItem(socket.id, itemId, targetGroup);
    if (result && result.error) {
      socket.emit('item:error', { message: result.error });
    }
  });

  // ── DEV TOOLS ──────────────────────────────────────────────
  socket.on('dev:give-item', ({ groupName, itemId }) => {
    if (!currentRoom || !currentRoom.groups[groupName]) return;
    const item = ITEMS.find(i => i.id === itemId);
    if (!item) return;
    currentRoom.groups[groupName].inventory.push(item);
    io.to(currentRoom.roomCode + '_' + groupName).emit('inventory:update', { items: currentRoom.groups[groupName].inventory });
    socket.emit('dev:log', { msg: `✅ Gave ${item.emoji} ${item.name} → ${groupName}` });
  });

  socket.on('dev:adjust-score', ({ groupName, delta }) => {
    if (!currentRoom || !currentRoom.groups[groupName]) return;
    const g = currentRoom.groups[groupName];
    g.steps = Math.max(0, parseFloat((g.steps + delta).toFixed(2)));
    io.to(currentRoom.roomCode).emit('ducks:updated', { positions: currentRoom.getPositions() });
    socket.emit('dev:log', { msg: `✅ ${groupName}: score ${delta >= 0 ? '+' : ''}${delta} → ${g.steps}` });
  });

  socket.on('dev:submit-answer', ({ groupName, answer }) => {
    if (!currentRoom || !currentRoom.groups[groupName]) return;
    if (currentRoom.state !== STATES.QUESTION && currentRoom.state !== STATES.PAUSED) {
      socket.emit('dev:log', { msg: '⚠️ Not in QUESTION state' }); return;
    }
    if (currentRoom.roundAnswers.find(a => a.groupName === groupName)) {
      socket.emit('dev:log', { msg: `⚠️ ${groupName} already answered` }); return;
    }
    currentRoom.roundAnswers.push({ groupName, answer, serverTime: Date.now() });
    io.to(currentRoom.hostSocketId).emit('answers:count', { count: currentRoom.roundAnswers.length });
    io.to(currentRoom.roomCode + '_' + groupName).emit('team:locked', { answer });
    socket.emit('dev:log', { msg: `✅ ${groupName} answered ${answer}` });
  });

  socket.on('dev:submit-correct', ({ groupName }) => {
    if (!currentRoom || !currentRoom.groups[groupName]) return;
    if (currentRoom.state !== STATES.QUESTION && currentRoom.state !== STATES.PAUSED) {
      socket.emit('dev:log', { msg: '⚠️ Not in QUESTION state' }); return;
    }
    if (currentRoom.roundAnswers.find(a => a.groupName === groupName)) {
      socket.emit('dev:log', { msg: `⚠️ ${groupName} already answered` }); return;
    }
    const correct = currentRoom.questions[currentRoom.currentQ].correct;
    currentRoom.roundAnswers.push({ groupName, answer: correct, serverTime: Date.now() });
    io.to(currentRoom.hostSocketId).emit('answers:count', { count: currentRoom.roundAnswers.length });
    io.to(currentRoom.roomCode + '_' + groupName).emit('team:locked', { answer: correct });
    socket.emit('dev:log', { msg: `✅ ${groupName} auto-correct (${correct})` });
  });

  socket.on('dev:reveal', () => {
    if (!currentRoom) return;
    if (currentRoom.state !== STATES.QUESTION && currentRoom.state !== STATES.PAUSED) return;
    currentRoom.revealAnswer();
    socket.emit('dev:log', { msg: '✅ Revealed answer' });
  });

  socket.on('dev:next-question', () => {
    if (!currentRoom || currentRoom.state !== STATES.BETWEEN_ROUNDS) return;
    if (currentRoom.betweenTimer) { clearTimeout(currentRoom.betweenTimer); currentRoom.betweenTimer = null; }
    if (currentRoom.betweenCountdown) { clearInterval(currentRoom.betweenCountdown); currentRoom.betweenCountdown = null; }
    currentRoom.startQuestion();
    socket.emit('dev:log', { msg: '✅ Forced next question' });
  });

  socket.on('dev:set-score', ({ groupName, value }) => {
    if (!currentRoom || !currentRoom.groups[groupName]) return;
    currentRoom.groups[groupName].steps = Math.max(0, parseFloat(parseFloat(value).toFixed(2)));
    io.to(currentRoom.roomCode).emit('ducks:updated', { positions: currentRoom.getPositions() });
    socket.emit('dev:log', { msg: `✅ ${groupName} score set to ${value}` });
  });

  socket.on('dev:apply-item', ({ fromGroup, itemId, targetGroup }) => {
    if (!currentRoom) return;
    const item = ITEMS.find(i => i.id === itemId);
    if (!item) return;
    const target = currentRoom.groups[targetGroup];
    if (!target) { socket.emit('dev:log', { msg: `⚠️ Invalid target: ${targetGroup}` }); return; }

    const label = fromGroup || 'Dev';
    if (itemId === 'blooper') {
      io.to(currentRoom.roomCode + '_' + targetGroup).emit('effect:blooper');
      io.to(currentRoom.roomCode).emit('item:used', {
        byGroup: label, itemEmoji: item.emoji, itemName: item.name,
        targetGroup, effect: `[DEV] ${targetGroup} bị che mắt!`, shake: targetGroup,
      });
    } else if (itemId === 'banana') {
      io.to(currentRoom.roomCode + '_' + targetGroup).emit('effect:banana');
      io.to(currentRoom.roomCode).emit('item:used', {
        byGroup: label, itemEmoji: item.emoji, itemName: item.name,
        targetGroup, effect: `[DEV] Đáp án ${targetGroup} bị xáo trộn!`, shake: targetGroup,
      });
    } else if (itemId === 'brick') {
      const loss = Math.min(5, target.steps);
      target.steps = parseFloat((target.steps - loss).toFixed(2));
      io.to(currentRoom.roomCode).emit('ducks:updated', { positions: currentRoom.getPositions() });
      io.to(currentRoom.roomCode).emit('item:used', {
        byGroup: label, itemEmoji: item.emoji, itemName: item.name,
        targetGroup, effect: `[DEV] ${targetGroup} mất ${loss.toFixed(2)} điểm!`, shake: targetGroup,
      });
    }
    socket.emit('dev:log', { msg: `✅ [DEV] ${item.emoji} ${item.name} → ${targetGroup}` });
  });

  // ── DISCONNECT ────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (!currentRoom) return;

    if (currentRoom.hostSocketId === socket.id) {
      // Host disconnected — notify clients
      io.to(currentRoom.roomCode).emit('host:disconnected');
      return;
    }

    const name = currentRoom.removeMember(socket.id);
    if (name && currentRoom.state === STATES.LOBBY) {
      io.to(currentRoom.roomCode).emit('lobby:member-counts', currentRoom.getMemberCounts());
    }
  });
});

// ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Duck Race server running on http://localhost:${PORT}`);
  console.log(`Host screen: http://localhost:${PORT}/host.html`);
  console.log(`Client screen: http://localhost:${PORT}/client.html`);
});
