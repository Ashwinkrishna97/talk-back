const MESSAGE_TEXT_SELECTOR = [
  'span[data-testid="selectable-text"]',
  'span.selectable-text',
  'div.copyable-text span[dir="ltr"]',
  'div.copyable-text span[dir="auto"]'
].join(', ');

const OUTGOING_STATUS_SELECTOR = [
  '[data-testid="msg-meta"] svg',
  '[data-icon="msg-check"]',
  '[data-icon="msg-dblcheck"]',
  '[data-icon="msg-dblcheck-ack"]'
].join(', ');

const COMPOSE_BOX_SELECTOR = [
  '[data-testid="conversation-compose-box-input"]',
  '#main footer div[contenteditable="true"][role="textbox"]',
  '#main footer div[contenteditable="true"]'
].join(', ');

const CHAT_SCROLL_PANEL_SELECTOR = [
  '#main div[tabindex="-1"]',
  '#main .copyable-area',
  '#main [role="application"]'
].join(', ');

const CHAT_TITLE_SELECTOR = [
  '#main header span[title]',
  '#main header [data-testid="conversation-info-header-chat-title"]'
].join(', ');

const SEL = {
  messageRow: 'div[role="row"]',
  messageIdAttr: '[data-id]',
  messageText: MESSAGE_TEXT_SELECTOR,
  copyableText: '.copyable-text',
  outgoingStatusIcon: OUTGOING_STATUS_SELECTOR,
  composeBox: COMPOSE_BOX_SELECTOR,
  composeFooter: '#main footer',
  chatScrollPanel: CHAT_SCROLL_PANEL_SELECTOR,
  chatTitle: CHAT_TITLE_SELECTOR
};

const RECENT_WINDOW_SIZE = 8;
const SUMMARY_TRIGGER_THRESHOLD = 20;
const SUMMARY_REFRESH_CHUNK = 10;
const TRACKING_POLL_MS = 1500;
const PRIOR_CONTEXT_SIZE = 5;
const NO_DEBATE_REPLY = 'TALK_BACK_NO_DEBATE_REPLY';
const CONTROLS_MARGIN = 16;

const state = {
  anchorRow: null,
  anchorData: null,
  chatKey: '',
  priorContext: [],
  sinceAnchor: [],
  seenIds: new Set(),
  summary: '',
  summarizedCount: 0,
  lastDraftedOpponentCount: 0,
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
  const textParts = Array.from(row.querySelectorAll(SEL.messageText))
    .map((el) => normalizeText(el.innerText))
    .filter(Boolean);
  const text = textParts.length ? textParts[textParts.length - 1] : '';
  const quotedText = textParts.length > 1 ? textParts.slice(0, -1).join(' / ') : '';
  const meta = row.querySelector(SEL.copyableText);
  const raw = meta?.getAttribute('data-pre-plain-text') || '';
  const { sender: senderName, timestampMs } = parseMeta(raw);
  const isOutgoing = !!row.querySelector(SEL.outgoingStatusIcon);
  const sender = isOutgoing ? 'me' : (senderName || 'them');
  return { id: getRowId(row), text, quotedText, sender, timestampMs };
}

function getAllRows() {
  return Array.from(document.querySelectorAll(SEL.messageRow)).filter((r) =>
    r.querySelector(SEL.messageText)
  );
}

function normalizeText(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function getCurrentChatKey() {
  const titled = document.querySelector(SEL.chatTitle);
  if (titled) return normalizeText(titled.getAttribute('title') || titled.textContent);
  return normalizeText(document.querySelector('#main header')?.innerText || '');
}

function isInAnchoredChat() {
  const currentChatKey = getCurrentChatKey();
  return !state.chatKey || !currentChatKey || currentChatKey === state.chatKey;
}

function getOpponentNewCount() {
  return state.sinceAnchor.filter((m) => m.sender !== 'me').length;
}

function injectAnchorButtons() {
  getAllRows().forEach((row) => {
    if (row.querySelector('.rba-anchor-btn')) return;
    const host = row.querySelector(SEL.copyableText) || row;
    host.classList.add('rba-anchor-host');
    host.style.position = host.style.position || 'relative';
    const btn = document.createElement('button');
    btn.className = 'rba-anchor-btn';
    btn.textContent = 'Set anchor';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.anchorRow === row) {
        clearAnchor();
      } else {
        setAnchor(row);
      }
    });
    host.appendChild(btn);
  });
}

async function setAnchor(row) {
  const hasProgress = state.anchorData && (state.sinceAnchor.length > 0 || !!state.summary);
  if (hasProgress && !confirm(`Setting a new anchor clears the assistant's memory — there's no way to undo this action`)) {
    return;
  }

  state.anchorRow = row;
  state.anchorData = extractMessage(row);
  state.chatKey = getCurrentChatKey();
  resetDebateContext();
  state.priorContext = await collectPriorContext(row, PRIOR_CONTEXT_SIZE);
  refreshAnchorButtons();
  updateFab();
}

function resetDebateContext() {
  state.sinceAnchor = [];
  state.seenIds = new Set([state.anchorData.id]);
  state.summary = '';
  state.summarizedCount = 0;
  state.lastDraftedOpponentCount = 0;
}

function clearAnchor() {
  const hasProgress = state.sinceAnchor.length > 0 || !!state.summary;
  if (hasProgress && !confirm(`Removing the anchor clears the assistant's memory — there's no way to undo this action`)) {
    return;
  }
  state.anchorRow = null;
  state.anchorData = null;
  state.chatKey = '';
  state.priorContext = [];
  state.sinceAnchor = [];
  state.seenIds = new Set();
  state.summary = '';
  state.summarizedCount = 0;
  state.lastDraftedOpponentCount = 0;
  state.requestInFlight = false;
  state.requestId += 1;
  refreshAnchorButtons();
  updateFab();
}

