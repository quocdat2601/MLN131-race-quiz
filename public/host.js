const socket = io();

// ── State ────────────────────────────────────────────────────
let roomCode       = '';
let gameState      = 'LOBBY';
let totalSteps     = {};
let timerMax       = 20;
let timerRemaining = 20;
let isPaused       = false;
let frozenGroups   = new Set();

const GROUPS = ['Nhóm 1', 'Nhóm 2', 'Nhóm 3', 'Nhóm 5', 'Nhóm 6', 'Nhóm 7'];
const DUCK_EMOJIS = {
  'Nhóm 1': '🦆', 'Nhóm 2': '🐤', 'Nhóm 3': '🦜',
  'Nhóm 5': '🐧', 'Nhóm 6': '🦩', 'Nhóm 7': '🦚'
};
const MEDALS = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣'];

// ── DOM ──────────────────────────────────────────────────────
const screens        = { lobby: $('screen-lobby'), game: $('screen-game'), gameover: $('screen-gameover') };
const btnCreateRoom  = $('btn-create-room');
const lobbyRoomInfo  = $('lobby-room-info');
const lobbyRoomCode  = $('lobby-room-code');
const lobbyGroupCount= $('lobby-groups-count');
const lobbyGroupList = $('lobby-groups-list');
const btnStartGame   = $('btn-start-game');

const topbarCode     = $('topbar-code');
const qCounter       = $('question-counter');
const btnPauseResume = $('btn-pause-resume');
const btnReveal      = $('btn-reveal');
const btnSkipItems   = $('btn-skip-items');
const btnNextQ       = $('btn-next-q');
const btnEndGame     = $('btn-end-game');

const questionPanel  = $('question-panel');
const qNumberBadge   = $('q-number-badge');
const timerDisplay   = $('timer-display');
const timerBar       = $('timer-bar');
const answerCountBadge = $('answer-count-badge');
const qText          = $('q-text');
const itemPhaseBanner= $('item-phase-banner');
const itemTimer      = $('item-timer');
const raceTrack      = $('race-track');
const toastContainer = $('toast-container');
const finalRankings  = $('final-rankings');
const btnRestart     = $('btn-restart');

function $(id) { return document.getElementById(id); }

// ── Build race track ─────────────────────────────────────────
function buildTrack() {
  // Keep start-line
  const startLine = raceTrack.querySelector('.start-line');
  raceTrack.innerHTML = '';
  raceTrack.appendChild(startLine);

  // Add bubbles container
  const bubbleCount = 15;
  const bubblesDiv = document.createElement('div');
  bubblesDiv.className = 'bubbles';
  for (let i = 0; i < bubbleCount; i++) {
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.style.left = Math.random() * 100 + '%';
    bubble.style.width = bubble.style.height = (Math.random() * 10 + 5) + 'px';
    bubble.style.animationDelay = Math.random() * 10 + 's';
    bubble.style.animationDuration = (Math.random() * 5 + 8) + 's';
    bubblesDiv.appendChild(bubble);
  }
  raceTrack.appendChild(bubblesDiv);

  GROUPS.forEach((group, index) => {
    totalSteps[group] = 0;
    // Organic positioning: staggered vertical offsets across the whole water area
    // Starting from 24% height to avoid being covered by the question panel
    const verticalOffset = 24 + (index * (68 / (GROUPS.length - 1))) + (Math.random() * 4 - 2);
    
    const duckData = document.createElement('div');
    duckData.className = 'duck';
    duckData.id = `duck-${group.replace(' ','')}`;
    duckData.style.left = '5%';
    duckData.style.top = verticalOffset + '%';
    duckData.style.zIndex = 10 + index;
    // Add variations in color
    const hueRotation = (index * (360 / GROUPS.length)) % 360;
    
    duckData.innerHTML = `
      <img src="assets/duck.png" alt="duck" style="filter: hue-rotate(${hueRotation}deg)">
      <div class="duck-name-tag">${group}</div>
      <span class="duck-steps" id="steps-${group.replace(' ','')}">0</span>
    `;
    raceTrack.appendChild(duckData);
  });
}
buildTrack();

// ── Duck position ─────────────────────────────────────────────
// No finish line. max visual = 80 steps fills 90% of track.
const MAX_VISUAL_STEPS = 80;
function duckLeft(steps) {
  const pct = 5 + (Math.min(steps, MAX_VISUAL_STEPS) / MAX_VISUAL_STEPS) * 88;
  return pct + '%';
}

