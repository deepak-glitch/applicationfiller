# JobFill — Application Autofiller

A Chrome extension that fills the fields you retype on every job application —
name, email, phone, links, work authorization, self-ID — in one click, on any
careers site (Workday, Greenhouse, Lever, Ashby, iCIMS, etc.).

## Install (unpacked, ~30 sec)

1. Unzip / keep this `jobfill` folder somewhere permanent (don't delete it
   after — Chrome loads the extension from wherever it lives).
2. Go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select this `jobfill` folder.
5. Pin the ⚡ JobFill icon from the puzzle-piece menu (optional).

Works in any Chromium browser — Chrome, Edge, Brave, Arc.

## Use

1. Click the ⚡ icon → fill in your profile once on the **Profile** tab. It
   autosaves as you type, and the header bar shows how complete your profile is.
2. On a job application page, either:
   * click **Fill current page** in the popup, or
   * click the floating **⚡ Autofill** button (bottom-right of the page — drag
     it anywhere, or turn it off in Settings).
3. It fills every field it recognizes. It only writes to **empty** fields, so
   it never clobbers anything you've already typed. Review before submitting.

**Saved answers:** when you type an answer into a question JobFill doesn't
know (e.g. "Why do you want to work here?"), it remembers it automatically —
and fills it the next time the *exact same question* appears on any
application. The **Answers** tab lists everything remembered; edit an answer
inline, forget one with ✕, or clear them all. Clearing the field on the page
also forgets its saved answer.

The **Settings** tab has the floating-button toggle, **Export / Import**
(JSON backup of your profile *and* saved answers), and **Clear profile**.

## How matching works

`fields.js` defines each profile field with a list of keywords. The content
script reads each form field's label, `name`, `id`, `placeholder`, and
`aria-label` (plus Workday's `data-automation-id`), normalizes them
(camelCase / snake_case → words), and picks the best keyword match. Yes/No and
self-ID questions are matched on radio-button and dropdown option text.

Custom (non-`<select>`) dropdowns — Workday's `aria-haspopup="listbox"`
buttons, react-select-style comboboxes — are handled in a second async pass:
JobFill clicks the widget open, waits for its `role="option"` list to render,
and clicks the option whose text matches your answer, one dropdown at a time.

Unique questions that don't match the schema fall back to your saved answers,
keyed on the exact (normalized) question text. Answers are captured from a
page-level `change` listener — only for fields that *don't* match the profile
schema, never for passwords/files/checkboxes, and never from JobFill's own
writes.

If you enter only a **Full name**, JobFill still fills split First/Last fields
(and vice-versa).

## Tune it

* **Add a field:** add an entry to the right group in `fields.js` (`key`,
  `label`, `type`, `keywords`, and `choices` for dropdowns). The popup form and
  the engine both pick it up automatically.
* **A field isn't matching:** add the exact wording that site uses to that
  field's `keywords` array, then reload the extension (`chrome://extensions` →
  the ↻ on the JobFill card).

## Notes & limits

* Self-ID fields (gender, veteran, disability) start blank. Fill them only if
  you want them auto-answered; leaving them empty means JobFill skips them.
* It does **not** tick consent/certification checkboxes — those are on you.
* Everything is stored locally in `chrome.storage.local`. Nothing leaves your
  browser; there's no server and no network call.
* Some multi-step Workday flows load fields as you advance — click Autofill
  again on each step.
* Native inputs, textareas, `<select>` dropdowns, radio groups, and custom
  listbox comboboxes (Workday-style) are supported. An exotic widget that
  exposes no `role="option"` items may still need a manual pick.

## Files

```
manifest.json   extension manifest (MV3)
fields.js       shared field schema (keywords) — edit this to tune matching
content.js      matching + fill engine (runs on pages, incl. iframes)
content.css     floating button + toast styles
background.js   service worker — relays "fill" across frames, tallies results
popup.html/js/css   the profile editor
icons/          extension icons
```

## Privacy

100% local. Your profile lives in `chrome.storage.local` on your machine. The
extension makes no network requests and has no analytics.
