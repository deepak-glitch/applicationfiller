/*
 * JobFill content script — the matching + fill engine.
 *
 * Runs on every page (and every iframe, see manifest all_frames). It:
 *   1. reads the saved profile from chrome.storage.local
 *   2. walks every form control on the page
 *   3. scores each control against the field schema (fields.js)
 *   4. writes the profile value into the best match — but only if empty
 *
 * A floating ⚡ button is injected in the top frame; the popup can also
 * trigger a fill. Both routes end up calling doFill().
 */
(function () {
  'use strict';

  var FIELDS = (window.FIELD_LIST || (typeof FIELD_LIST !== 'undefined' ? FIELD_LIST : []));
  var MATCH_THRESHOLD = 1.0; // minimum score for a control<->field match

  // ---------------------------------------------------------------------------
  // Text helpers
  // ---------------------------------------------------------------------------

  // Normalize any label-ish string into space-separated lowercase words.
  // Splits camelCase and snake/kebab/dotted names, drops punctuation & required
  // markers, collapses whitespace.
  function normalize(s) {
    if (!s) return '';
    return String(s)
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase -> camel Case
      .replace(/[_\-.\[\]/]+/g, ' ')
      .replace(/[^a-zA-Z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  // Whole-word phrase match: does `text` contain `phrase` on word boundaries?
  function containsPhrase(text, phrase) {
    if (!text || !phrase) return false;
    return (' ' + text + ' ').indexOf(' ' + phrase + ' ') !== -1;
  }

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/["\\\]#.:>~+*^$=|()[]/g, '\\$&');
  }

  // ---------------------------------------------------------------------------
  // Collecting labels ("signals") for a control
  // ---------------------------------------------------------------------------

  // A signal is { text: normalizedString, weight: number }. Higher weight =
  // more trustworthy source (a real <label> beats a raw id).
  function pushSignal(list, raw, weight) {
    var n = normalize(raw);
    if (n) list.push({ text: n, weight: weight });
  }

  function labelSignals(el) {
    var out = [];

    var alb = el.getAttribute('aria-labelledby');
    if (alb) {
      alb.split(/\s+/).forEach(function (id) {
        var ref = id && document.getElementById(id);
        if (ref) pushSignal(out, ref.textContent, 1.15);
      });
    }
    pushSignal(out, el.getAttribute('aria-label'), 1.1);

    if (el.id) {
      var forLabel = document.querySelector('label[for="' + cssEscape(el.id) + '"]');
      if (forLabel) pushSignal(out, forLabel.textContent, 1.2);
    }

    var wrap = el.closest('label');
    if (wrap) pushSignal(out, wrap.textContent, 0.95);

    var fs = el.closest('fieldset');
    if (fs) {
      var lg = fs.querySelector('legend');
      if (lg) pushSignal(out, lg.textContent, 0.9);
    }

    pushSignal(out, el.getAttribute('placeholder'), 0.85);
    pushSignal(out, el.getAttribute('name'), 0.9);
    pushSignal(out, el.getAttribute('data-automation-id'), 0.9); // Workday
    pushSignal(out, el.id, 0.8);

    return out;
  }

  // For a radio group the "question" is shared; find it near the group.
  function radioGroupSignals(radios) {
    var out = [];
    var first = radios[0];

    var rg = first.closest('[role="radiogroup"]');
    if (rg) {
      pushSignal(out, rg.getAttribute('aria-label'), 1.1);
      var lb = rg.getAttribute('aria-labelledby');
      if (lb) {
        lb.split(/\s+/).forEach(function (id) {
          var ref = id && document.getElementById(id);
          if (ref) pushSignal(out, ref.textContent, 1.15);
        });
      }
    }

    var fs = first.closest('fieldset');
    if (fs) {
      var lg = fs.querySelector('legend');
      if (lg) pushSignal(out, lg.textContent, 1.1);
    }

    pushSignal(out, first.getAttribute('name'), 0.9);

    var q = nearestQuestion(first);
    if (q) out.push({ text: q, weight: 0.95 });

    return out;
  }

  // Walk up from an element looking for the nearest preceding question text.
  function nearestQuestion(el) {
    var node = el;
    for (var depth = 0; depth < 6 && node; depth++, node = node.parentElement) {
      var sib = node.previousElementSibling;
      var steps = 0;
      while (sib && steps < 4) {
        var t = normalize(sib.textContent);
        if (t && t.length <= 200 && /[a-z]/.test(t)) return t;
        sib = sib.previousElementSibling;
        steps++;
      }
      var parent = node.parentElement;
      if (parent) {
        var cand = parent.querySelector(
          ':scope > legend, :scope > label, :scope > .label, ' +
          ':scope > [class*="label" i], :scope > [class*="question" i]'
        );
        if (cand && !cand.contains(el)) {
          var ct = normalize(cand.textContent);
          if (ct) return ct;
        }
      }
    }
    return '';
  }

  // The option label of a single radio / checkbox (Yes, No, White, ...).
  function optionLabel(input) {
    if (input.id) {
      var l = document.querySelector('label[for="' + cssEscape(input.id) + '"]');
      if (l) return l.textContent;
    }
    var wrap = input.closest('label');
    if (wrap) return wrap.textContent;
    var aria = input.getAttribute('aria-label');
    if (aria) return aria;
    return input.value || '';
  }

  // ---------------------------------------------------------------------------
  // Scoring
  // ---------------------------------------------------------------------------

  // Score how well a set of signals matches one field. Longer / multi-word
  // keywords and higher-weight sources score higher.
  function scoreField(signals, field) {
    var best = 0;
    for (var k = 0; k < field.keywords.length; k++) {
      var nkw = normalize(field.keywords[k]);
      if (!nkw) continue;
      var words = nkw.split(' ').length;
      var specificity = 1 + nkw.length / 10 + (words - 1) * 0.5;
      for (var s = 0; s < signals.length; s++) {
        if (containsPhrase(signals[s].text, nkw)) {
          var score = signals[s].weight * specificity;
          if (score > best) best = score;
        }
      }
    }
    return best;
  }

  // Pick the highest-scoring field for a control.
  function bestField(signals) {
    var best = null;
    var bestScore = 0;
    for (var i = 0; i < FIELDS.length; i++) {
      var sc = scoreField(signals, FIELDS[i]);
      if (sc > bestScore) {
        bestScore = sc;
        best = FIELDS[i];
      }
    }
    return { field: best, score: bestScore };
  }

  // ---------------------------------------------------------------------------
  // Value writing (framework-friendly)
  // ---------------------------------------------------------------------------

  function nativeSetValue(el, value) {
    var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) setter.set.call(el, value);
    else el.value = value;
  }

  function fireInputEvents(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function fillText(el, value) {
    if (el.value && el.value.trim() !== '') return false; // never clobber
    el.focus();
    // Reset React's value tracker so it registers the change.
    if (el._valueTracker) el._valueTracker.setValue('');
    nativeSetValue(el, value);
    fireInputEvents(el);
    el.blur();
    return true;
  }

  function looksLikePlaceholder(text) {
    var t = normalize(text);
    return t === '' || /^(select|choose|please|pick|none|na|n a)\b/.test(t) || /^-+$/.test(t);
  }

  function fillSelect(sel, value) {
    var current = sel.options[sel.selectedIndex];
    var hasChoice = sel.selectedIndex > 0 && sel.value &&
      !looksLikePlaceholder(current ? current.text : '');
    if (hasChoice) return false; // already answered

    var want = normalize(value);
    var match = null;
    for (var i = 0; i < sel.options.length; i++) {
      if (normalize(sel.options[i].text) === want) { match = sel.options[i]; break; }
    }
    if (!match) {
      for (var j = 0; j < sel.options.length; j++) {
        var ot = normalize(sel.options[j].text);
        if (ot && (ot.indexOf(want) !== -1 || (want.length >= 3 && want.indexOf(ot) !== -1))) {
          match = sel.options[j];
          break;
        }
      }
    }
    if (!match) return false;
    nativeSetValue(sel, match.value);
    fireInputEvents(sel);
    return true;
  }

  function fillRadio(radios, value) {
    for (var i = 0; i < radios.length; i++) {
      if (radios[i].checked) return false; // already answered
    }
    var want = normalize(value);
    var target = null;
    for (var a = 0; a < radios.length; a++) {
      if (normalize(optionLabel(radios[a])) === want) { target = radios[a]; break; }
    }
    if (!target) {
      for (var b = 0; b < radios.length; b++) {
        var t = normalize(optionLabel(radios[b]));
        if (t && (t.indexOf(want) !== -1 || (want.length >= 2 && want.indexOf(t) !== -1))) {
          target = radios[b];
          break;
        }
      }
    }
    if (!target) return false;
    if (target.focus) target.focus();
    target.click();
    if (!target.checked) {
      target.checked = true;
      fireInputEvents(target);
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Custom comboboxes (Workday buttons, react-select, Ashby, etc.)
  //
  // These aren't real <select> elements — they open a floating listbox of
  // [role=option] nodes on click. Filling one is async: click to open, poll
  // for options to render, click the best text match. Boxes are processed
  // strictly one at a time so only one dropdown is ever open.
  // ---------------------------------------------------------------------------

  function comboboxText(el) {
    return (el.textContent || el.value || '').trim();
  }

  function collectComboboxes() {
    var sel = 'button[aria-haspopup="listbox"], div[aria-haspopup="listbox"], ' +
      '[role="combobox"]:not(input):not(select)';
    var out = [];
    document.querySelectorAll(sel).forEach(function (el) {
      if (el.closest('.jobfill-fab')) return;
      if (el.getAttribute('aria-disabled') === 'true') return;
      if (!isFillable(el)) return;
      var signals = labelSignals(el);
      var q = nearestQuestion(el);
      if (q) signals.push({ text: q, weight: 0.85 });
      out.push({ el: el, signals: signals });
    });
    return out;
  }

  function waitForOptions(cb) {
    var tries = 0;
    var timer = setInterval(function () {
      var opts = document.querySelectorAll('[role="option"], [role="listbox"] li');
      if (opts.length) {
        clearInterval(timer);
        cb(Array.prototype.slice.call(opts));
      } else if (++tries >= 10) {
        clearInterval(timer);
        cb(null);
      }
    }, 100);
  }

  function matchOption(options, value) {
    var want = normalize(value);
    for (var i = 0; i < options.length; i++) {
      if (normalize(options[i].textContent) === want) return options[i];
    }
    for (var j = 0; j < options.length; j++) {
      var ot = normalize(options[j].textContent);
      if (!ot || looksLikePlaceholder(ot)) continue;
      if (ot.indexOf(want) !== -1 || (want.length >= 3 && want.indexOf(ot) !== -1)) {
        return options[j];
      }
    }
    return null;
  }

  function closeDropdown(el) {
    var esc = { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true };
    el.dispatchEvent(new KeyboardEvent('keydown', esc));
    el.dispatchEvent(new KeyboardEvent('keyup', esc));
  }

  function fillCombobox(el, value) {
    return new Promise(function (resolve) {
      var current = comboboxText(el);
      if (current && !looksLikePlaceholder(current)) return resolve(false); // answered
      el.click();
      waitForOptions(function (options) {
        if (!options) { closeDropdown(el); return resolve(false); }
        var target = matchOption(options, value);
        if (!target) { closeDropdown(el); return resolve(false); }
        target.click();
        // let the widget close/re-render before the next box opens
        setTimeout(function () { resolve(true); }, 150);
      });
    });
  }

  function fillComboboxes(profile) {
    var boxes = collectComboboxes();
    var chain = Promise.resolve(0);
    boxes.forEach(function (box) {
      chain = chain.then(function (count) {
        var match = bestField(box.signals);
        if (!match.field || match.score < MATCH_THRESHOLD) return count;
        var value = profile[match.field.key];
        if (value == null || value === '') return count;
        return fillCombobox(box.el, value).then(function (ok) {
          return count + (ok ? 1 : 0);
        });
      });
    });
    return chain;
  }

  // ---------------------------------------------------------------------------
  // Control collection
  // ---------------------------------------------------------------------------

  var SKIP_INPUT_TYPES = ['hidden', 'submit', 'button', 'reset', 'image', 'file', 'password', 'checkbox'];

  function isFillable(el) {
    if (el.disabled || el.readOnly) return false;
    var style = window.getComputedStyle(el);
    if (!style || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return true;
  }

  function collectControls() {
    var out = [];
    var radioGroups = {};
    var nodes = document.querySelectorAll('input, textarea, select');

    nodes.forEach(function (el) {
      var tag = el.tagName.toLowerCase();
      if (tag === 'input') {
        var type = (el.type || 'text').toLowerCase();
        if (SKIP_INPUT_TYPES.indexOf(type) !== -1) return;
        if (type === 'radio') {
          if (!isFillable(el)) return;
          var key = el.name || ('__anon_' + (el.closest('fieldset') ? 'fs' : 'x'));
          (radioGroups[key] = radioGroups[key] || []).push(el);
          return;
        }
        if (!isFillable(el)) return;
        out.push({ kind: 'text', el: el, signals: labelSignals(el) });
      } else if (tag === 'textarea') {
        if (!isFillable(el)) return;
        out.push({ kind: 'text', el: el, signals: labelSignals(el) });
      } else if (tag === 'select') {
        if (!isFillable(el)) return;
        out.push({ kind: 'select', el: el, signals: labelSignals(el) });
      }
    });

    Object.keys(radioGroups).forEach(function (name) {
      var radios = radioGroups[name];
      out.push({ kind: 'radio', els: radios, signals: radioGroupSignals(radios) });
    });

    return out;
  }

  // ---------------------------------------------------------------------------
  // Fill orchestration
  // ---------------------------------------------------------------------------

  // Derive missing name parts so a form that splits First/Last still fills
  // when the user only entered a Full name (and vice-versa).
  function withDerived(profile) {
    var p = {};
    Object.keys(profile || {}).forEach(function (k) { p[k] = profile[k]; });
    if (!p.firstName && p.fullName) {
      p.firstName = String(p.fullName).trim().split(/\s+/)[0];
    }
    if (!p.lastName && p.fullName) {
      var parts = String(p.fullName).trim().split(/\s+/);
      if (parts.length > 1) p.lastName = parts.slice(1).join(' ');
    }
    if (!p.fullName && (p.firstName || p.lastName)) {
      p.fullName = [p.firstName, p.lastName].filter(Boolean).join(' ');
    }
    return p;
  }

  function doFill(rawProfile) {
    var profile = withDerived(rawProfile);
    var controls = collectControls();
    var filled = 0;

    for (var i = 0; i < controls.length; i++) {
      var c = controls[i];
      var match = bestField(c.signals);
      if (!match.field || match.score < MATCH_THRESHOLD) continue;

      var value = profile[match.field.key];
      if (value == null || value === '') continue;

      var ok = false;
      if (c.kind === 'text') ok = fillText(c.el, value);
      else if (c.kind === 'select') ok = fillSelect(c.el, value);
      else if (c.kind === 'radio') ok = fillRadio(c.els, value);
      if (ok) filled++;
    }
    return filled;
  }

  function runFill() {
    chrome.storage.local.get('profile', function (res) {
      var profile = withDerived(res.profile || {});
      var syncCount = doFill(profile);
      // Async second pass: custom dropdowns (Workday / react-select style).
      fillComboboxes(profile).then(function (comboCount) {
        var count = syncCount + comboCount;
        showToast(count);
        try { chrome.runtime.sendMessage({ type: 'FRAME_RESULT', count: count }); } catch (e) { /* ignore */ }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Toast
  // ---------------------------------------------------------------------------

  function showToast(count) {
    var msg = count > 0
      ? '⚡ Filled ' + count + ' field' + (count === 1 ? '' : 's')
      : 'No new fields matched';
    var el = document.createElement('div');
    el.className = 'jobfill-toast';
    el.textContent = msg;
    (document.body || document.documentElement).appendChild(el);
    requestAnimationFrame(function () { el.classList.add('jobfill-toast--show'); });
    setTimeout(function () {
      el.classList.remove('jobfill-toast--show');
      setTimeout(function () { el.remove(); }, 300);
    }, 2200);
  }

  // ---------------------------------------------------------------------------
  // Floating button (top frame only)
  // ---------------------------------------------------------------------------

  function triggerFillEverywhere() {
    // Ask the background worker to broadcast a fill to every frame in this tab
    // (so an embedded iframe form gets filled too). Fall back to this frame.
    try {
      chrome.runtime.sendMessage({ type: 'FILL_ALL_FRAMES' }, function () {
        if (chrome.runtime.lastError) runFill();
      });
    } catch (e) {
      runFill();
    }
  }

  function makeButton() {
    var btn = document.createElement('button');
    btn.className = 'jobfill-fab';
    btn.type = 'button';
    btn.title = 'JobFill — autofill this application';
    btn.innerHTML = '<span class="jobfill-fab__bolt">⚡</span><span class="jobfill-fab__label">Autofill</span>';

    var dragging = false;
    var moved = false;
    var startX = 0, startY = 0, originLeft = 0, originTop = 0;

    btn.addEventListener('pointerdown', function (e) {
      dragging = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      var rect = btn.getBoundingClientRect();
      originLeft = rect.left;
      originTop = rect.top;
      btn.setPointerCapture(e.pointerId);
      btn.classList.add('jobfill-fab--dragging');
    });

    btn.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      var left = Math.max(4, Math.min(window.innerWidth - btn.offsetWidth - 4, originLeft + dx));
      var top = Math.max(4, Math.min(window.innerHeight - btn.offsetHeight - 4, originTop + dy));
      btn.style.left = left + 'px';
      btn.style.top = top + 'px';
      btn.style.right = 'auto';
      btn.style.bottom = 'auto';
    });

    btn.addEventListener('pointerup', function (e) {
      dragging = false;
      btn.classList.remove('jobfill-fab--dragging');
      try { btn.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      if (!moved) {
        triggerFillEverywhere();
      } else {
        chrome.storage.local.set({ buttonPos: { left: btn.style.left, top: btn.style.top } });
      }
    });

    chrome.storage.local.get('buttonPos', function (res) {
      if (res && res.buttonPos && res.buttonPos.left) {
        btn.style.left = res.buttonPos.left;
        btn.style.top = res.buttonPos.top;
        btn.style.right = 'auto';
        btn.style.bottom = 'auto';
      }
    });

    return btn;
  }

  var buttonAdded = false;
  function ensureButton() {
    if (buttonAdded) return;
    // Only show once the page actually looks like a form.
    var count = document.querySelectorAll(
      'input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select'
    ).length;
    if (count < 3) return;
    if (!document.body) return;
    buttonAdded = true;
    document.body.appendChild(makeButton());
  }

  function watchForForm() {
    ensureButton();
    if (buttonAdded) return;
    var tries = 0;
    var observer = new MutationObserver(function () {
      ensureButton();
      if (buttonAdded && observer) observer.disconnect();
    });
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    }
    // Safety net for slow SPAs (Workday): re-check a few times, then stop.
    var poll = setInterval(function () {
      ensureButton();
      if (buttonAdded || ++tries > 20) {
        clearInterval(poll);
        try { observer.disconnect(); } catch (e) { /* ignore */ }
      }
    }, 1000);
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.type === 'FILL') runFill();
  });

  var isTopFrame = window.top === window;
  if (isTopFrame) {
    chrome.storage.local.get('settings', function (res) {
      var settings = (res && res.settings) || {};
      if (settings.showFab === false) return; // user turned the button off
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', watchForForm);
      } else {
        watchForForm();
      }
    });
  }
})();
