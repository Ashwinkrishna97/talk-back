const SEL = {
  messageRow: 'div[role="row"]',
  messageIdAttr: '[data-id]',
  messageText: 'span[data-testid="selectable-text"]',
  copyableText: '.copyable-text',
  outgoingStatusIcon: '[data-testid="msg-meta"] svg',
  composeBox: '[data-testid="conversation-compose-box-input"]',
  chatScrollPanel: '#main div[tabindex="-1"], #main .copyable-area'
};

const RECENT_WINDOW_SIZE = 8;
const SUMMARY_TRIGGER_THRESHOLD = 20;
const SUMMARY_REFRESH_CHUNK = 10;

const state = {
  anchorRow: null,
  anchorData: null,
  priorContext: [],
  sinceAnchor: [],
  seenIds: new Set(),
  summary: '',
  summarizedCount: 0,
  requestInFlight: false,
  requestId: 0,
  lastInsertedDraft: ''
};

function sendRuntimeMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => resolve(response));
  });
}

function getRowId(row) {
  const idEl = row.querySelector(SEL.messageIdAttr);
  if (idEl) return idEl.getAttribute('data-id');
  if (!row.dataset.rbaId) row.dataset.rbaId = `rba-${Math.random().toString(36).slice(2)}`;
  return row.dataset.rbaId;
}

function parseMeta(raw) {
  const m = raw.match(/^\[(.*?),\s*(.*?)\]\s*(.*?):\s*$/);
  if (!m) return { sender: '', timestampMs: null };
  const [, timePart, datePart, sender] = m;
  const d = new Date(`${datePart} ${timePart}`);
  return { sender, timestampMs: Number.isNaN(d.getTime()) ? null : d.getTime() };
}

function extractMessage(row) {
  const textEl = row.querySelector(SEL.messageText);
  const text = textEl ? textEl.innerText.trim() : '';
  const meta = row.querySelector(SEL.copyableText);
  const raw = meta?.getAttribute('data-pre-plain-text') || '';
  const { sender: senderName, timestampMs } = parseMeta(raw);
  const isOutgoing = !!row.querySelector(SEL.outgoingStatusIcon);
  const sender = isOutgoing ? 'me' : (senderName || 'them');
  return { id: getRowId(row), text, sender, timestampMs };
}

function getAllRows() {
  return Array.from(document.querySelectorAll(SEL.messageRow)).filter((r) =>
    r.querySelector(SEL.messageText)
  );
}

function injectAnchorButtons() {
  getAllRows().forEach((row) => {
    if (row.querySelector('.rba-anchor-btn')) return;
    row.style.position = row.style.position || 'relative';
    const btn = document.createElement('button');
    btn.className = 'rba-anchor-btn';
    btn.textContent = 'set anchor';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      setAnchor(row);
    });
    row.appendChild(btn);
  });
}

async function setAnchor(row) {
  state.anchorRow = row;
  state.anchorData = extractMessage(row);
  state.sinceAnchor = [];
  state.seenIds = new Set([state.anchorData.id]);
  state.summary = '';
  state.summarizedCount = 0;
  state.priorContext = await collectPriorContext(row, 5);
  refreshAnchorButtons();
  updateFab();
}

function refreshAnchorButtons() {
  document.querySelectorAll('.rba-anchor-btn').forEach((btn) => {
    btn.classList.remove('rba-set');
    btn.textContent = 'set anchor';
  });
  const btn = state.anchorRow?.querySelector('.rba-anchor-btn');
  if (btn) {
    btn.classList.add('rba-set');
    btn.textContent = 'anchor ✓';
  }
}

async function collectPriorContext(anchorRow, count) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const rows = getAllRows();
    const idx = rows.indexOf(anchorRow);
    const before = rows.slice(Math.max(0, idx - count), idx);
    if (before.length >= count || idx <= 0) return before.map(extractMessage);
    document.querySelector(SEL.chatScrollPanel)?.scrollBy(0, -600);
    await wait(350);
  }
  return getAllRows().slice(0, count).map(extractMessage);
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function trackNewMessages() {
  if (!state.anchorData) return;
  const rows = getAllRows();
  const anchorIdx = rows.findIndex((r) => getRowId(r) === state.anchorData.id);

  rows.forEach((row, idx) => {
    const id = getRowId(row);
    if (id === state.anchorData.id || state.seenIds.has(id)) return;

    const data = extractMessage(row);
    if (!data.text) return;

    const isAfterByTime =
      data.timestampMs != null &&
      state.anchorData.timestampMs != null &&
      data.timestampMs >= state.anchorData.timestampMs;
    const isAfterByPosition = anchorIdx !== -1 && idx > anchorIdx;

    if (isAfterByTime || (data.timestampMs == null && isAfterByPosition)) {
      state.seenIds.add(id);
      state.sinceAnchor.push(data);
    }
  });

  state.sinceAnchor.sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0));
  updateFab();
}

