const socket = io();

// ── State ────────────────────────────────────────────────────
let roomCode       = '';
let gameState      = 'LOBBY';
let totalSteps     = {};
let timerMax       = 20;
let timerRemaining = 20;
let isPaused       = false;
let frozenGroups   = new Set();

const GROUPS = ['Nhóm 1', 'Nhóm 2', 'Nhóm 3', 'Nhóm 5', 'Nhóm 6', 'Nhóm 7', 'Giảng Viên'];
const DUCK_EMOJIS = {
  'Nhóm 1': '🦆', 'Nhóm 2': '🐤', 'Nhóm 3': '🦜',
  'Nhóm 5': '🐧', 'Nhóm 6': '🦩', 'Nhóm 7': '🦚', 'Giảng Viên': '👨‍🏫'
};
const MEDALS = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣'];

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
function buildTrack(activeGroups) {
  const groupList = activeGroups || GROUPS;
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

  const CHARACTER_IMAGES = {
    'Nhóm 1': 'assets/aot.png',
    'Nhóm 2': 'assets/kimet.png',
    'Nhóm 3': 'assets/naruto.png',
    'Nhóm 5': 'assets/senku.png',
    'Nhóm 6': 'assets/songoku.png',
    'Nhóm 7': 'assets/duck.png',
    'Giảng Viên': 'assets/duck.png'
  };

  groupList.forEach((group, index) => {
    totalSteps[group] = 0;
    // Spread ducks evenly across the vertical track area
    const verticalOffset = groupList.length === 1
      ? 50
      : 24 + (index * (68 / (groupList.length - 1))) + (Math.random() * 4 - 2);

    const duckData = document.createElement('div');
    duckData.className = 'duck';
    duckData.id = `duck-${group.replace(' ','')}`;
    duckData.style.left = '5%';
    duckData.style.top = verticalOffset + '%';
    duckData.style.zIndex = 10 + index;

    const charImg = CHARACTER_IMAGES[group] || 'assets/duck.png';

    duckData.innerHTML = `
      <img src="${charImg}" alt="${group}">
      <div class="duck-name-tag">${group}</div>
      <span class="duck-steps" id="steps-${group.replace(' ','')}">0</span>
    `;
    raceTrack.appendChild(duckData);
  });
}
buildTrack();

// ── Duck position ─────────────────────────────────────────────
// Absolute scale: max possible = 25pts * 25q = 625
const MAX_TOTAL_SCORE = 25 * 25;
function duckLeft(steps) {
  return (5 + (steps / MAX_TOTAL_SCORE) * 88) + '%';
}

function updateDucks(positions) {
  let leaderSteps = 0;
  let leaderGroup = '';

  for (const [group, steps] of Object.entries(positions)) {
    totalSteps[group] = steps;
    if (steps > leaderSteps) { leaderSteps = steps; leaderGroup = group; }
  }

  for (const [group, steps] of Object.entries(positions)) {
    const key = group.replace(' ','');
    const duckEl  = document.getElementById(`duck-${key}`);
    const stepsEl = document.getElementById(`steps-${key}`);

    if (duckEl) {
      duckEl.style.left = duckLeft(steps);
      duckEl.classList.toggle('frozen', frozenGroups.has(group));
      duckEl.classList.remove('leader');
    }
    if (stepsEl) stepsEl.textContent = typeof steps === 'number' ? steps.toFixed(1) : steps;
  }

  if (leaderSteps > 0) {
    const leaderDuck = document.getElementById(`duck-${leaderGroup.replace(' ','')}`);
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
  
  let color = '#2ecc71';
  let glow = 'rgba(46, 204, 113, 0.5)';
  
  if (pct <= 25) {
    color = '#e74c3c';
    glow = 'rgba(231, 76, 60, 0.5)';
  } else if (pct <= 50) {
    color = '#f1c40f';
    glow = 'rgba(241, 196, 15, 0.5)';
  }
  
  timerBar.style.background = color;
  timerBar.style.boxShadow  = `0 0 12px ${glow}`;
}

// ── Toast ─────────────────────────────────────────────────────
function toast(html) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = html;
  toastContainer.appendChild(el);
  setTimeout(() => el.remove(), 4100);
}

