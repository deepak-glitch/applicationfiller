/*
 * JobFill background service worker (MV3).
 *
 * Jobs:
 *   1. FILL_TAB   (from the popup) — broadcast a fill to every frame in a tab
 *                 and report back the total number of fields filled.
 *   2. FILL_ALL_FRAMES (from the floating button) — broadcast a fill to every
 *                 frame in the sender's tab (so an embedded iframe form fills).
 *   3. AI_ANSWER  (from content scripts) — generate an answer to ONE open-ended
 *                 application question via the user's configured AI provider
 *                 (Claude / OpenAI / Gemini, their own API key). The key never
 *                 leaves the extension: content scripts ask us, we call the API.
 *   4. AI_TEST    (from the popup) — cheap round-trip to validate the key.
 *
 * Content scripts report each frame's result via FRAME_RESULT; we sum those
 * for the popup so it can show an accurate count even when the form lives in
 * an iframe.
 */

// ---------------------------------------------------------------------------
// AI providers
// ---------------------------------------------------------------------------

var DEFAULT_MODELS = {
  claude: 'claude-opus-4-8',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.5-flash',
};

var SYSTEM_PROMPT =
  'You write job-application answers on behalf of a candidate. ' +
  'Reply with ONLY the answer text - no preamble, no quotes, no markdown, no headings. ' +
  'Write in first person as the candidate. Professional, specific, confident. ' +
  'Default to 60-140 words; if the question implies a very short answer ' +
  '(a number, a name, availability), answer in one short sentence. ' +
  'Never invent specific employers, dates, degrees, or certifications that are ' +
  "not in the candidate's background. If the background lacks details, keep " +
  'claims general but positive.';

function buildUserPrompt(msg, ai, profile) {
  var lines = [
    'Question from a job application:',
    '"""' + msg.question + '"""',
    '',
    'Application page: ' + (msg.pageTitle || '(unknown)') + ' (' + (msg.host || '') + ')',
    '',
    "Candidate's background:",
    (ai.bio && ai.bio.trim()) || '(none provided)',
  ];
  if (profile && (profile.currentTitle || profile.currentCompany)) {
    lines.push('');
    lines.push('Current role: ' + [profile.currentTitle, profile.currentCompany]
      .filter(Boolean).join(' at '));
  }
  return lines.join('\n');
}

async function callClaude(key, model, system, user) {
  var r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model,
      max_tokens: 1024,
      system: system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  var data = await r.json();
  if (!r.ok) throw new Error((data.error && data.error.message) || ('HTTP ' + r.status));
  var text = '';
  (data.content || []).forEach(function (b) { if (b.type === 'text') text += b.text; });
  return text.trim();
}

async function callOpenAI(key, model, system, user) {
  var r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': 'Bearer ' + key,
    },
    body: JSON.stringify({
      model: model,
      max_completion_tokens: 1024,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  var data = await r.json();
  if (!r.ok) throw new Error((data.error && data.error.message) || ('HTTP ' + r.status));
  var choice = data.choices && data.choices[0];
  return ((choice && choice.message && choice.message.content) || '').trim();
}

async function callGemini(key, model, system, user) {
  var r = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(model) + ':generateContent',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': key,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: 1024 },
      }),
    }
  );
  var data = await r.json();
  if (!r.ok) throw new Error((data.error && data.error.message) || ('HTTP ' + r.status));
  var cand = data.candidates && data.candidates[0];
  var parts = (cand && cand.content && cand.content.parts) || [];
  return parts.map(function (p) { return p.text || ''; }).join('').trim();
}

var PROVIDERS = { claude: callClaude, openai: callOpenAI, gemini: callGemini };

function aiConfig(ai) {
  var provider = ai.provider || 'claude';
  var key = ai.keys && ai.keys[provider];
  var model = (ai.models && ai.models[provider]) || DEFAULT_MODELS[provider];
  return { provider: provider, key: key, model: model, call: PROVIDERS[provider] };
}

async function generateAnswer(msg, ai, profile) {
  var cfg = aiConfig(ai);
  if (ai.enabled === false) throw new Error('AI answering is turned off');
  if (!cfg.key) throw new Error('No API key configured');
  if (!cfg.call) throw new Error('Unknown provider: ' + cfg.provider);
  var answer = await cfg.call(cfg.key, cfg.model, SYSTEM_PROMPT, buildUserPrompt(msg, ai, profile));
  if (!answer) throw new Error('Empty answer from ' + cfg.provider);
  return answer;
}

var pending = null; // { tabId, total, respond }

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg) return;

  if (msg.type === 'FILL_TAB' && typeof msg.tabId === 'number') {
    pending = { tabId: msg.tabId, total: 0, respond: sendResponse };
    chrome.tabs.sendMessage(msg.tabId, { type: 'FILL' });
    // Text fields fill synchronously, but custom dropdowns (Workday-style
    // comboboxes) fill asynchronously — give frames a couple of seconds to
    // report, then return the aggregated total to the popup.
    setTimeout(function () {
      if (pending && pending.respond) {
        try { pending.respond({ count: pending.total }); } catch (e) { /* popup closed */ }
      }
      pending = null;
    }, 2500);
    return true; // keep the message channel open for the async response
  }

  if (msg.type === 'FILL_ALL_FRAMES' && sender.tab) {
    chrome.tabs.sendMessage(sender.tab.id, { type: 'FILL' });
    return;
  }

  if (msg.type === 'FRAME_RESULT') {
    if (pending && sender.tab && sender.tab.id === pending.tabId) {
      pending.total += (msg.count || 0);
    }
    return;
  }

  if (msg.type === 'AI_ANSWER') {
    chrome.storage.local.get(['aiSettings', 'profile'], function (res) {
      generateAnswer(msg, res.aiSettings || {}, res.profile || {})
        .then(function (answer) { sendResponse({ ok: true, answer: answer }); })
        .catch(function (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); });
    });
    return true; // async response
  }

  if (msg.type === 'AI_TEST') {
    chrome.storage.local.get('aiSettings', function (res) {
      // Testing the key should work even while the feature toggle is off.
      var ai = Object.assign({}, res.aiSettings || {}, { enabled: true });
      generateAnswer(
        { question: 'Reply with the single word: OK', pageTitle: 'JobFill key test', host: '' },
        ai,
        {}
      )
        .then(function () { sendResponse({ ok: true }); })
        .catch(function (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); });
    });
    return true; // async response
  }
});
