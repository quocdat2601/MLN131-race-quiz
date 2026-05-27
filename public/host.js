const socket = io();

// ── State ────────────────────────────────────────────────────
let roomCode       = '';
let gameState      = 'LOBBY';
let totalSteps     = {};
let timerMax       = 30;
let timerRemaining = 30;
let isPaused       = false;
let frozenGroups   = new Set();
let currentWeatherEvent = null;

const GROUPS = ['Nhóm 1', 'Nhóm 2', 'Nhóm 4', 'Nhóm 5', 'Nhóm 6', 'Giảng Viên'];
const DUCK_EMOJIS = {
  'Nhóm 1': '🦆', 'Nhóm 2': '🐤', 'Nhóm 4': '🦜',
  'Nhóm 5': '🐧', 'Nhóm 6': '🦩', 'Giảng Viên': '👨‍🏫'
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
  // Preserve these elements before wiping innerHTML
  const startLine = raceTrack.querySelector('.start-line');
  const weatherLayer = document.getElementById('weather-layer');
  raceTrack.innerHTML = '';
  // Weather-layer must be first child (sibling selector ~ .duck depends on it)
  if (weatherLayer) raceTrack.appendChild(weatherLayer);
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

  // Distance marker lines (every 100pts, z-index below ducks)
  [100, 200, 300, 400, 500, 600].forEach(pts => {
    const marker = document.createElement('div');
    marker.className = 'track-marker';
    marker.style.left = milestoneLeft(pts);
    marker.innerHTML = `<span class="track-marker-label">${pts}m</span>`;
    raceTrack.appendChild(marker);
  });

  const CHARACTER_IMAGES = {
    'Nhóm 1': 'assets/aot.png',
    'Nhóm 2': 'assets/kimet.png',
    'Nhóm 4': 'assets/naruto.png',
    'Nhóm 5': 'assets/senku.png',
    'Nhóm 6': 'assets/songoku.png',
    'Giảng Viên': "assets/trilm's duck.png"
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
    duckData.style.zIndex = 5;

    const charImg = CHARACTER_IMAGES[group] || 'assets/duck.png';

    duckData.innerHTML = `
      <div class="duck-wrapper">
        <img src="${charImg}" alt="${group}">
        <div class="shield-aura"></div>
      </div>
      <div class="duck-name-tag">${group} <span class="duck-steps-inline" id="steps-${group.replace(' ','')}">0</span></div>
    `;
    raceTrack.appendChild(duckData);

    // Milestone boxes for this duck's lane (same z-index layer as duck, above background)
    MILESTONES_DISPLAY.forEach((pts, mIdx) => {
      const box = document.createElement('div');
      box.className = 'milestone-box';
      box.id = `mbox-${group.replace(' ', '')}-${mIdx}`;
      box.style.left = milestoneLeft(pts);
      box.style.top = verticalOffset + '%';
      box.innerHTML = `<img src="assets/randombox.png" alt="?">`;
      raceTrack.appendChild(box);
    });
  });
}

// ── Duck position ─────────────────────────────────────────────
// Absolute scale: max possible = 30pts * 30q = 900
const MAX_TOTAL_SCORE = 30 * 30;
const MILESTONES_DISPLAY = [100, 200, 300, 400, 500, 600];
function duckLeft(steps) {
  return (5 + (steps / MAX_TOTAL_SCORE) * 88) + '%';
}
function milestoneLeft(pts) {
  return (5 + (pts / MAX_TOTAL_SCORE) * 88) + '%';
}

buildTrack();

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
      duckEl.style.zIndex = 5;
      duckEl.classList.toggle('frozen', frozenGroups.has(group));
      duckEl.classList.remove('leader');
    }
    if (stepsEl) stepsEl.textContent = typeof steps === 'number' ? steps.toFixed(1) : steps;

    // Hide milestone boxes already passed (safety net in case milestone:reached missed)
    MILESTONES_DISPLAY.forEach((pts, mIdx) => {
      if (steps >= pts) {
        const box = document.getElementById(`mbox-${group.replace(' ', '')}-${mIdx}`);
        if (box && !box.classList.contains('collected')) box.classList.add('collected');
      }
    });
  }

  if (leaderSteps > 0) {
    const leaderDuck = document.getElementById(`duck-${leaderGroup.replace(' ','')}`);
    if (leaderDuck) { leaderDuck.classList.add('leader'); leaderDuck.style.zIndex = 10; }
  }
}
// ── Weather layer ──────────────────────────────────────────────
function applyWeatherEffect(event) {
  const layer = $('weather-layer');
  if (!layer) return;
  layer.className = 'weather-layer';
  // Remove golden glow from all ducks
  document.querySelectorAll('.duck').forEach(d => d.classList.remove('duck-golden'));
  if (!event) { layer.style.display = 'none'; return; }
  layer.style.display = '';
  layer.classList.add(event);
  // Apply golden glow to ducks during golden event
  if (event === 'golden') {
    document.querySelectorAll('.duck').forEach(d => d.classList.add('duck-golden'));
  }
}