// ── Projectile Animation ─────────────────────────────────────
function animateProjectile(fromGroup, targetGroup, itemEmoji) {
  if (fromGroup === targetGroup || fromGroup === 'Dev') return;

  const fromEl = document.getElementById('duck-' + fromGroup.replace(' ', ''));
  const targetEl = document.getElementById('duck-' + targetGroup.replace(' ', ''));

  if (!fromEl || !targetEl) return;

  const fromRect = fromEl.getBoundingClientRect();
  const targetRect = targetEl.getBoundingClientRect();

  const projectile = document.createElement('div');
  projectile.className = 'projectile';
  projectile.textContent = itemEmoji;

  // Center points
  const startX = fromRect.left + fromRect.width / 2;
  const startY = fromRect.top + fromRect.height / 2;
  const endX = targetRect.left + targetRect.width / 2;
  const endY = targetRect.top + targetRect.height / 2;

  projectile.style.left = `${startX}px`;
  projectile.style.top = `${startY}px`;
  projectile.style.transform = 'translate(-50%, -50%)';
  document.body.appendChild(projectile);

  const duration = 1000;
  const startTime = performance.now();
  const arcHeight = -150;

  function update(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);

    const curX = startX + (endX - startX) * progress;
    const curY = startY + (endY - startY) * progress + Math.sin(progress * Math.PI) * arcHeight;

    // Rotate as it flies
    const rotation = progress * 720;
    const scale = 1 + Math.sin(progress * Math.PI) * 0.8;

    projectile.style.left = `${curX}px`;
    projectile.style.top = `${curY}px`;
    projectile.style.transform = `translate(-50%, -50%) rotate(${rotation}deg) scale(${scale})`;

    if (progress < 1) {
      requestAnimationFrame(update);
    } else {
      projectile.remove();
      // On impact
      targetEl.classList.add('shake');
      setTimeout(() => targetEl.classList.remove('shake'), 600);
      
      // Explosion effect at impact
      createExplosion(endX, endY);
    }
  }
  requestAnimationFrame(update);
}

function createExplosion(x, y) {
  const container = document.createElement('div');
  container.className = 'explosion';
  container.style.left = `${x}px`;
  container.style.top = `${y}px`;
  document.body.appendChild(container);

  for (let i = 0; i < 8; i++) {
    const spark = document.createElement('div');
    spark.className = 'spark';
    const angle = (i / 8) * Math.PI * 2;
    const dist = 40 + Math.random() * 40;
    spark.style.setProperty('--tx', `${Math.cos(angle) * dist}px`);
    spark.style.setProperty('--ty', `${Math.sin(angle) * dist}px`);
    spark.style.background = `hsl(${Math.random() * 60 + 20}, 100%, 60%)`;
    container.appendChild(spark);
  }

  setTimeout(() => container.remove(), 1000);
}

// ── Controls state ────────────────────────────────────────────
function setControlState(state) {
  gameState = state;
  btnReveal.style.display      = (state === 'QUESTION' || state === 'PAUSED') ? '' : 'none';
  btnPauseResume.style.display = (state === 'QUESTION' || state === 'PAUSED') ? '' : 'none';
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
  lobbyGroupList.innerHTML = active.map(([g, n]) => {
    const max = g === 'Giảng Viên' ? 1 : 4;
    return `<li>${g} (${n}/${max})</li>`;
  }).join('');
  btnStartGame.disabled = active.length < 1;
});

socket.on('game:started', ({ activeGroups } = {}) => {
  // Rebuild track with only groups that have members
  if (activeGroups && activeGroups.length > 0) buildTrack(activeGroups);
  showScreen('game');
  questionPanel.style.display = 'none';
  itemPhaseBanner.style.display = 'none';
  btnNextQ.style.display = 'none';
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
  timerMax = 25;
  setTimerUI(25, 25);
  answerCountBadge.textContent = '0 nhóm đã trả lời';
  questionPanel.style.display = 'block';
  itemPhaseBanner.style.display = 'none';
  setControlState('QUESTION');
});

