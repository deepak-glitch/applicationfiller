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

var MAX_RESUME_CHARS = 12000; // keep prompts bounded even for long resumes

function buildUserPrompt(msg, ai, profile) {
  var resume = ((ai.resume || ai.bio || '') + '').trim();
  if (resume.length > MAX_RESUME_CHARS) resume = resume.slice(0, MAX_RESUME_CHARS) + '\n[truncated]';
  var lines = [
    'Question from a job application:',
    '"""' + msg.question + '"""',
    '',
    'Application page: ' + (msg.pageTitle || '(unknown)') + ' (' + (msg.host || '') + ')',
    '',
    "Candidate's resume / background:",
    resume || '(none provided)',
  ];
  if (profile && (profile.currentTitle || profile.currentCompany)) {
    lines.push('');
    lines.push('Current role: ' + [profile.currentTitle, profile.currentCompany]
      .filter(Boolean).join(' at '));
  }
  return lines.join('\n');
}

// Each provider call takes optional opts: { maxTokens, doc: { data, mime } }.
// `doc` attaches a base64 file (PDF) so the model can read a resume directly.

async function callClaude(key, model, system, user, opts) {
  opts = opts || {};
  var content = opts.doc
    ? [
        { type: 'document', source: { type: 'base64', media_type: opts.doc.mime, data: opts.doc.data } },
        { type: 'text', text: user },
      ]
    : user;
  var r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      // Anthropic requires this opt-in for requests originating from a browser
      // context (extensions included). The key still never leaves the worker.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: model,
      max_tokens: opts.maxTokens || 1024,
      system: system,
      messages: [{ role: 'user', content: content }],
    }),
  });
  var data = await r.json();
  if (!r.ok) throw new Error((data.error && data.error.message) || ('HTTP ' + r.status));
  var text = '';
  (data.content || []).forEach(function (b) { if (b.type === 'text') text += b.text; });
  return text.trim();
}

async function callOpenAI(key, model, system, user, opts) {
  opts = opts || {};
  var userContent = opts.doc
    ? [
        { type: 'file', file: { filename: 'resume.pdf', file_data: 'data:' + opts.doc.mime + ';base64,' + opts.doc.data } },
        { type: 'text', text: user },
      ]
    : user;
  var r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': 'Bearer ' + key,
    },
    body: JSON.stringify({
      model: model,
      max_completion_tokens: opts.maxTokens || 1024,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent },
      ],
    }),
  });
  var data = await r.json();
  if (!r.ok) throw new Error((data.error && data.error.message) || ('HTTP ' + r.status));
  var choice = data.choices && data.choices[0];
  return ((choice && choice.message && choice.message.content) || '').trim();
}

async function callGemini(key, model, system, user, opts) {
  opts = opts || {};
  var parts = opts.doc
    ? [{ inline_data: { mime_type: opts.doc.mime, data: opts.doc.data } }, { text: user }]
    : [{ text: user }];
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
        contents: [{ role: 'user', parts: parts }],
        generationConfig: { maxOutputTokens: opts.maxTokens || 1024 },
      }),
    }
  );
  var data = await r.json();
  if (!r.ok) throw new Error((data.error && data.error.message) || ('HTTP ' + r.status));
  var cand = data.candidates && data.candidates[0];
  var respParts = (cand && cand.content && cand.content.parts) || [];
  return respParts.map(function (p) { return p.text || ''; }).join('').trim();
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

// ---------------------------------------------------------------------------
// Resume → profile extraction
// ---------------------------------------------------------------------------

var EXTRACT_SYSTEM =
  'You extract structured candidate data from resumes. ' +
  'Reply with ONLY a valid JSON object - no markdown fences, no commentary.';

var EXTRACT_PROMPT =
  'Read the resume and produce a JSON object with exactly these keys, ' +
  'omitting any key you cannot find a value for:\n' +
  '"firstName","lastName","fullName","preferredName","email","phone",' +
  '"address","addressLine2","city","state","zip","country",' +
  '"linkedin","github","portfolio","twitter",' +
  '"currentCompany","currentTitle","resumeText"\n' +
  'Rules: copy the phone number as written; linkedin/github/portfolio must be ' +
  'full URLs; currentCompany and currentTitle come from the most recent ' +
  'position; resumeText is the COMPLETE resume converted to plain text, ' +
  'preserving section order and all bullet points.';

function parseJSONLoose(s) {
  s = String(s).trim();
  var start = s.indexOf('{');
  var end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('Model did not return JSON');
  return JSON.parse(s.slice(start, end + 1));
}

async function extractProfile(msg, ai) {
  var cfg = aiConfig(ai);
  if (!cfg.key) throw new Error('No API key configured — add one in the AI tab');
  if (!cfg.call) throw new Error('Unknown provider: ' + cfg.provider);
  var raw;
  if (msg.text != null) {
    raw = await cfg.call(cfg.key, cfg.model, EXTRACT_SYSTEM,
      EXTRACT_PROMPT + '\n\nRESUME:\n' + msg.text, { maxTokens: 8192 });
  } else {
    raw = await cfg.call(cfg.key, cfg.model, EXTRACT_SYSTEM, EXTRACT_PROMPT,
      { maxTokens: 8192, doc: { data: msg.data, mime: msg.mime || 'application/pdf' } });
  }
  return parseJSONLoose(raw);
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

  if (msg.type === 'AI_EXTRACT') {
    chrome.storage.local.get('aiSettings', function (res) {
      // Extraction is an explicit user action — allowed even when the
      // answer-during-fill toggle is off.
      var ai = Object.assign({}, res.aiSettings || {}, { enabled: true });
      extractProfile(msg, ai)
        .then(function (data) { sendResponse({ ok: true, data: data }); })
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
