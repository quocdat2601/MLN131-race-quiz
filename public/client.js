const socket = io();

// ── State ────────────────────────────────────────────────────
let myGroup           = '';
let myScore           = 0;        // running total score
let selectedGroup     = '';      // chosen group before joining
let mySubmittedAnswer = null;    // tracks which answer this client submitted
let inventory         = [];      // Array of item objects
let timerMax          = 30;
let gamePhase         = 'JOIN';  // JOIN | WAITING | QUESTION | ANSWERED | RESULT | BETWEEN | GAMEOVER
let isFrozen          = false;
let isButtonFrozen    = false;   // ice effect
let tapCount          = 0;
let lastTappedOption  = null;
let isBricked         = false;   // brick effect — local timer reduction


// Item-use selection state
let selectedItemId    = null;
let selectedItemType  = null;
let selectedTarget    = null;
let presentGroups     = [];   // groups currently joined in the room

const GROUPS = ['Nhóm 1', 'Nhóm 2', 'Nhóm 4', 'Nhóm 5', 'Nhóm 6', 'Giảng Viên'];
const MEDALS  = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣'];
const ITEM_IMAGE_MAP = {
  blooper: 'assets/blooper.png',
  banana:  'assets/banana.png',
  ice:     'assets/ice.png',
  brick:   'assets/rockk.png',
  mirror:  'assets/Mirror.png',
  shield:  'assets/shield.png'
};

const CHARACTER_IMAGES = {
  'Nhóm 1': 'assets/aot.png',
  'Nhóm 2': 'assets/kimet.png',
  'Nhóm 4': 'assets/naruto.png',
  'Nhóm 5': 'assets/senku.png',
  'Nhóm 6': 'assets/songoku.png',
  'Giảng Viên': "assets/trilm's duck.png"
};



// ── DOM helpers ───────────────────────────────────────────────
function $(id)       { return document.getElementById(id); }
function show(id)    { const e = $(id); if(e) e.style.display = ''; }
function hide(id)    { const e = $(id); if(e) e.style.display = 'none'; }
function showToast(message) {
  const container = $('client-toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'client-toast';
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function updatePlayerBadge() {
  const badge = $('player-badge');
  const nameEl = $('badge-group-name');
  const scoreEl = $('badge-score');
  if (!badge || !nameEl || !scoreEl) return;
  if (myGroup) {
    nameEl.textContent = myGroup;
    scoreEl.textContent = ` (${myScore.toFixed(1)}m)`;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}
const screens = {
  join:       $('screen-join'),
  waiting:    $('screen-waiting'),
  question:   $('screen-question'),
  answered:   $('screen-answered'),
  result:     $('screen-result'),
  between:    $('screen-between'),
  gameover:   $('screen-gameover'),
};

function showScreen(name) {
  Object.entries(screens).forEach(([k, el]) => {
    if (!el) return;
    el.classList.remove('active');
    el.style.display = 'none';
  });
  const target = screens[name];
  if (target) {
    target.style.display = 'flex';
    target.classList.add('active');
  }
  gamePhase = name;
}
showScreen('join');

// ── Timer UI ──────────────────────────────────────────────────
function setTimerUI(remaining, max) {
  const pct = (remaining / max) * 100;
  const bar = $('client-timer-bar');
  const txt = $('client-timer-text');
  if (bar) {
    bar.style.width = pct + '%';
    bar.style.background = pct > 50 ? '#27ae60' : pct > 25 ? '#e6b800' : '#c0392b';
  }
  if (txt) txt.textContent = remaining;
}

// ── Inventory UI ──────────────────────────────────────────────
function renderInventory() {
  const list     = $('inventory-list');
  const noItems  = $('no-items-msg');
  const between  = $('between-inventory');
  const invCount = $('inv-count');

  if (invCount) invCount.textContent = inventory.length;

  if (list) {
    if (inventory.length === 0) {
      list.innerHTML = '';
      if (noItems) noItems.style.display = '';
    } else {
      if (noItems) noItems.style.display = 'none';
      list.innerHTML = inventory.map(item => `
        <div class="item-chip" data-item-id="${item.id}" data-item-type="${item.type}">
          <img src="${ITEM_IMAGE_MAP[item.id] || ''}" class="chip-icon"> ${item.name}
        </div>
      `).join('');
      list.querySelectorAll('.item-chip').forEach(chip => {
        chip.addEventListener('click', () => selectItem(chip.dataset.itemId, chip.dataset.itemType));
      });
    }
  }

  if (between) {
    between.innerHTML = inventory.length > 0
      ? `<div class="mini-inventory">${inventory.map(i => `<span class="mini-chip"><img src="${ITEM_IMAGE_MAP[i.id] || ''}" class="mini-icon"> ${i.name}</span>`).join('')}</div>`
      : '';
  }
}

function selectItem(itemId, itemType) {
  selectedItemId   = itemId;
  selectedItemType = itemType;
  selectedTarget   = null;

  // Highlight selected
  document.querySelectorAll('.item-chip').forEach(c => {
    c.classList.toggle('selected', c.dataset.itemId === itemId);
  });

  const item     = inventory.find(i => i.id === itemId);
  const panel    = $('use-item-panel');
  const title    = $('use-item-title');
  const picker   = $('target-picker');
  const targetList = $('target-list');
  const btnConfirm = $('btn-confirm-use');

  if (!panel || !title) return;

  panel.style.display = 'flex';
  title.innerHTML   = `
    <img src="${ITEM_IMAGE_MAP[item.id] || ''}" class="title-icon">
    <span>${item.name}: ${itemDescription(item.id)}</span>
  `;

  if (itemType === 'offensive') {
    picker.style.display = 'flex';
    const otherGroups = (presentGroups.length > 0 ? presentGroups : GROUPS).filter(g => g !== myGroup);
    targetList.innerHTML = otherGroups.map(g => `
      <button class="target-btn" data-group="${g}">${g}</button>
    `).join('');
    targetList.querySelectorAll('.target-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        targetList.querySelectorAll('.target-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        selectedTarget = btn.dataset.group;
        btnConfirm.style.display = '';
      });
    });
    btnConfirm.style.display = 'none'; // show after picking target
  } else {
    picker.style.display = 'none';
    btnConfirm.style.display = '';
  }
}

