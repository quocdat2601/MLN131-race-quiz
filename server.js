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

const GROUPS = ['Nhóm 1', 'Nhóm 2', 'Nhóm 3', 'Nhóm 5', 'Nhóm 6', 'Nhóm 7'];
const ITEMS = [
  { id: 'bug',    emoji: '🐛', name: 'Bug',    type: 'offensive' },
  { id: 'rocket', emoji: '🚀', name: 'Rocket', type: 'self'      },
  { id: 'shield', emoji: '🛡️', name: 'Shield', type: 'self'      },
  { id: 'freeze', emoji: '❄️', name: 'Freeze', type: 'offensive' },
  { id: 'swap',   emoji: '🔄', name: 'Swap',   type: 'offensive' },
];

const STATES = {
  LOBBY:          'LOBBY',
  QUESTION:       'QUESTION',
  PAUSED:         'PAUSED',
  REVEAL:         'REVEAL',
  ITEM_PHASE:     'ITEM_PHASE',
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

    // groupName → { members: Set<socketId>, steps, inventory, frozen, shielded, usedItemThisPhase }
    this.groups = {};
    GROUPS.forEach(g => {
      this.groups[g] = { members: new Set(), steps: 0, inventory: [], frozen: false, shielded: false, usedItemThisPhase: false };
    });

    this.questions     = [...QUESTIONS];
    this.currentQ      = -1;
    this.timer         = null;
    this.roundAnswers  = []; // { groupName, answer, serverTime }[]
    this.itemsThisPhase = {}; // groupName → item queued { itemId, targetGroup }
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
    if (group.members.size >= 4) return { error: 'full' };
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

  startQuestion() {
    this.currentQ++;
    if (this.currentQ >= this.questions.length) {
      this.endGame();
      return;
    }
    this.state       = STATES.QUESTION;
    this.roundAnswers = [];

    // Reset per-round flags
    for (const data of Object.values(this.groups)) {
      data.usedItemThisPhase = false;
    }

    const q = this.questions[this.currentQ];
    io.to(this.roomCode).emit('question:shown', {
      number:    this.currentQ + 1,
      total:     this.questions.length,
      text:      q.text,
      options:   q.options,
      timeLimit: 20,
    });

    this.timer = new Timer(
      20,
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

    // Sort correct answers by submission time
    const correctAnswers = this.roundAnswers
      .filter(a => a.answer === correct)
      .sort((a, b) => a.serverTime - b.serverTime);

    const movements = [];

    // Apply frozen state BEFORE awarding steps (frozen = skip this round's steps)
    const frozenGroups = Object.entries(this.groups)
      .filter(([, d]) => d.frozen)
      .map(([name]) => name);

    correctAnswers.forEach((a, idx) => {
      const group = this.groups[a.groupName];
      let steps = 0;
      let item  = null;

      if (frozenGroups.includes(a.groupName)) {
        steps = 0; // frozen this round
      } else if (idx === 0 || idx === 1) {
        steps = 3;
        item  = this.giveRandomItem(a.groupName);
        group.steps += steps;
      } else {
        steps = 1;
        group.steps += steps;
      }

      movements.push({
        groupName:    a.groupName,
        correct:      true,
        stepsGained:  steps,
        itemReceived: item,
        frozen:       frozenGroups.includes(a.groupName),
      });

      // Notify team of result
      io.to(this.roomCode + '_' + a.groupName).emit('answer:result', {
        correct:      true,
        stepsGained:  steps,
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

    // Unfreeze groups (freeze lasts exactly 1 question)
    for (const [, data] of Object.entries(this.groups)) {
      data.frozen = false;
    }

    io.to(this.roomCode).emit('answer:revealed', {
      correctAnswer: correct,
      explanation:   q.explanation,
      movements,
    });
    io.to(this.roomCode).emit('ducks:updated', { positions: this.getPositions() });

    // Start item phase
    this.startItemPhase();
  }

  startItemPhase() {
    this.state          = STATES.ITEM_PHASE;
    this.itemsThisPhase = {};

    // Check if any group has items
    const anyItems = Object.values(this.groups).some(d => d.inventory.length > 0);

    io.to(this.roomCode).emit('item-phase:started', { timeLimit: 15, anyItems });

    this.timer = new Timer(
      15,
      (remaining) => {
        io.to(this.roomCode).emit('timer:tick', { remaining });
      },
      () => this.resolveItemPhase()
    );
    this.timer.start();
  }

  useItem(socketId, itemId, targetGroup) {
    if (this.state !== STATES.ITEM_PHASE) return { error: 'Not in item phase' };

    const entry = this.getGroupBySocket(socketId);
    if (!entry) return { error: 'Not a player' };
    const [groupName, groupData] = entry;

    if (groupData.usedItemThisPhase) return { error: 'Already used item this phase' };

    const itemIdx = groupData.inventory.findIndex(i => i.id === itemId);
    if (itemIdx === -1) return { error: 'Item not in inventory' };

    const item = groupData.inventory[itemIdx];

    // Validate target
    if (item.type === 'offensive') {
      if (!targetGroup || !this.groups[targetGroup]) return { error: 'Invalid target' };
      if (targetGroup === groupName) return { error: 'Cannot target yourself' };
    }

    // Remove from inventory
    groupData.inventory.splice(itemIdx, 1);
    groupData.usedItemThisPhase = true;

    // Queue item for resolution
    this.itemsThisPhase[groupName] = { itemId, targetGroup, item };

    io.to(this.roomCode + '_' + groupName).emit('inventory:update', { items: groupData.inventory });
    return { ok: true };
  }

  resolveItemPhase() {
    if (this.timer) this.timer.stop();
    this.state = STATES.BETWEEN_ROUNDS;

    // Process queued items
    // Shields first (so they can block)
    const shieldUsers = Object.entries(this.itemsThisPhase)
      .filter(([, q]) => q.itemId === 'shield');
    for (const [groupName] of shieldUsers) {
      this.groups[groupName].shielded = true;
    }

    // Offensive items
    const offensiveItems = Object.entries(this.itemsThisPhase)
      .filter(([, q]) => q.item.type === 'offensive');

    for (const [byGroup, q] of offensiveItems) {
      const { item, targetGroup } = q;
      const target = this.groups[targetGroup];
      if (!target) continue;

      // Check shield
      if (target.shielded) {
        target.shielded = false;
        io.to(this.roomCode + '_' + targetGroup).emit('shield:blocked');
        io.to(this.roomCode).emit('item:used', {
          byGroup,
          itemEmoji: item.emoji,
          itemName:  item.name,
          targetGroup,
          effect:    `${item.name} bị chặn bởi Shield của ${targetGroup}!`,
        });
        continue;
      }

      let effect = '';
      if (item.id === 'bug') {
        const loss = Math.min(2, target.steps);
        target.steps -= loss;
        effect = `${targetGroup} mất ${loss} bước!`;
      } else if (item.id === 'freeze') {
        target.frozen = true;
        effect = `${targetGroup} bị đóng băng 1 câu!`;
        io.to(this.roomCode + '_' + targetGroup).emit('frozen:notified');
      } else if (item.id === 'swap') {
        const bySteps         = this.groups[byGroup].steps;
        this.groups[byGroup].steps = target.steps;
        target.steps          = bySteps;
        effect = `${byGroup} và ${targetGroup} đổi vị trí!`;
      }

      io.to(this.roomCode).emit('item:used', {
        byGroup,
        itemEmoji: item.emoji,
        itemName:  item.name,
        targetGroup,
        effect,
      });
    }

    // Rocket (self)
    const rocketUsers = Object.entries(this.itemsThisPhase)
      .filter(([, q]) => q.itemId === 'rocket');
    for (const [groupName] of rocketUsers) {
      this.groups[groupName].steps += 3;
      io.to(this.roomCode).emit('item:used', {
        byGroup:    groupName,
        itemEmoji:  '🚀',
        itemName:   'Rocket',
        targetGroup: groupName,
        effect:     `${groupName} dùng Rocket, tiến thêm 3 bước!`,
      });
    }

    io.to(this.roomCode).emit('ducks:updated', { positions: this.getPositions() });
    io.to(this.roomCode).emit('item-phase:ended');

    // If last question → game over; else wait for host
    if (this.currentQ + 1 >= this.questions.length) {
      this.endGame();
    }
    // else host presses next-question
  }

  skipItemPhase() {
    if (this.state !== STATES.ITEM_PHASE) return;
    if (this.timer) this.timer.stop();
    this.resolveItemPhase();
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
    io.to(currentRoom.roomCode).emit('game:started');
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

  socket.on('host:skip-item-phase', () => {
    if (!currentRoom) return;
    currentRoom.skipItemPhase();
  });

  socket.on('host:next-question', () => {
    if (!currentRoom) return;
    if (currentRoom.state !== STATES.BETWEEN_ROUNDS) return;
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
      socket.emit('join:error', { message: `${groupName} đã đủ 4 thành viên.` });
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
