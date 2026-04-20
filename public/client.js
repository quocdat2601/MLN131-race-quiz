const socket = io();

// ── State ────────────────────────────────────────────────────
let myGroup    = '';
let inventory  = [];   // Array of item objects
let timerMax   = 20;
let gamePhase  = 'JOIN'; // JOIN | WAITING | QUESTION | ANSWERED | RESULT | ITEM_PHASE | BETWEEN | GAMEOVER
let isFrozen   = false;

// Item-use selection state
let selectedItemId    = null;
let selectedItemType  = null;
let selectedTarget    = null;

const GROUPS = ['Nhóm 1', 'Nhóm 2', 'Nhóm 3', 'Nhóm 5', 'Nhóm 6', 'Nhóm 7'];
const MEDALS  = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣'];

// ── DOM helpers ───────────────────────────────────────────────
function $(id)       { return document.getElementById(id); }
function show(id)    { const e = $(id); if(e) e.style.display = ''; }
function hide(id)    { const e = $(id); if(e) e.style.display = 'none'; }

const screens = {
  join:       $('screen-join'),
  waiting:    $('screen-waiting'),
  question:   $('screen-question'),
  answered:   $('screen-answered'),
  result:     $('screen-result'),
  itemPhase:  $('screen-item-phase'),
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

  if (list) {
    if (inventory.length === 0) {
      list.innerHTML = '';
      if (noItems) noItems.style.display = '';
    } else {
      if (noItems) noItems.style.display = 'none';
      list.innerHTML = inventory.map(item => `
        <div class="item-chip" data-item-id="${item.id}" data-item-type="${item.type}">
          ${item.emoji} ${item.name}
        </div>
      `).join('');
      list.querySelectorAll('.item-chip').forEach(chip => {
        chip.addEventListener('click', () => selectItem(chip.dataset.itemId, chip.dataset.itemType));
      });
    }
  }

  if (between) {
    between.innerHTML = inventory.length > 0
      ? `<div class="mini-inventory">${inventory.map(i => `<span class="mini-chip">${i.emoji} ${i.name}</span>`).join('')}</div>`
      : '';
  }
}

function selectItem(itemId, itemType) {
  if ($('item-used-msg') && $('item-used-msg').style.display !== 'none') return;

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
  title.textContent   = `${item.emoji} ${item.name}: ${itemDescription(item.id)}`;

  if (itemType === 'offensive') {
    picker.style.display = 'flex';
    const otherGroups = GROUPS.filter(g => g !== myGroup);
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
    bug:    'Đối thủ lùi 2 bước',
    rocket: 'Tiến thêm 3 bước',
    shield: 'Chặn 1 đòn tấn công',
    freeze: 'Đối thủ bị đóng băng 1 câu',
    swap:   'Đổi vị trí với đối thủ',
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
socket.on('join:success', ({ groupName }) => {
  myGroup = groupName;
  $('waiting-group-name').textContent = `${groupName} 🦆`;
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
  $('waiting-group-name').textContent = myGroup + ' 🦆';
});

socket.on('question:shown', ({ number, total, text, options }) => {
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

  timerMax = 20;
  setTimerUI(20, 20);
  showScreen('question');
});

socket.on('timer:tick', ({ remaining }) => {
  if (gamePhase === 'question') {
    setTimerUI(remaining, timerMax);
  } else if (gamePhase === 'itemPhase') {
    const t = $('item-phase-timer');
    if (t) t.textContent = remaining;
  }
});

socket.on('answer:locked', () => {
  // Show "sent" screen
  $('answered-icon').textContent = '✅';
  $('answered-msg').textContent  = 'Đã gửi đáp án!';
  showScreen('answered');
});

socket.on('answer:result', ({ correct, stepsGained, itemReceived }) => {
  $('result-icon').textContent  = correct ? '✅' : '❌';
  $('result-steps').textContent = correct && stepsGained > 0
    ? `+${stepsGained} bước`
    : correct && stepsGained === 0
      ? 'Đúng nhưng bị đóng băng!'
      : 'Sai — không có điểm';
  $('result-item').textContent  = itemReceived
    ? `Nhận được: ${itemReceived.emoji} ${itemReceived.name}`
    : '';

  if (isFrozen) {
    $('frozen-msg').style.display = '';
  } else {
    $('frozen-msg').style.display = 'none';
  }

  showScreen('result');
});

socket.on('inventory:update', ({ items }) => {
  inventory = items;
  renderInventory();
});

socket.on('item-phase:started', () => {
  resetItemPanel();
  const usedMsg = $('item-used-msg');
  if (usedMsg) usedMsg.style.display = 'none';
  renderInventory();
  showScreen('itemPhase');
});

socket.on('item-phase:ended', () => {
  isFrozen = false;
  renderInventory();
  showScreen('between');
});

socket.on('frozen:notified', () => {
  isFrozen = true;
});

socket.on('shield:blocked', () => {
  const usedMsg = $('item-used-msg');
  if (usedMsg) {
    usedMsg.style.display = '';
    usedMsg.textContent   = '🛡️ Shield của bạn đã chặn một đòn tấn công!';
  }
});

socket.on('item:error', ({ message }) => {
  alert(message);
});

socket.on('game:over', ({ rankings }) => {
  const list = $('client-rankings');
  list.innerHTML = rankings.map((r, i) => `
    <li>
      <span>${MEDALS[i] || (i+1)+'.'}  ${r.group}</span>
      <span class="cr-steps">${r.steps} bước</span>
    </li>
  `).join('');
  showScreen('gameover');
});

socket.on('host:disconnected', () => {
  alert('Host đã ngắt kết nối!');
});

// ── Button handlers ───────────────────────────────────────────
$('btn-join').addEventListener('click', () => {
  const code  = $('input-code').value.trim();
  const group = $('select-group').value;
  const errEl = $('join-error');
  errEl.style.display = 'none';

  if (!code || code.length !== 4) {
    errEl.textContent = 'Vui lòng nhập mã phòng 4 chữ số.';
    errEl.style.display = '';
    return;
  }
  if (!group) {
    errEl.textContent = 'Vui lòng chọn nhóm.';
    errEl.style.display = '';
    return;
  }

  $('btn-join').disabled = true;
  socket.emit('client:join', { roomCode: code, groupName: group });
});

// Answer buttons
document.querySelectorAll('.opt-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const answer = btn.dataset.answer;
    document.querySelectorAll('.opt-btn').forEach(b => b.disabled = true);
    btn.classList.add('selected');
    socket.emit('client:submit-answer', { answer });
  });
});

// Item confirm
$('btn-confirm-use').addEventListener('click', () => {
  if (!selectedItemId) return;
  if (selectedItemType === 'offensive' && !selectedTarget) {
    alert('Chọn mục tiêu!');
    return;
  }

  socket.emit('client:use-item', { itemId: selectedItemId, targetGroup: selectedTarget || undefined });

  const usedMsg = $('item-used-msg');
  const item = inventory.find(i => i.id === selectedItemId);
  if (usedMsg && item) {
    usedMsg.style.display = '';
    usedMsg.textContent   = `${item.emoji} Đã dùng ${item.name}${selectedTarget ? ` vào ${selectedTarget}` : ''}!`;
  }

  // Disable all chips
  document.querySelectorAll('.item-chip').forEach(c => c.classList.add('disabled'));
  $('use-item-panel').style.display = 'none';
});

$('btn-cancel-use').addEventListener('click', () => {
  resetItemPanel();
});

// Allow pressing Enter to join
$('input-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-join').click();
});