function itemDescription(id) {
  const desc = {
    blooper: 'Ẩn toàn bộ nội dung câu trả lời, chỉ còn ký hiệu ABCD',
    banana:  'Đáp án bị xáo trộn ngẫu nhiên',
    brick:   'Câu tiếp điểm tối đa giảm 5',    
    ice:     'Nạn nhân phải bấm 5 lần mới chọn được đáp án',
    mirror:  'Lật ngược khu vực đáp án',
    shield:  'Chặn 1 đòn tấn công',
  };
  return desc[id] || '';
}

function resetItemPanel() {
  selectedItemId   = null;
  selectedItemType = null;
  selectedTarget   = null;
  const panel = $('use-item-panel');
  if (panel) panel.style.display = 'none';
  document.querySelectorAll('.item-chip').forEach(c => c.classList.remove('selected'));
}

// ── Socket events ─────────────────────────────────────────────
socket.on('lobby:member-counts', (counts) => {
  if (!counts) return;
  // Track which groups have at least 1 member present
  presentGroups = Object.entries(counts).filter(([, n]) => n > 0).map(([g]) => g);
  document.querySelectorAll('.group-btn').forEach(btn => {
    const g = btn.dataset.group;
    const n = counts[g] || 0;
    const maxSize = g === 'Giảng Viên' ? 1 : 4;
    const full = n >= maxSize;
    btn.querySelector('.member-count').textContent = `(${n}/${maxSize})`;
    btn.disabled = full;
    if (full && selectedGroup === g) {
      selectedGroup = '';
      btn.classList.remove('selected');
    }
  });
});

socket.on('join:success', ({ groupName }) => {
  myGroup = groupName;
  myScore = 0;
  updatePlayerBadge();
  if (peekInterval) { clearInterval(peekInterval); peekInterval = null; }
  $('waiting-group-name').textContent = groupName;
  
  // Set duck image for waiting screen
  const waitDuck = document.querySelector('#screen-waiting .duck-anim img');
  if (waitDuck) {
    waitDuck.src = CHARACTER_IMAGES[groupName] || 'assets/duck.png';
  }

  showScreen('waiting');
});

socket.on('join:error', ({ message }) => {
  const errEl = $('join-error');
  errEl.textContent  = message;
  errEl.style.display = '';
  $('btn-join').disabled = false;
});

socket.on('game:started', () => {
  showScreen('waiting');
  $('waiting-group-name').textContent = myGroup;
  const btn = $('btn-show-inventory');
  if (btn) btn.style.display = '';
});

socket.on('question:shown', ({ number, total, text, options, timeLimit, event, brickedGroups, brickedForThis }) => {
  $('client-q-badge').textContent   = `Câu ${number}/${total}`;
  $('client-q-text').textContent    = text;
  ['A','B','C','D'].forEach(l => {
    $(`client-opt-${l}`).textContent = options[l];
  });
  // Reset option styles
  document.querySelectorAll('.opt-btn').forEach(btn => {
    btn.classList.remove('selected','correct','wrong');
    btn.disabled = false;
  });
  mySubmittedAnswer = null;
  isButtonFrozen = false;
  isBricked = false;
  const timerWrapReset = $('client-timer-wrap');
  if (timerWrapReset) timerWrapReset.classList.remove('bricked');
  tapCount = 0;
  lastTappedOption = null;
  document.body.classList.remove('ice-active');
  // Remove any inline mirror transform and blooper
  const optCont = $('options-container');
  if (optCont) {
    optCont.style.transform = '';
    optCont.classList.remove('blooper-active');
  }

  timerMax = timeLimit || 25;

  // Check if this group is bricked this round (deferred brick applied server-side)
  if (brickedGroups && myGroup && brickedGroups.includes(myGroup)) {
    isBricked = true;
    const displayTime = Math.max(0, timerMax - 5);
    setTimerUI(displayTime, displayTime);
  } else {
    setTimerUI(timerMax, timerMax);
  }

  // Show global event banner
  handleGlobalEvent(event);

  showScreen('question');
});

