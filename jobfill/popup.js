/*
 * JobFill popup — the profile editor.
 *
 * Builds the form from the shared schema (fields.js), loads/saves the profile
 * to chrome.storage.local (autosave, debounced), and wires the Fill / Export /
 * Import buttons.
 */
(function () {
  'use strict';

  var GROUPS = window.FIELD_GROUPS || [];
  var formEl = document.getElementById('form');
  var saveState = document.getElementById('saveState');
  var fillResult = document.getElementById('fillResult');

  var inputs = {}; // key -> element

  // --- Build the form -------------------------------------------------------

  GROUPS.forEach(function (group) {
    var section = document.createElement('section');
    section.className = 'group';

    var title = document.createElement('div');
    title.className = 'group__title';
    title.textContent = group.group;
    section.appendChild(title);

    group.fields.forEach(function (field) {
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
        blank.textContent = '—';
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

      control.addEventListener('input', scheduleSave);
      control.addEventListener('change', scheduleSave);

      wrap.appendChild(control);
      section.appendChild(wrap);
    });

    formEl.appendChild(section);
  });

  // --- Load / save ----------------------------------------------------------

  chrome.storage.local.get('profile', function (res) {
    var profile = res.profile || {};
    Object.keys(inputs).forEach(function (key) {
      if (profile[key] != null) inputs[key].value = profile[key];
    });
  });

  var saveTimer = null;
  function scheduleSave() {
    saveState.textContent = 'Saving…';
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

  // --- Fill current page ----------------------------------------------------

  document.getElementById('fillBtn').addEventListener('click', function () {
    fillResult.className = 'fillresult';
    fillResult.textContent = 'Filling…';
    saveNow();
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tab = tabs && tabs[0];
      if (!tab) { fillResult.textContent = 'No active tab.'; return; }
      chrome.runtime.sendMessage({ type: 'FILL_TAB', tabId: tab.id }, function (resp) {
        if (chrome.runtime.lastError) {
          fillResult.textContent = 'Can’t run on this page. Open a job application and try again.';
          return;
        }
        var n = resp && resp.count ? resp.count : 0;
        if (n > 0) {
          fillResult.className = 'fillresult fillresult--ok';
          fillResult.textContent = 'Filled ' + n + ' field' + (n === 1 ? '' : 's') + '. Review before submitting.';
        } else {
          fillResult.textContent = 'No new fields matched on this page.';
        }
      });
    });
  });

  // --- Export / Import ------------------------------------------------------

  document.getElementById('exportBtn').addEventListener('click', function () {
    var data = JSON.stringify(currentProfile(), null, 2);
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
        Object.keys(inputs).forEach(function (key) {
          inputs[key].value = data[key] != null ? data[key] : '';
        });
        saveNow();
        fillResult.className = 'fillresult fillresult--ok';
        fillResult.textContent = 'Profile imported.';
      } catch (e) {
        fillResult.className = 'fillresult';
        fillResult.textContent = 'That file isn’t a valid JobFill profile.';
      }
      importFile.value = '';
    };
    reader.readAsText(file);
  });
})();
