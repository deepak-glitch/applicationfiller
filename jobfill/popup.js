/*
 * JobFill popup — profile editor + settings.
 *
 * Builds the Profile tab from the shared schema (fields.js): one collapsible
 * card per group with a filled-count badge, paired rows for compact fields,
 * and a completeness bar in the header. Autosaves (debounced) to
 * chrome.storage.local. The Settings tab holds the floating-button toggle,
 * Export/Import, and Clear.
 */
(function () {
  'use strict';

  var GROUPS = window.FIELD_GROUPS || [];
  var formEl = document.getElementById('form');
  var saveState = document.getElementById('saveState');
  var fillResult = document.getElementById('fillResult');
  var progressBar = document.getElementById('progressBar');
  var progressText = document.getElementById('progressText');

  // Fields rendered side by side (both keys must be in the same group).
  var PAIRS = { firstName: 'lastName', city: 'state', zip: 'country' };

  var inputs = {};       // key -> control element
  var groupEls = [];     // { badge, keys }

  // --- Build the Profile tab -------------------------------------------------

  GROUPS.forEach(function (group, gi) {
    var details = document.createElement('details');
    details.className = 'group';
    if (gi === 0) details.open = true;

    var summary = document.createElement('summary');
    summary.innerHTML =
      '<span class="group__icon"></span>' +
      '<span class="group__name"></span>' +
      '<span class="group__badge"></span>' +
      '<span class="group__chev">▶</span>';
    summary.querySelector('.group__icon').textContent = group.icon || '📄';
    summary.querySelector('.group__name').textContent = group.group;
    var badge = summary.querySelector('.group__badge');
    details.appendChild(summary);

    var body = document.createElement('div');
    body.className = 'group__body';
    if (group.hint) {
      var hint = document.createElement('p');
      hint.className = 'group__hint';
      hint.textContent = group.hint;
      body.appendChild(hint);
    }

    var keys = [];
    var skip = {};
    group.fields.forEach(function (field, fi) {
      if (skip[field.key]) return;
      var partnerKey = PAIRS[field.key];
      var partner = partnerKey && group.fields.find(function (f) { return f.key === partnerKey; });
      if (partner) {
        var row = document.createElement('div');
        row.className = 'row';
        row.appendChild(buildField(field));
        row.appendChild(buildField(partner));
        skip[partnerKey] = true;
        body.appendChild(row);
        keys.push(field.key, partnerKey);
      } else {
        body.appendChild(buildField(field));
        keys.push(field.key);
      }
    });

    details.appendChild(body);
    formEl.appendChild(details);
    groupEls.push({ badge: badge, keys: keys });
  });

  function buildField(field) {
    var wrap = document.createElement('div');
    wrap.className = 'field';

    var label = document.createElement('label');
    label.textContent = field.label;
    label.setAttribute('for', 'jf_' + field.key);
    wrap.appendChild(label);

    var control;
    if (field.type === 'choice') {
      control = document.createElement('select');
      var blank = document.createElement('option');
      blank.value = '';
      blank.textContent = '— skip —';
      control.appendChild(blank);
      (field.choices || []).forEach(function (choice) {
        var opt = document.createElement('option');
        opt.value = choice;
        opt.textContent = choice;
        control.appendChild(opt);
      });
    } else {
      control = document.createElement('input');
      control.type = field.type === 'email' ? 'email'
        : field.type === 'tel' ? 'tel'
          : field.type === 'url' ? 'url' : 'text';
      control.placeholder = field.label;
    }
    control.id = 'jf_' + field.key;
    control.dataset.key = field.key;
    inputs[field.key] = control;

    control.addEventListener('input', onEdit);
    control.addEventListener('change', onEdit);

    wrap.appendChild(control);
    return wrap;
  }

  // --- Completeness + badges ---------------------------------------------------

  // Self-ID is optional by design, so it doesn't count against completeness.
  var OPTIONAL_GROUPS = ['Self-identification'];

  function refreshMeters() {
    var total = 0;
    var filled = 0;
    GROUPS.forEach(function (group, gi) {
      var gKeys = groupEls[gi].keys;
      var gFilled = gKeys.filter(function (k) { return inputs[k].value.trim() !== ''; }).length;
      var b = groupEls[gi].badge;
      b.textContent = gFilled + '/' + gKeys.length;
      b.className = 'group__badge' + (gFilled === gKeys.length ? ' group__badge--full' : '');
      if (OPTIONAL_GROUPS.indexOf(group.group) === -1) {
        total += gKeys.length;
        filled += gFilled;
      }
      gKeys.forEach(function (k) {
        var el = inputs[k];
        if (el.tagName === 'SELECT') el.classList.toggle('has-value', el.value !== '');
      });
    });
    var pct = total ? Math.round((filled / total) * 100) : 0;
    progressBar.style.width = pct + '%';
    progressText.textContent = pct + '%';
  }

  // --- Load / save ----------------------------------------------------------

  var savedAnswers = {};

  var saveTimer = null;
  function onEdit() {
    saveState.textContent = 'Saving…';
    refreshMeters();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 300);
  }

  function currentProfile() {
    var profile = {};
    Object.keys(inputs).forEach(function (key) {
      var v = inputs[key].value.trim();
      if (v) profile[key] = v;
    });
    return profile;
  }

  function saveNow() {
    chrome.storage.local.set({ profile: currentProfile() }, function () {
      saveState.textContent = 'Saved ✓';
      setTimeout(function () {
        if (saveState.textContent === 'Saved ✓') saveState.textContent = '';
      }, 1200);
    });
  }

  // --- Saved answers tab -------------------------------------------------------

  var answersList = document.getElementById('answersList');
  var answersEmpty = document.getElementById('answersEmpty');
  var answersBadge = document.getElementById('answersBadge');
  var clearAnswersBtn = document.getElementById('clearAnswersBtn');

  function persistAnswers() {
    chrome.storage.local.set({ savedAnswers: savedAnswers });
  }

  function renderAnswers() {
    answersList.textContent = '';
    var keys = Object.keys(savedAnswers).sort();
    answersEmpty.hidden = keys.length > 0;
    clearAnswersBtn.hidden = keys.length === 0;
    answersBadge.hidden = keys.length === 0;
    answersBadge.textContent = String(keys.length);

    keys.forEach(function (q) {
      var card = document.createElement('div');
      card.className = 'answer';

      var head = document.createElement('div');
      head.className = 'answer__head';
      var qEl = document.createElement('div');
      qEl.className = 'answer__q';
      qEl.textContent = q;
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'answer__del';
      del.title = 'Forget this answer';
      del.textContent = '✕';
      del.addEventListener('click', function () {
        delete savedAnswers[q];
        persistAnswers();
        renderAnswers();
      });
      head.appendChild(qEl);
      head.appendChild(del);

      var input = document.createElement('input');
      input.type = 'text';
      input.value = savedAnswers[q];
      input.addEventListener('change', function () {
        var v = input.value.trim();
        if (v) {
          savedAnswers[q] = v;
        } else {
          delete savedAnswers[q];
        }
        persistAnswers();
        if (!v) renderAnswers();
      });

      card.appendChild(head);
      card.appendChild(input);
      answersList.appendChild(card);
    });
  }

  clearAnswersBtn.addEventListener('click', function () {
    if (clearAnswersBtn.dataset.armed !== '1') {
      clearAnswersBtn.dataset.armed = '1';
      clearAnswersBtn.textContent = 'Click again to forget everything';
      setTimeout(function () {
        clearAnswersBtn.dataset.armed = '';
        clearAnswersBtn.textContent = 'Clear all answers';
      }, 3000);
      return;
    }
    clearAnswersBtn.dataset.armed = '';
    clearAnswersBtn.textContent = 'Clear all answers';
    savedAnswers = {};
    persistAnswers();
    renderAnswers();
  });

  // --- Tabs ------------------------------------------------------------------

  var TABS = [
    { btn: document.getElementById('tabProfile'), panel: document.getElementById('panelProfile'), name: 'profile' },
    { btn: document.getElementById('tabAnswers'), panel: document.getElementById('panelAnswers'), name: 'answers' },
    { btn: document.getElementById('tabSettings'), panel: document.getElementById('panelSettings'), name: 'settings' },
  ];

  function selectTab(which) {
    TABS.forEach(function (t) {
      var active = t.name === which;
      t.btn.classList.toggle('tabs__tab--active', active);
      t.btn.setAttribute('aria-selected', String(active));
      t.panel.hidden = !active;
    });
  }
  TABS.forEach(function (t) {
    t.btn.addEventListener('click', function () { selectTab(t.name); });
  });

  // --- Settings ---------------------------------------------------------------

  document.getElementById('showFab').addEventListener('change', function (e) {
    chrome.storage.local.get('settings', function (res) {
      var settings = res.settings || {};
      settings.showFab = e.target.checked;
      chrome.storage.local.set({ settings: settings });
    });
  });

  document.getElementById('clearBtn').addEventListener('click', function (e) {
    var btn = e.target;
    if (btn.dataset.armed !== '1') {
      btn.dataset.armed = '1';
      btn.textContent = 'Click again to erase everything';
      setTimeout(function () {
        btn.dataset.armed = '';
        btn.textContent = 'Clear profile';
      }, 3000);
      return;
    }
    btn.dataset.armed = '';
    btn.textContent = 'Clear profile';
    Object.keys(inputs).forEach(function (key) { inputs[key].value = ''; });
    chrome.storage.local.set({ profile: {} }, refreshMeters);
  });

  // --- Fill current page ----------------------------------------------------

  var fillBtn = document.getElementById('fillBtn');
  var fillBtnText = document.getElementById('fillBtnText');
  var boltEl = fillBtn.querySelector('.btn__bolt');

  fillBtn.addEventListener('click', function () {
    fillResult.className = 'fillresult';
    fillResult.textContent = '';
    fillBtn.disabled = true;
    fillBtnText.textContent = 'Filling…';
    boltEl.innerHTML = '<span class="spin"></span>';
    saveNow();

    function done(text, ok) {
      fillBtn.disabled = false;
      fillBtnText.textContent = 'Fill current page';
      boltEl.textContent = '⚡';
      fillResult.className = 'fillresult' + (ok ? ' fillresult--ok' : '');
      fillResult.textContent = text;
    }

    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tab = tabs && tabs[0];
      if (!tab) return done('No active tab.', false);
      chrome.runtime.sendMessage({ type: 'FILL_TAB', tabId: tab.id }, function (resp) {
        if (chrome.runtime.lastError) {
          return done('Can’t run on this page — open a job application and try again.', false);
        }
        var n = resp && resp.count ? resp.count : 0;
        if (n > 0) done('Filled ' + n + ' field' + (n === 1 ? '' : 's') + ' — review before submitting.', true);
        else done('No new fields matched on this page.', false);
      });
    });
  });

  // --- Export / Import ------------------------------------------------------

  document.getElementById('exportBtn').addEventListener('click', function () {
    var data = JSON.stringify({ profile: currentProfile(), savedAnswers: savedAnswers }, null, 2);
    var blob = new Blob([data], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'jobfill-profile.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });

  var importFile = document.getElementById('importFile');
  document.getElementById('importBtn').addEventListener('click', function () {
    importFile.click();
  });
  importFile.addEventListener('change', function () {
    var file = importFile.files && importFile.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        if (!data || typeof data !== 'object') throw new Error('bad');
        // New format: { profile, savedAnswers }. Old format: flat profile map.
        var profile = (data.profile && typeof data.profile === 'object') ? data.profile : data;
        Object.keys(inputs).forEach(function (key) {
          inputs[key].value = profile[key] != null ? profile[key] : '';
        });
        if (data.savedAnswers && typeof data.savedAnswers === 'object') {
          savedAnswers = data.savedAnswers;
          persistAnswers();
          renderAnswers();
        }
        saveNow();
        refreshMeters();
        selectTab('profile');
        saveState.textContent = 'Imported ✓';
      } catch (e) {
        saveState.textContent = 'Invalid file';
      }
      importFile.value = '';
    };
    reader.readAsText(file);
  });

  // --- Initial load (last, so every element/function above is ready) ---------

  chrome.storage.local.get(['profile', 'settings', 'savedAnswers'], function (res) {
    var profile = res.profile || {};
    Object.keys(inputs).forEach(function (key) {
      if (profile[key] != null) inputs[key].value = profile[key];
    });
    var settings = res.settings || {};
    document.getElementById('showFab').checked = settings.showFab !== false;
    savedAnswers = res.savedAnswers || {};
    refreshMeters();
    renderAnswers();
  });
})();