socket.on('timer:tick', ({ remaining }) => {
  if (gamePhase === 'question') {
    if (isBricked) {
      const display = Math.max(0, remaining - 5);
      const brickedMax = Math.max(1, timerMax - 5);
      setTimerUI(display, brickedMax);
      if (display === 0 && !mySubmittedAnswer) {
        document.querySelectorAll('.opt-btn').forEach(b => { b.disabled = true; });
      }
    } else {
      setTimerUI(remaining, timerMax);
    }
  }
});

socket.on('team:locked', ({ answer }) => {
  // Lock buttons, keep question screen visible with blue highlight
  document.querySelectorAll('.opt-btn').forEach(btn => {
    btn.disabled = true;
    if (btn.dataset.answer === answer) btn.classList.add('selected');
  });
});

socket.on('answer:result', ({ correct, stepsGained, totalSteps, itemReceived }) => {
  // Sync score from server
  if (typeof totalSteps === 'number') {
    myScore = totalSteps;
    updatePlayerBadge();
  }
  if (itemReceived) showToast(`🎁 Nhận: ${itemReceived.emoji} ${itemReceived.name}`);
});

socket.on('answer:revealed', ({ correctAnswer }) => {
  // Highlight correct = green, locked wrong = red
  const lockedBtn = document.querySelector('.opt-btn.selected');
  const lockedAnswer = lockedBtn ? lockedBtn.dataset.answer : null;

  document.querySelectorAll('.opt-btn').forEach(btn => {
    const ans = btn.dataset.answer;
    btn.disabled = true;
    if (ans === correctAnswer) {
      btn.classList.remove('selected', 'wrong');
      btn.classList.add('correct');
    } else if (lockedAnswer && ans === lockedAnswer && ans !== correctAnswer) {
      btn.classList.remove('selected');
      btn.classList.add('wrong');
    }
  });
});

socket.on('inventory:update', ({ items }) => {
  inventory = items;
  renderInventory();
});

socket.on('round:between', () => {
  renderInventory();
  // Stay on question screen — next question will auto-arrive
});

// ── Global event handler (weather layer only, no banner) ──
function handleGlobalEvent(event) {
  const weather = $('weather-layer');
  if (!event) {
    if (weather) { weather.style.display = 'none'; weather.className = 'weather-layer'; }
    return;
  }
  if (weather) {
    weather.style.display = '';
    weather.className = 'weather-layer ' + event;
  }
}

socket.on('global:event', ({ event }) => {
  if (event === 'storm')       timerMax = 10;
  else if (event === 'fog')    timerMax = 60;
  else if (event === 'golden') timerMax = 60;
  handleGlobalEvent(event || null);
});

socket.on('timer:sync', ({ remaining, max }) => {
  timerMax = max;
  setTimerUI(remaining, max);
});

socket.on('effect:brick:immediate', ({ currentRemaining, timerMax: max }) => {
  isBricked = true;
  if (max) timerMax = max;
  const display = Math.max(0, currentRemaining - 5);
  const displayMax = Math.max(1, timerMax - 5);
  setTimerUI(display, displayMax);
  // Flash timer red to signal brick
  const wrap = $('client-timer-wrap');
  if (wrap) { wrap.classList.add('bricked'); }
});

socket.on('question:bricked', ({ displayTime }) => {
  isBricked = true;
  timerMax = displayTime + 5;
  setTimerUI(displayTime, displayTime);
});

socket.on('effect:blooper', () => {
  const container = $('options-container');
  if (container) container.classList.add('blooper-active');
  showToast('🦑 Mực Che Mắt! Đáp án bị ẩn — hãy nhìn lên màn hình host!');
});

socket.on('effect:banana', () => {
  const container = $('options-container');
  if (!container) return;
  const btns = [...container.querySelectorAll('.opt-btn')];
  // Shuffle order
  for (let i = btns.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    container.appendChild(btns[j]);
    btns.splice(j, 1);
  }
  showToast('🍌 Vỏ chuối! Đáp án bị xáo!');
});