const EVENT_BANNER_DATA = {
  storm:  { icon: '🌊', title: 'Bão Tố',       desc: 'Thời gian bị rút ngắn chỉ còn 10 giây!',   cls: 'banner-storm'  },
  fog:    { icon: '🌫️', title: 'Sương Mù',      desc: 'Đường đua bị che khuất trong 60 giây!',     cls: 'banner-fog'    },
  golden: { icon: '✨', title: 'Thời Cơ Vàng',  desc: 'Điểm thưởng nhân đôi (X2) trong 60 giây!', cls: 'banner-golden' },
};

function showEventBanner(event, remaining, duration) {
  const banner = $('global-event-banner');
  if (!banner) return;

  const svg = banner.querySelector('.ge-border-svg');
  const track = banner.querySelector('.ge-border-track');
  const fill = document.getElementById('ge-border-fill');

  // Nếu không có event -> Ẩn banner và reset viền
  if (!event || !EVENT_BANNER_DATA[event]) {
    banner.classList.add('hidden');
    if (fill) {
      fill.style.transition = 'none';
      fill.style.strokeDashoffset = '0';
    }
    return;
  }

  // Set thông tin event
  const d = EVENT_BANNER_DATA[event];
  $('ge-icon').textContent  = d.icon;
  $('ge-title').textContent = d.title;
  $('ge-desc').textContent  = d.desc;
  banner.className = 'event-banner ' + d.cls; // Bỏ class 'hidden' để hiện banner

  // Dùng requestAnimationFrame để đợi DOM vẽ xong banner, lấy kích thước chính xác
  requestAnimationFrame(() => {
    if (!fill || !track || !svg) return;

    // 1. Lấy kích thước thật của banner (px)
    const w = banner.clientWidth;
    const h = banner.clientHeight;
    const r = 8; // Bán kính góc bo tròn (rx=8)

    // 2. Ép SVG và thẻ rect vừa khít với kích thước thật
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    track.setAttribute('width', w - 2);
    track.setAttribute('height', h - 2);
    fill.setAttribute('width', w - 2);
    fill.setAttribute('height', h - 2);

    // 3. Tính chu vi chính xác: 2*(W+H) - 8r + 2πr
    const perimeter = 2 * (w - 2) + 2 * (h - 2) - (8 * r) + (2 * Math.PI * r);

    fill.style.strokeDasharray = perimeter;

    // 4. Kích hoạt animation
    if (duration > 0 && remaining > 0) {
      const startOffset = perimeter * (1 - remaining / duration);
      fill.style.transition = 'none';
      fill.style.strokeDashoffset = String(startOffset);
      void fill.getBoundingClientRect();
      fill.style.transition = `stroke-dashoffset ${remaining}s linear`;
      fill.style.strokeDashoffset = String(perimeter);
    } else {
      fill.style.transition = 'none';
      fill.style.strokeDashoffset = '0';
    }
  });
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
  
  const ITEM_IMAGES = {
    '🦑': 'assets/blooper.png',
    '🍌': 'assets/banana.png',
    '🧊': 'assets/ice.png',
    '🪨': 'assets/rockk.png',
    '🧱': 'assets/rockk.png',
    '🪞': 'assets/Mirror.png',
    '🙃': 'assets/Mirror.png',
    '🛡️': 'assets/shield.png'
  };

  const imgSrc = ITEM_IMAGES[itemEmoji];
  const size = (itemEmoji === '🪞' || itemEmoji === '🙃') ? 90 : 70;
  if (imgSrc) {
    projectile.innerHTML = `<img src="${imgSrc}" style="width: ${size}px; height: ${size}px; object-fit: contain;">`;
  } else {
    projectile.textContent = itemEmoji;
  }

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

    // Custom rotations per item
    let rotation = progress * 720;
    if (itemEmoji === '🍌') rotation = progress * 1440; // Spinning banana
    if (itemEmoji === '🧲') {
       // Magnet doesn't rotate, it faces target
       rotation = 0;
    }

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

      // Apply persisting effects on impact
      if (itemEmoji === '🧊') {
        targetEl.classList.add('state-frozen');
        setTimeout(() => targetEl.classList.remove('state-frozen'), 5000);
      } else if (itemEmoji === '🪞' || itemEmoji === '🙃') {
        targetEl.classList.add('state-mirrored');
        setTimeout(() => targetEl.classList.remove('state-mirrored'), 7000);
      } else if (itemEmoji === '🦑') {
        targetEl.classList.add('state-bloopered');
        setTimeout(() => targetEl.classList.remove('state-bloopered'), 4000);
      }
      
      // Specific explosion colors
      let explosionColor = null;
      if (itemEmoji === '🦑') explosionColor = '#000'; // Ink
      if (itemEmoji === '🍌') explosionColor = '#ffdb58'; // Yellow
      if (itemEmoji === '🪨' || itemEmoji === '🧱') explosionColor = '#aaa'; // Stone
      
      createExplosion(endX, endY, explosionColor);
    }
  }
  requestAnimationFrame(update);
}

