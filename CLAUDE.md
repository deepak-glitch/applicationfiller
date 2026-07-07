# applicationfiller — JobFill

Chrome extension (Manifest V3) that autofills job applications. All extension
code lives in `jobfill/` — load it unpacked from `chrome://extensions`.

Work directly on `main` — do not create feature branches (owner's standing
instruction).

## Architecture

- `jobfill/fields.js` — shared field schema (groups → fields with `key`,
  `label`, `type`, `keywords`, `choices`). Consumed by both the popup editor
  and the content-script engine; add fields here and both pick them up.
- `jobfill/content.js` — matching + fill engine, runs in all frames. Scores
  each control's label/name/id/placeholder/aria-label/data-automation-id
  against the schema; fills only empty fields. Handles text, native selects,
  radio groups, and custom comboboxes (Workday `aria-haspopup="listbox"`
  buttons, react-select-style `role="combobox"` widgets) via an async
  click → wait for `role="option"` → click-match pass.
- `jobfill/background.js` — service worker; broadcasts FILL to all frames of a
  tab and aggregates per-frame filled counts for the popup.
- `jobfill/popup.*` — profile editor (tabs: Profile / Settings, completeness
  bar, collapsible groups, autosave, JSON export/import).
- Storage keys in `chrome.storage.local`: `profile` (flat key → value),
  `settings` (`{ showFab }`), `buttonPos`.

## Testing

No test framework in-repo. Scratchpad harnesses used during development:
a keyword-matching battery against the real `fields.js`, and a jsdom
end-to-end test that injects the real `fields.js` + `content.js` into
synthetic Greenhouse/Workday-style forms and asserts on actual DOM writes
(stub `chrome.*`, stub `getBoundingClientRect` since jsdom has no layout,
and note the floating button appears on DOMContentLoaded, i.e. async).

## Roadmap

### v2 — auto-attach company-specific resumes (NOT STARTED — begin only when
the owner says "let's start working on v2")

The owner downloads tailored resumes from a website and saves them in a folder
on their system. **Each resume filename starts with the company name.** v2
should:

1. Detect the company from the job application page (hostname, page title,
   ATS URL patterns like `boards.greenhouse.io/<company>`,
   `<company>.wd5.myworkdayjobs.com`, `jobs.lever.co/<company>`).
2. Find the resume in the owner's resume folder whose filename starts with
   that company name (fallback: fuzzy/closest match, or a default resume).
3. Auto-attach it to the application's resume-upload field (DataTransfer +
   `File` injection into `input[type=file]`, plus drag-drop simulation for
   custom dropzones).

Implementation notes gathered ahead of time: MV3 extensions cannot read
arbitrary local folders directly; options are (a) File System Access API —
user picks the folder once via `showDirectoryPicker()` from the popup/options
page and the handle is persisted in IndexedDB, or (b) a tiny local companion
server / native messaging host. Option (a) is preferred — no installs, stays
fully local.