socket.on('effect:shield-gained', () => {
  showToast('🛡️ Khiên hoạt động! Bạn được bảo vệ khỏi 1 đòn tấn công.');
});

socket.on('effect:mirror', () => {
  const container = $('options-container');
  if (container) container.style.transform = 'rotate(180deg)';
  showToast('🙃 Gương Thần! Đáp án bị lật ngược!');
  setTimeout(() => {
    if (container) container.style.transform = '';
  }, 10000);
});

socket.on('effect:ice', () => {
  isButtonFrozen = true;
  document.body.classList.add('ice-active');
  showToast('🧊 Băng Giá! Phải bấm 5 lần vào 1 đáp án mới gửi được!');
});

socket.on('game:penalty', ({ seconds }) => {
  // Legacy handler — no-op, replaced by question:bricked
});

socket.on('answer:error', ({ message }) => {
  showToast(`⚠️ ${message}`);
  // If they were trying to submit, unlock buttons so they know they failed? 
  // Or just keep locked if it's already over.
});

socket.on('shield:blocked', () => {
  showToast('🛡️ Khiên đã chặn một đòn tấn công!');
});

socket.on('item:error', ({ message }) => {
  alert(message);
});

socket.on('game:over', ({ rankings }) => {
  const list = $('client-rankings');
  list.innerHTML = rankings.map((r, i) => `
    <li>
      <span>${MEDALS[i] || (i+1)+'.'}  ${r.group}</span>
      <span class="cr-steps">${typeof r.steps === 'number' ? r.steps.toFixed(1) : r.steps} điểm</span>
    </li>
  `).join('');
  showScreen('gameover');
});

socket.on('host:disconnected', () => {
  alert('Host đã ngắt kết nối!');
});

// ── Button handlers ───────────────────────────────────────────
// Group picker buttons
document.querySelectorAll('.group-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    selectedGroup = btn.dataset.group;
    document.querySelectorAll('.group-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
  });
});

// Peek room to get live member counts when a 4-digit code is entered
let peekInterval = null;

function startPeek(code) {
  socket.emit('client:peek-room', { roomCode: code });
  if (peekInterval) clearInterval(peekInterval);
  peekInterval = setInterval(() => {
    if (gamePhase !== 'join') { clearInterval(peekInterval); peekInterval = null; return; }
    socket.emit('client:peek-room', { roomCode: code });
  }, 3000);
}

$('input-code').addEventListener('input', () => {
  const code = $('input-code').value.trim();
  if (code.length === 4) startPeek(code);
  else if (peekInterval) { clearInterval(peekInterval); peekInterval = null; }
});

$('btn-join').addEventListener('click', () => {
  const code  = $('input-code').value.trim();
  const errEl = $('join-error');
  errEl.style.display = 'none';

  if (!code || code.length !== 4) {
    errEl.textContent = 'Vui lòng nhập mã phòng 4 chữ số.';
    errEl.style.display = '';
    return;
  }
  if (!selectedGroup) {
    errEl.textContent = 'Vui lòng chọn nhóm.';
    errEl.style.display = '';
    return;
  }

  $('btn-join').disabled = true;
  socket.emit('client:join', { roomCode: code, groupName: selectedGroup });
});

// Answer buttons
document.querySelectorAll('.opt-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const answer = btn.dataset.answer;

    if (isButtonFrozen) {
      if (lastTappedOption !== answer) {
        tapCount = 1;
        lastTappedOption = answer;
        showToast(`🧊 Cần nhấn thêm 4 lần nữa: ${answer}`);
        return;
      }
      tapCount++;
      if (tapCount < 5) {
        showToast(`🧊 Còn ${5 - tapCount} lần nữa: ${answer}`);
        return;
      }
      // 5th tap — success
    }

    mySubmittedAnswer = answer;
    document.querySelectorAll('.opt-btn').forEach(b => b.disabled = true);
    btn.classList.add('selected');
    socket.emit('client:submit-answer', { answer });
  });
});

// Floating inventory button
const btnShowInventory = $('btn-show-inventory');
const invPanel = $('inv-panel');
if (btnShowInventory && invPanel) {
  btnShowInventory.addEventListener('click', () => {
    invPanel.style.display = invPanel.style.display === 'none' ? 'flex' : 'none';
    if (invPanel.style.display === 'flex') renderInventory();
  });
}

// Item confirm
$('btn-confirm-use').addEventListener('click', () => {
  if (!selectedItemId) return;
  if (selectedItemType === 'offensive' && !selectedTarget) {
    alert('Chọn mục tiêu!');
    return;
  }

  socket.emit('client:use-item', { itemId: selectedItemId, targetGroup: selectedTarget || undefined });

  resetItemPanel();
});

$('btn-cancel-use').addEventListener('click', () => {
  resetItemPanel();
});

// Allow pressing Enter to join
$('input-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-join').click();
});