socket.on('timer:tick', ({ remaining }) => {
  timerRemaining = remaining;
  setTimerUI(remaining, timerMax);
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

  ['A','B','C','D'].forEach(l => {
    const card = document.getElementById(`opt-${l}`);
    if (l === correctAnswer) card.classList.add('correct');
    else card.classList.add('revealed');
  });

  movements.forEach(m => {
    if (m.correct && m.stepsGained > 0) {
      const pts = typeof m.stepsGained === 'number' ? m.stepsGained.toFixed(2) : m.stepsGained;
      toast(`✅ <strong>${m.groupName}</strong> đúng! +${pts} điểm${m.itemReceived ? ` + ${m.itemReceived.emoji} ${m.itemReceived.name}` : ''}`);
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

socket.on('round:between', ({ autoAdvanceIn, isLast } = {}) => {
  itemPhaseBanner.style.display = 'none';
  if (isLast) {
    btnNextQ.style.display = 'none';
    setControlState('BETWEEN_ROUNDS');
  } else {
    setControlState('BETWEEN_ROUNDS');
    btnNextQ.textContent = `▶ Câu Tiếp (${autoAdvanceIn}s)`;
  }
});

socket.on('between:countdown', ({ remaining }) => {
  if (remaining > 0) {
    btnNextQ.textContent = `▶ Câu Tiếp (${remaining}s)`;
  } else {
    btnNextQ.textContent = '▶ Câu Tiếp';
  }
});

socket.on('item:gained', ({ groupName, item }) => {
  toast(`🎁 <strong>${groupName}</strong> đạt mốc — nhận ${item.emoji} ${item.name}!`);
});

socket.on('item:used', ({ byGroup, itemEmoji, itemName, targetGroup, effect, shake }) => {
  const self = targetGroup === byGroup;
  const msg  = self
    ? `${itemEmoji} <strong>${byGroup}</strong> dùng ${itemName}! ${effect}`
    : `${itemEmoji} <strong>${byGroup}</strong> quăng ${itemName} vào <strong>${targetGroup}</strong>! ${effect}`;
  toast(msg);

  // Projectile animation if target is different
  if (targetGroup && byGroup !== targetGroup) {
    animateProjectile(byGroup, targetGroup, itemEmoji);
  } else {
    // Duck shake (immediate if same group or no animation)
    if (shake) {
      const duckEl = document.getElementById('duck-' + shake.replace(' ',''));
      if (duckEl) {
        duckEl.classList.add('shake');
        setTimeout(() => duckEl.classList.remove('shake'), 600);
      }
    }
  }
  // Shield aura
  if (itemName === 'Khiên') {
    const duckEl = document.getElementById('duck-' + byGroup.replace(' ',''));
    if (duckEl) {
      duckEl.classList.add('shielded');
      setTimeout(() => duckEl.classList.remove('shielded'), 5000);
    }
  }
});

socket.on('game:over', ({ rankings }) => {
  finalRankings.innerHTML = rankings.map((r, i) => `
    <li>
      <span class="rank-medal">${MEDALS[i] || (i+1)+'.'}</span>
      <span>${r.group}</span>
      <span class="rank-steps">${typeof r.steps === 'number' ? r.steps.toFixed(1) : r.steps} điểm</span>
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

// ── DEV TOOL PANEL ────────────────────────────────────────────
(function initDevPanel() {
  const devPanel   = $('dev-panel');
  const devLog     = $('dev-log');
  if (!devPanel) return;

  // Ctrl + Alt + D to toggle
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.altKey && (e.key === 'd' || e.key === 'D')) {
      e.preventDefault();
      devPanel.style.display = devPanel.style.display === 'none' ? 'flex' : 'none';
    }
  });

  // Populate group selects
  ['dev-give-group', 'dev-score-group', 'dev-ans-group', 'dev-from-group', 'dev-to-group'].forEach(id => {
    const sel = $(id);
    if (!sel) return;
    GROUPS.forEach(g => {
      const opt = document.createElement('option');
      opt.value = g;
      opt.textContent = g;
      sel.appendChild(opt);
    });
  });

  function logDev(msg) {
    const line = document.createElement('div');
    line.textContent = new Date().toLocaleTimeString('vi-VN') + ' ' + msg;
    devLog.prepend(line);
    if (devLog.children.length > 30) devLog.lastChild.remove();
  }

  socket.on('dev:log', ({ msg }) => logDev(msg));

  $('dev-btn-give').addEventListener('click', () => {
    socket.emit('dev:give-item', {
      groupName: $('dev-give-group').value,
      itemId:    $('dev-give-item').value,
    });
  });

  $('dev-btn-add').addEventListener('click', () => {
    socket.emit('dev:adjust-score', {
      groupName: $('dev-score-group').value,
      delta:     +$('dev-score-delta').value,
    });
  });

  $('dev-btn-sub').addEventListener('click', () => {
    socket.emit('dev:adjust-score', {
      groupName: $('dev-score-group').value,
      delta:     -$('dev-score-delta').value,
    });
  });

  $('dev-btn-set').addEventListener('click', () => {
    socket.emit('dev:set-score', {
      groupName: $('dev-score-group').value,
      value:     +$('dev-score-delta').value,
    });
  });

  $('dev-btn-submit-ans').addEventListener('click', () => {
    socket.emit('dev:submit-answer', {
      groupName: $('dev-ans-group').value,
      answer:    $('dev-ans-choice').value,
    });
  });

  $('dev-btn-correct-ans').addEventListener('click', () => {
    socket.emit('dev:submit-correct', { groupName: $('dev-ans-group').value });
  });

  $('dev-btn-reveal').addEventListener('click', () => {
    socket.emit('dev:reveal');
  });

  $('dev-btn-next-q').addEventListener('click', () => {
    socket.emit('dev:next-question');
  });

  $('dev-btn-all-correct').addEventListener('click', () => {
    GROUPS.forEach(g => socket.emit('dev:submit-correct', { groupName: g }));
    logDev('Sent correct answer for all groups');
  });

  $('dev-btn-use-effect').addEventListener('click', () => {
    socket.emit('dev:apply-item', {
      fromGroup:   $('dev-from-group').value,
      itemId:      $('dev-effect-item').value,
      targetGroup: $('dev-to-group').value,
    });
  });
})();
