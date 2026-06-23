const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GENERATE_REBUTTAL') {
    generateRebuttal(msg.payload)
      .then((draft) => sendResponse({ draft }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
  if (msg.type === 'SUMMARIZE_MIDDLE') {
    summarizeMiddle(msg.payload)
      .then((summary) => sendResponse({ summary }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
});

async function callClaude({ model, system, userContent, tools, maxTokens }) {
  const { anthropicApiKey } = await chrome.storage.local.get('anthropicApiKey');
  if (!anthropicApiKey) {
    throw new Error('No Claude API key set. Click the extension icon and add one.');
  }

  const body = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: userContent }]
  };
  if (tools) body.tools = tools;

  const res = await fetch(ANTHROPIC_ENDPOINT, {
    method: 'POST',
    headers: {
      'x-api-key': anthropicApiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Claude API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  return (data.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
}

async function generateRebuttal(payload) {
  const system = [
    "You write the next reply for the user in an ongoing WhatsApp debate.",
    "First, check whether the other person's last message relies on a logical fallacy",
    "(false equivalence, whataboutism, strawman, slippery slope, etc.). If it does, name the",
    "fallacy in plain terms and explain why the comparison breaks down — that needs no search,",
    "just sound reasoning.",
    "Separately, if the conversation includes a factual or verifiable claim that needs evidence",
    '(a statistic, a historical record, a quoted text, a "prove it"-style challenge), use the',
    'web search tool to check it and cite the source briefly inline (e.g. "per Reuters") rather',
    'than a footnote or link list.',
    "Combine both into one natural reply, first person, casual texting tone, under 80 words unless",
    "the point genuinely needs more room. Plain text only, no markdown, no surrounding quotation marks."
  ].join(' ');

  return callClaude({
    model: 'claude-sonnet-4-6',
    system,
    userContent: buildContextPrompt(payload),
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
    maxTokens: 1024
  });
}

function buildContextPrompt({ priorContext, anchor, summary, sinceAnchor }) {
  const lines = ['Conversation, oldest to newest:', ''];
  priorContext.forEach((m) => lines.push(`${m.sender}: ${m.text}`));
  lines.push(`${anchor.sender}: ${anchor.text}  <-- anchor message, debate starts here`);
  if (summary) {
    lines.push('', `Summary of everything argued since then, before the most recent messages: ${summary}`);
  }
  lines.push('', 'Most recent messages:');
  sinceAnchor.forEach((m) => lines.push(`${m.sender}: ${m.text}`));
  lines.push('', 'Write my next reply to send now.');
  return lines.join('\n');
}

async function summarizeMiddle({ anchor, existingSummary, newMessages }) {
  const system = [
    'You maintain a running summary of an ongoing WhatsApp debate, for another AI to use as context later.',
    'Update the summary to fold in the new messages below. Keep it to 2-4 sentences.',
    'Preserve who claimed what and which points were already made or rebutted. Drop greetings and small talk.',
    'Output only the updated summary text, nothing else — no preamble, no labels.'
  ].join(' ');

  const lines = [`Debate anchor: ${anchor.sender}: ${anchor.text}`, ''];
  if (existingSummary) lines.push(`Existing summary: ${existingSummary}`, '');
  lines.push('New messages to fold in:');
  newMessages.forEach((m) => lines.push(`${m.sender}: ${m.text}`));

  return callClaude({
    model: 'claude-haiku-4-5-20251001',
    system,
    userContent: lines.join('\n'),
    maxTokens: 300
  });
}