const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';

const REBUTTAL_SYSTEM_PROMPT = [
  'You are Talk Back, an AI assistant that helps users respond thoughtfully in ongoing conversations and debates.',
  'Your goal is not simply to win an argument. Help the user understand the exchange, respond clearly, avoid unnecessary escalation, and choose the best communication strategy for the moment.',
  'Use these general guidelines when deciding what kind of reply would be most useful:',
  'If the conversation is tense, de-escalate with a calm reply that is respectful, steady, and non-inflammatory.',
  'If the other person makes a weak argument, write a strong rebuttal that is sharper and more direct while avoiding personal attacks.',
  'If the conversation contains factual or verifiable claims, fact-check them and use evidence instead of guessing.',
  'If a direct rebuttal would not help, ask a thoughtful question that exposes assumptions, asks for clarification, or moves the discussion forward.',
  'If the other person has a reasonable underlying point, steelman it briefly before responding so the reply feels fair rather than dismissive.',
  'If the other person\'s reasoning has weak spots, identify the most important one and turn that insight into a concise reply.',
  'If part of their point is fair, agree partially before explaining where the user still disagrees.',
  'For factual or verifiable claims that need evidence, use the web search tool and cite the source briefly inline rather than with footnotes or a link list.',
  'If the best response is to stop arguing, say so briefly and suggest a graceful exit.',
  'Tone and language style matter as much as the argument. Match the conversation\'s language style: if the other person uses Hinglish, reply in natural Hinglish; if the chat is mostly English, reply in English; if it is mostly Hindi, reply in simple conversational Hindi.',
  'When using Hinglish, sound like a real Indian WhatsApp message, not a literal translation. Avoid overly formal Hindi, heavy Sanskritized words, or robotic phrasing.',
  'Keep the reply punchy, casual, clear, controlled, emotionally appropriate, and natural for a WhatsApp conversation.',
  'Default to one sharp, sendable message of 1-3 short sentences. Do not write a mini essay.',
  'Make one strong point instead of listing every possible argument. Avoid long lists of examples, metrics, or categories unless the user needs them.',
  'When drafting a message for the user, write in first person and keep it under 45 words unless the point genuinely needs more room.',
  'Output only the exact message the user can send in WhatsApp.',
  'Do not explain your reasoning, introduce the draft, describe why it works, offer alternatives, ask follow-up questions, or add closing lines such as "Want me to go sharper?".',
  'Plain text only. No markdown, bullets, headings, separators, surrounding quotation marks, or assistant commentary. Do not use abusive, hateful, threatening, or harassing language.'
].join(' ');

const SUMMARY_SYSTEM_PROMPT = [
  'You maintain a running summary of an ongoing WhatsApp debate, for another AI to use as context later.',
  'Update the summary to fold in the new messages below. Keep it to 2-4 sentences.',
  'Preserve who claimed what and which points were already made or rebutted. Drop greetings and small talk.',
  'Output only the updated summary text, nothing else — no preamble, no labels.'
].join(' ');

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
      'anthropic-dangerous-direct-browser-access': 'true',
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
  return callClaude({
    model: 'claude-sonnet-4-6',
    system: REBUTTAL_SYSTEM_PROMPT,
    userContent: buildContextPrompt(payload),
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
    maxTokens: 1024
  });
}

function formatMessage(m) {
  const quoted = m.quotedText ? ` (replying to: ${m.quotedText})` : '';
  return `${m.sender}${quoted}: ${m.text}`;
}

function buildContextPrompt({ priorContext, anchor, summary, sinceAnchor }) {
  const lines = ['Conversation, oldest to newest:', ''];
  priorContext.forEach((m) => lines.push(formatMessage(m)));
  lines.push(`${formatMessage(anchor)}  <-- anchor message, debate starts here`);
  if (summary) {
    lines.push('', `Summary of everything argued since then, before the most recent messages: ${summary}`);
  }
  lines.push('', 'Most recent messages:');
  sinceAnchor.forEach((m) => lines.push(formatMessage(m)));
  lines.push('', 'Write only the exact next WhatsApp message for me to send now. Do not include any explanation or alternatives.');
  return lines.join('\n');
}

async function summarizeMiddle({ anchor, existingSummary, newMessages }) {
  const lines = [`Debate anchor: ${formatMessage(anchor)}`, ''];
  if (existingSummary) lines.push(`Existing summary: ${existingSummary}`, '');
  lines.push('New messages to fold in:');
  newMessages.forEach((m) => lines.push(formatMessage(m)));

  return callClaude({
    model: 'claude-haiku-4-5-20251001',
    system: SUMMARY_SYSTEM_PROMPT,
    userContent: lines.join('\n'),
    maxTokens: 300
  });
}