function updateDucks(positions) {
  let leader = { group: '', steps: -1 };

  for (const [group, steps] of Object.entries(positions)) {
    totalSteps[group] = steps;
    if (steps > leader.steps) {
      leader = { group, steps };
    }

    const key = group.replace(' ','');
    const duckEl  = document.getElementById(`duck-${key}`);
    const stepsEl = document.getElementById(`steps-${key}`);
    
    if (duckEl) {
      duckEl.style.left = duckLeft(steps);
      duckEl.classList.toggle('frozen', frozenGroups.has(group));
      // Remove leader class initially
      duckEl.classList.remove('leader');
    }
    if (stepsEl) stepsEl.textContent = steps;
  }

  // Highlight leader if they have at least 1 step
  if (leader.steps > 0) {
    const leaderDuck = document.getElementById(`duck-${leader.group.replace(' ','')}`);
    if (leaderDuck) leaderDuck.classList.add('leader');
  }
}

// ── Screen switch ─────────────────────────────────────────────
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
  screens[name].style.display = 'flex';
  Object.entries(screens).forEach(([k, s]) => {
    if (k !== name) s.style.display = 'none';
  });
}
showScreen('lobby');

// ── Timer bar ─────────────────────────────────────────────────
function setTimerUI(remaining, max) {
  timerDisplay.textContent = remaining;
  const pct = (remaining / max) * 100;
  timerBar.style.width = pct + '%';
  timerBar.style.background = pct > 50 ? '#27ae60' : pct > 25 ? '#e6b800' : '#c0392b';
}

// ── Toast ─────────────────────────────────────────────────────
function toast(html) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = html;
  toastContainer.appendChild(el);
  setTimeout(() => el.remove(), 4100);
}

// ── Controls state ────────────────────────────────────────────
function setControlState(state) {
  gameState = state;
  btnReveal.style.display      = (state === 'QUESTION' || state === 'PAUSED') ? '' : 'none';
  btnPauseResume.style.display = (state === 'QUESTION' || state === 'PAUSED') ? '' : 'none';
  btnSkipItems.style.display   = (state === 'ITEM_PHASE') ? '' : 'none';
  btnNextQ.style.display       = (state === 'BETWEEN_ROUNDS') ? '' : 'none';

  if (state === 'PAUSED') {
    btnPauseResume.textContent = '▶ Resume';
    btnPauseResume.className   = 'btn-ctrl btn-green';
    isPaused = true;
  } else if (state === 'QUESTION') {
    btnPauseResume.textContent = '⏸ Pause';
    btnPauseResume.className   = 'btn-ctrl btn-yellow';
    isPaused = false;
  }
}

// ── Socket events ─────────────────────────────────────────────

socket.on('host:room-created', ({ roomCode: code }) => {
  roomCode = code;
  lobbyRoomCode.textContent = code;
  topbarCode.textContent    = code;
  lobbyRoomInfo.style.display = 'block';
  btnCreateRoom.style.display = 'none';
});

socket.on('lobby:member-counts', (counts) => {
  if (!counts) return;
  const active = Object.entries(counts).filter(([, n]) => n > 0);
  lobbyGroupCount.textContent = active.length;
  lobbyGroupList.innerHTML = active.map(([g, n]) => `<li>${g} (${n}/4)</li>`).join('');
  btnStartGame.disabled = active.length < 1;
});

socket.on('game:started', () => {
  showScreen('game');
  questionPanel.style.display = 'none';
  itemPhaseBanner.style.display = 'none';
  btnSkipItems.style.display = 'none';
  btnNextQ.style.display     = 'none';
});

socket.on('question:shown', ({ number, total, text, options }) => {
  qCounter.textContent = `Câu ${number}/${total}`;
  qNumberBadge.textContent = `Câu ${number}`;
  qText.textContent = text;
  ['A','B','C','D'].forEach(l => {
    document.getElementById(`opt-${l}-text`).textContent = options[l];
    const card = document.getElementById(`opt-${l}`);
    card.classList.remove('correct','revealed');
  });
  timerMax = 20;
  setTimerUI(20, 20);
  answerCountBadge.textContent = '0 nhóm đã trả lời';
  questionPanel.style.display = 'block';
  itemPhaseBanner.style.display = 'none';
  setControlState('QUESTION');
});