function createExplosion(x, y, customColor) {
  const container = document.createElement('div');
  container.className = 'explosion';
  container.style.left = `${x}px`;
  container.style.top = `${y}px`;
  document.body.appendChild(container);

  for (let i = 0; i < 12; i++) {
    const spark = document.createElement('div');
    spark.className = 'spark';
    const angle = (i / 12) * Math.PI * 2;
    const dist = 40 + Math.random() * 60;
    spark.style.setProperty('--tx', `${Math.cos(angle) * dist}px`);
    spark.style.setProperty('--ty', `${Math.sin(angle) * dist}px`);
    spark.style.background = customColor || `hsl(${Math.random() * 60 + 20}, 100%, 60%)`;
    if (customColor === '#000') {
      spark.style.width = spark.style.height = (Math.random() * 12 + 6) + 'px';
      spark.style.borderRadius = '40% 60% 50% 50%'; // Inky drops
    }
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

socket.on('question:shown', ({ number, total, text, options, timeLimit, event, eventDuration, eventRemaining }) => {
  qCounter.textContent = `Câu ${number}/${total}`;
  qNumberBadge.textContent = `Câu ${number}`;
  qText.textContent = text;
  ['A','B','C','D'].forEach(l => {
    document.getElementById(`opt-${l}-text`).textContent = options[l];
    const card = document.getElementById(`opt-${l}`);
    card.classList.remove('correct','revealed');
  });
  timerMax = timeLimit || 30;
  setTimerUI(timerMax, timerMax);
  answerCountBadge.textContent = '0 nhóm đã trả lời';
  questionPanel.style.display = 'block';
  itemPhaseBanner.style.display = 'none';
  setControlState('QUESTION');
  // Apply weather effect for this question
  currentWeatherEvent = event || null;
  applyWeatherEffect(currentWeatherEvent);
  showEventBanner(currentWeatherEvent, eventRemaining || 0, eventDuration || 0);
});

socket.on('timer:tick', ({ remaining }) => {
  timerRemaining = remaining;
  setTimerUI(remaining, timerMax);
});

socket.on('timer:sync', ({ remaining, max }) => {
  timerMax = max;
  timerRemaining = remaining;
  setTimerUI(remaining, max);
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
  showEventBanner(null);

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
    // explanation removed
  }
});

socket.on('ducks:updated', ({ positions }) => {
  updateDucks(positions);
});

socket.on('global:event', ({ event, eventDuration, eventRemaining }) => {
  currentWeatherEvent = event || null;
  applyWeatherEffect(currentWeatherEvent);
  showEventBanner(currentWeatherEvent, eventRemaining || 0, eventDuration || 0);
  const labels = { storm: '🌊 Bão Tố!', fog: '🌫️ Sương Mù!', golden: '✨ Thời Cơ Vàng! x2 điểm!' };
  if (event && labels[event]) toast(labels[event]);
});

socket.on('round:between', ({ autoAdvanceIn, isLast } = {}) => {
  itemPhaseBanner.style.display = 'none';
  applyWeatherEffect(null);
  showEventBanner(null);
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

socket.on('milestone:reached', ({ groupName, milestoneIndex, item }) => {
  // Pop the milestone box visually
  const box = document.getElementById(`mbox-${groupName.replace(' ', '')}-${milestoneIndex}`);
  if (box && !box.classList.contains('collected')) {
    box.classList.add('collected');
    setTimeout(() => box.remove(), 500);
  }
  const MILESTONE_PTS = ['50', '100', '150', '200', '250'];
  toast(`🎁 <strong>${groupName}</strong> đạt mốc ${MILESTONE_PTS[milestoneIndex]} điểm! Nhận ${item.emoji} ${item.name}!`);
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
    // Duck visual impact
    if (targetGroup) {
      const duckEl = document.getElementById('duck-' + targetGroup.replace(' ',''));
      if (duckEl) {
        if (itemName === 'Băng Giá') {
          duckEl.classList.add('state-frozen');
          setTimeout(() => duckEl.classList.remove('state-frozen'), 5000);
        } else if (itemName === 'Gương Thần') {
          duckEl.classList.add('state-mirrored');
          setTimeout(() => duckEl.classList.remove('state-mirrored'), 7000);
        } else if (itemName === 'Mực Che Mắt') {
          duckEl.classList.add('state-bloopered');
          setTimeout(() => duckEl.classList.remove('state-bloopered'), 4000);
        } else {
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

  // Global event buttons
  ['storm', 'fog', 'golden', 'clear-event'].forEach(id => {
    const btn = $('dev-btn-' + id);
    if (!btn) return;
    btn.addEventListener('click', () => {
      const event = id === 'clear-event' ? 'clear' : id;
      socket.emit('dev:trigger-event', { event });
    });
  });
})();