function refreshAnchorButtons() {
  document.querySelectorAll('.rba-anchor-btn').forEach((btn) => {
    btn.classList.remove('rba-set');
    btn.textContent = 'Set anchor';
  });
  const btn = state.anchorRow?.querySelector('.rba-anchor-btn');
  if (btn) {
    btn.classList.add('rba-set');
    btn.textContent = 'Remove anchor';
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
  if (!isInAnchoredChat()) {
    updateFab();
    return;
  }
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
    const isVisibleAfterAnchor = anchorIdx === -1;

    if (isAfterByTime || isAfterByPosition || isVisibleAfterAnchor) {
      state.seenIds.add(id);
      state.sinceAnchor.push(data);
    }
  });

  state.sinceAnchor.sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0));
  updateFab();
}

function createFab() {
  if (document.querySelector('.rba-fab')) return;

  const controls = document.createElement('div');
  controls.className = 'rba-controls';

  const stopBtn = document.createElement('button');
  stopBtn.className = 'rba-stop-btn';
  stopBtn.textContent = 'Remove anchor';
  stopBtn.addEventListener('click', clearAnchor);
  controls.appendChild(stopBtn);

  const fab = document.createElement('button');
  fab.className = 'rba-fab';
  fab.textContent = 'Set an anchor first';
  fab.disabled = true;
  fab.addEventListener('click', generateAndInsertDraft);
  controls.appendChild(fab);

  document.body.appendChild(controls);
  positionControls();
}

function positionControls() {
  const controls = document.querySelector('.rba-controls');
  if (!controls) return;
  const footer = document.querySelector(SEL.composeFooter);
  const footerHeight = footer ? footer.getBoundingClientRect().height : 0;
  controls.style.bottom = `${footerHeight + CONTROLS_MARGIN}px`;
}

function updateFab() {
  const fab = document.querySelector('.rba-fab');
  const stopBtn = document.querySelector('.rba-stop-btn');
  if (!fab || state.requestInFlight) return;

  const inAnchoredChat = !state.anchorData || isInAnchoredChat();
  const opponentNewCount = getOpponentNewCount();
  const undraftedOpponentCount = Math.max(0, opponentNewCount - state.lastDraftedOpponentCount);
  const canDraft = !!state.anchorData && inAnchoredChat && undraftedOpponentCount > 0;

  fab.disabled = !canDraft;
  if (stopBtn) stopBtn.classList.toggle('rba-visible', !!state.anchorData && inAnchoredChat);

  if (!state.anchorData) {
    fab.textContent = 'Set an anchor first';
  } else if (!inAnchoredChat) {
    fab.textContent = 'Return to the anchored chat';
  } else if (undraftedOpponentCount === 0) {
    fab.textContent = 'Waiting for a reply';
  } else {
    fab.textContent = `Draft rebuttal — ${undraftedOpponentCount} new`;
  }
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
    console.warn('Summary refresh failed — continuing without it', response.error);
  }
}

async function generateAndInsertDraft() {
  if (!state.anchorData || state.requestInFlight) return;
  if (!isInAnchoredChat()) {
    alert('Return to the anchored chat');
    updateFab();
    return;
  }
  if (getOpponentNewCount() <= state.lastDraftedOpponentCount) {
    alert('Waiting for the other person to reply');
    updateFab();
    return;
  }

  state.requestInFlight = true;
  const requestId = ++state.requestId;
  const sinceCountAtRequest = state.sinceAnchor.length;

  const fab = document.querySelector('.rba-fab');
  fab.disabled = true;
  fab.classList.add('rba-loading');
  fab.textContent = 'Thinking...';

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
    alert(`Talk Back: ${response.error}`);
    return;
  }
  if (response.draft === NO_DEBATE_REPLY) {
    state.lastDraftedOpponentCount = getOpponentNewCount();
    updateFab();
    alert('Latest message looks like non-debatable topic — no reply was drafted');
    return;
  }

  const newCount = state.sinceAnchor.length - sinceCountAtRequest;
  if (newCount > 0) {
    const proceed = confirm(
      `${newCount} new message${newCount > 1 ? 's' : ''} arrived while drafting a reply. Shall I insert what's already drafted, or cancel so I can redraft a new reply?`
    );
    if (!proceed) return;
  }

  insertDraft(response.draft);
}

function insertDraft(text) {
  const box = document.querySelector(SEL.composeBox);
  if (!box) {
    alert('Could not find the compose box — open a chat first');
    return;
  }

  const current = box.innerText.trim();
  if (current && current !== state.lastInsertedDraft) {
    if (!confirm(`I can see that you've typed something already — shall I overwrite it with what I've drafted?`)) {
      return;
    }
  }

  if (!isInAnchoredChat()) {
    alert('Return to the anchored chat');
    updateFab();
    return;
  }

  box.focus();
  document.execCommand('selectAll', false, null);
  document.execCommand('insertText', false, text);
  state.lastInsertedDraft = text;
  state.lastDraftedOpponentCount = getOpponentNewCount();
  updateFab();
}

const observer = new MutationObserver(() => {
  injectAnchorButtons();
  trackNewMessages();
  positionControls();
});

function start() {
  observer.observe(document.querySelector('#main') || document.body, {
    childList: true,
    subtree: true
  });
  injectAnchorButtons();
  createFab();
  setInterval(() => {
    injectAnchorButtons();
    trackNewMessages();
    positionControls();
  }, TRACKING_POLL_MS);
}

const bootInterval = setInterval(() => {
  if (document.querySelector('#main')) {
    clearInterval(bootInterval);
    start();
  }
}, 1000);