socket.on('timer:tick', ({ remaining }) => {
  timerRemaining = remaining;
  setTimerUI(remaining, timerMax);
  if (gameState === 'ITEM_PHASE') {
    itemTimer.textContent = remaining;
  }
});

socket.on('timer:paused', ({ remaining }) => {
  timerRemaining = remaining;
  setTimerUI(remaining, timerMax);
  setControlState('PAUSED');
});

socket.on('timer:resumed', () => {
  setControlState('QUESTION');
});

socket.on('answers:count', ({ count }) => {
  answerCountBadge.textContent = `${count} nhóm đã trả lời`;
});

socket.on('answer:revealed', ({ correctAnswer, explanation, movements }) => {
  setControlState('REVEAL');
  btnReveal.style.display = 'none';
  btnPauseResume.style.display = 'none';

  // Highlight correct option
  ['A','B','C','D'].forEach(l => {
    const card = document.getElementById(`opt-${l}`);
    if (l === correctAnswer) card.classList.add('correct');
    else card.classList.add('revealed');
  });

  // Announce movements
  movements.forEach(m => {
    if (m.correct && m.stepsGained > 0) {
      toast(`✅ <strong>${m.groupName}</strong> đúng! +${m.stepsGained} bước${m.itemReceived ? ` + ${m.itemReceived.emoji} ${m.itemReceived.name}` : ''}`);
    } else if (m.correct && m.frozen) {
      toast(`❄️ <strong>${m.groupName}</strong> đúng nhưng đang bị đóng băng!`);
    }
  });

  if (explanation) {
    setTimeout(() => toast(`📖 ${explanation}`), 600);
  }
});

socket.on('ducks:updated', ({ positions }) => {
  updateDucks(positions);
});

socket.on('item-phase:started', ({ timeLimit }) => {
  setControlState('ITEM_PHASE');
  btnReveal.style.display = 'none';
  btnPauseResume.style.display = 'none';
  timerMax = timeLimit;
  itemPhaseBanner.style.display = 'flex';
  itemTimer.textContent = timeLimit;
});

socket.on('item:used', ({ byGroup, itemEmoji, itemName, targetGroup, effect }) => {
  const self = targetGroup === byGroup;
  const msg  = self
    ? `${itemEmoji} <strong>${byGroup}</strong> dùng ${itemName}! ${effect}`
    : `${itemEmoji} <strong>${byGroup}</strong> quăng ${itemName} vào <strong>${targetGroup}</strong>! ${effect}`;
  toast(msg);

  // Track frozen visually
  if (itemName === 'Freeze') frozenGroups.add(targetGroup);
});

socket.on('item-phase:ended', () => {
  itemPhaseBanner.style.display = 'none';
  frozenGroups.clear();
  setControlState('BETWEEN_ROUNDS');
});

socket.on('game:over', ({ rankings }) => {
  finalRankings.innerHTML = rankings.map((r, i) => `
    <li>
      <span class="rank-medal">${MEDALS[i] || (i+1)+'.'}</span>
      <span>${r.group}</span>
      <span class="rank-steps">${r.steps} bước</span>
    </li>
  `).join('');
  setTimeout(() => showScreen('gameover'), 1200);
});

socket.on('host:disconnected', () => {
  alert('Kết nối bị gián đoạn!');
});

// ── Button handlers ───────────────────────────────────────────
btnCreateRoom.addEventListener('click', () => {
  socket.emit('host:create-room');
});

btnStartGame.addEventListener('click', () => {
  socket.emit('host:start-game');
  btnStartGame.disabled = true;
});

btnPauseResume.addEventListener('click', () => {
  if (isPaused) socket.emit('host:resume-timer');
  else          socket.emit('host:pause-timer');
});

btnReveal.addEventListener('click', () => {
  socket.emit('host:reveal-answer');
});

btnSkipItems.addEventListener('click', () => {
  socket.emit('host:skip-item-phase');
});

btnNextQ.addEventListener('click', () => {
  socket.emit('host:next-question');
  btnNextQ.style.display = 'none';
});

btnEndGame.addEventListener('click', () => {
  if (confirm('Kết thúc game ngay bây giờ?')) {
    socket.emit('host:end-game');
  }
});

btnRestart.addEventListener('click', () => {
  location.reload();
});