function createFab() {
  if (document.querySelector('.rba-fab')) return;
  const fab = document.createElement('button');
  fab.className = 'rba-fab';
  fab.textContent = 'set an anchor first';
  fab.disabled = true;
  fab.addEventListener('click', generateAndInsertDraft);
  document.body.appendChild(fab);
}

function updateFab() {
  const fab = document.querySelector('.rba-fab');
  if (!fab || state.requestInFlight) return;
  fab.disabled = !state.anchorData;
  fab.textContent = state.anchorData
    ? `draft rebuttal${state.sinceAnchor.length ? ` (${state.sinceAnchor.length} new)` : ''}`
    : 'set an anchor first';
}

function getMiddleBoundary() {
  return Math.max(0, state.sinceAnchor.length - RECENT_WINDOW_SIZE);
}

async function maybeRefreshSummary() {
  if (state.sinceAnchor.length <= SUMMARY_TRIGGER_THRESHOLD) return;

  const middleEnd = getMiddleBoundary();
  if (middleEnd <= 0) return;

  const firstTime = state.summarizedCount === 0;
  const newSinceLastSummary = middleEnd - state.summarizedCount;
  if (!firstTime && newSinceLastSummary < SUMMARY_REFRESH_CHUNK) return;

  const middleNew = state.sinceAnchor.slice(state.summarizedCount, middleEnd);
  if (middleNew.length === 0) return;

  const response = await sendRuntimeMessage({
    type: 'SUMMARIZE_MIDDLE',
    payload: {
      anchor: state.anchorData,
      existingSummary: state.summary,
      newMessages: middleNew
    }
  });

  if (response?.summary) {
    state.summary = response.summary;
    state.summarizedCount = middleEnd;
  } else if (response?.error) {
    console.warn('Rebuttal assistant: summary refresh failed, continuing without it.', response.error);
  }
}

async function generateAndInsertDraft() {
  if (!state.anchorData || state.requestInFlight) return;

  state.requestInFlight = true;
  const requestId = ++state.requestId;
  const sinceCountAtRequest = state.sinceAnchor.length;

  const fab = document.querySelector('.rba-fab');
  fab.disabled = true;
  fab.classList.add('rba-loading');
  fab.textContent = 'thinking…';

  await maybeRefreshSummary();

  const middleEnd = getMiddleBoundary();
  const recentWindow = middleEnd > 0 ? state.sinceAnchor.slice(middleEnd) : state.sinceAnchor.slice();

  const payload = {
    priorContext: [...state.priorContext],
    anchor: state.anchorData,
    summary: state.summary,
    sinceAnchor: recentWindow
  };

  const response = await sendRuntimeMessage({ type: 'GENERATE_REBUTTAL', payload });

  state.requestInFlight = false;
  fab.classList.remove('rba-loading');
  updateFab();

  if (requestId !== state.requestId) return;
  if (!response) return;
  if (response.error) {
    alert(`Rebuttal assistant: ${response.error}`);
    return;
  }

  const newCount = state.sinceAnchor.length - sinceCountAtRequest;
  if (newCount > 0) {
    const proceed = confirm(
      `${newCount} new message${newCount > 1 ? 's' : ''} arrived while drafting this. ` +
      'Insert the draft anyway, or Cancel to discard it and redraft with the latest messages?'
    );
    if (!proceed) return;
  }

  insertDraft(response.draft);
}

function insertDraft(text) {
  const box = document.querySelector(SEL.composeBox);
  if (!box) {
    alert('Could not find the WhatsApp compose box — open a chat first.');
    return;
  }

  const current = box.innerText.trim();
  if (current && current !== state.lastInsertedDraft) {
    if (!confirm('The compose box already has text you typed — overwrite it with the drafted rebuttal?')) {
      return;
    }
  }

  const stillThere = state.anchorData && document.querySelector(`[data-id="${state.anchorData.id}"]`);
  if (!stillThere) {
    const proceed = confirm(
      "Can't confirm this is still the same conversation as when you set the anchor " +
      '(you may have switched chats, or just scrolled far away). Insert anyway?'
    );
    if (!proceed) return;
  }

  box.focus();
  document.execCommand('selectAll', false, null);
  document.execCommand('insertText', false, text);
  state.lastInsertedDraft = text;
}

const observer = new MutationObserver(() => {
  injectAnchorButtons();
  trackNewMessages();
});

function start() {
  observer.observe(document.querySelector('#main') || document.body, {
    childList: true,
    subtree: true
  });
  injectAnchorButtons();
  createFab();
}

const bootInterval = setInterval(() => {
  if (document.querySelector('#main')) {
    clearInterval(bootInterval);
    start();
  }
}, 1000);