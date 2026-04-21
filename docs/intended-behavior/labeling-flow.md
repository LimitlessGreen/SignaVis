# Intended behavior — Labeling flow & value propagation

This document describes the intended flow when creating, editing, and importing labels in the Labeling App, and the rules for propagating `scientificName`, `tags`, `color` and related fields.

Purpose
- Provide a single source of expectation for UI developers and testers.
- Serve as the basis for acceptance criteria and automated tests.

Participating components
- Topbar Species Search ("Species Bar" / Top Search Widget)
- Drag & Drop / drawing on the spectrogram (creating a new label)
- Label Editor Modal (search/pick palette with tags/color/save)
- Internal helper: `_getReferenceLabelForDefaults()` (reference label for defaults)
- Label fields: `label` (common name), `scientificName`, `color`, `tags`, `origin`, `author`, `commonName`, etc.

Principles
1. Explicit selection in the topbar takes precedence: if a species is selected in the topbar, creating a label via drag will immediately create the new label with those values — no modal.
2. If the topbar is empty, the Label Editor (modal) opens and is prefilled with sensible defaults (see reference rules).
3. Suggestions (taxonomy/pool) may provide additional metadata (scientific name, detail badges, tags, color). These are applied to fields only when the user actively selects a suggestion.
4. If the user saves the modal without making any additional selection, all initially provided default values must be preserved (e.g. `initialScientificName`).
5. Manual edits in input fields (typing) invalidate previously selected suggestion metadata (e.g. `scientificName`) and clear it until the user selects again.

Detailed flow (scenarios)

A. New label by drag with topbar selection
- Precondition: topbar has a confirmed selection `S = { name, color, scientificName, tags }`.
- Action: user draws a region → system:
	- `region.label = S.name`
	- `region.color = S.color || colorForName(S.name)`
	- `region.scientificName = S.scientificName || ''`
	- `region.tags = S.tags || {}`
	- The label is added without opening the modal.
- Expectation: the modal must not appear.

B. New label by drag when topbar is empty (modal path)
- Precondition: topbar is empty.
- Action: user draws a region → system:
 1. Determine reference defaults: `ref = _getReferenceLabelForDefaults()` (priority: explicit stampRef → focused label → last label).
 2. Prefill the modal with:
		- `initialValue = ref?.label || ''`
		- `initialColor = ref?.color || _autoAssignColor(...)`
		- `initialTags = ref?.origin === 'xeno-canto' ? null : ref?.tags || {}`
		- `initialScientificName = ref?.scientificName || ''`  ← important
 3. Open the modal and wait for `Save`.
- Save rules in the modal:
	- If the user selects a suggestion: suggestion `scientificName` and suggestion `tags` are stored in `selectedScientificName` / `currentTags`.
	- If the user makes no changes and clicks `Save`: `scientificName` remains `initialScientificName`.
	- If the user types into the input (input event): `selectedScientificName` is cleared (design decision), because free text invalidates the selection.
	- Tag merging: `tags = { ...initialTags, ...suggestion.tags }` (suggestion tags override initialTags for the same keys).
	- Color: if the name changed and the color was not manually adjusted by the user, then `color = colorForName(name)` (deterministic).

C. Modal suggestion — Double-click vs Click+Save
- `Click` on a suggestion: fills fields (name, color, selectedScientificName, tags) — modal remains open; user can edit further and then `Save`.
- `Double-click` on a suggestion: selects and submits immediately (equivalent to select + `Save`).

D. Rename (editing a single label)
- `_renameSpectrogramLabelPrompt(id)` opens the modal prefilled with the label data including `scientificName`.
- Save: updates `label`, `color`, `tags`. `scientificName` is preserved if `selectedScientificName` or `initialScientificName` is non-empty.
- If `scientificName` is left empty and the user explicitly saves an empty value, the existing `scientificName` should be removed (bulk rename follows the same behavior).

E. Bulk rename
- The modal initializes with the first selected label as default (including `initialScientificName`).
- Save applied to all selected labels:
	- `label`, `color` are set.
	- `scientificName` is set if non-empty; if empty → remove `scientificName` (explicit clearing deletes the value).

F. Xeno-canto import / XC sets
- For reference values from XC (origin === 'xeno-canto'):
	- `scientificName` and `commonName` may be inherited.
	- XC-specific `tags` (annotator, author, remarks) and `author` should not be automatically copied onto new manual labels. When stamping/copying, `author` should be left empty and `tags` set to {}.

G. Stamp / copy / paste
- `copyLabel()` stores a copy including `scientificName`.
- `pasteLabel()` creates a new label and copies `scientificName` (if present).
- When stamping from an XC reference, XC metadata (author, annotator) are not copied, but `scientificName` is.

Design decisions (concrete rules)
- `initialScientificName` must be passed when opening the modal so that `Save` without further user action does not lose the value (this fix has been implemented in code).
- Manual input clears any previously bound `scientificName`, since free text indicates a new designation.
- Suggestion tags override or extend existing preset tags.
- Color is recomputed via `colorForName` only when the name changed and color was not manually adjusted.

Acceptance criteria / test cases (short)
1. Topbar selected → drag → label inherits `name`, `scientificName`, `color`, `tags` → no modal.
2. Topbar empty → drag → modal opens with `initialScientificName = ref.scientificName` → `Save` without changes → `scientificName` remains. (Automated test exists: `tests/label-editor.scientificname.test.mjs`)
3. Modal opened with defaults → user clicks suggestion → `scientificName` updated → `Save` → `scientificName` adopted.
4. Modal opened with defaults → user types new input → `scientificName` cleared on `input` → `Save` → `scientificName` empty (unless re-selected).
5. XC reference stamp → `scientificName` & `commonName` adopted, `tags` and `author` not copied.
6. Bulk rename: `Save` with empty scientificName → removes `scientificName` in all affected labels.

Example user story (your original scenario)
1. User searches "thrush" in the topbar and selects a suggestion (with `scientificName = Turdus merula`).
2. User draws a label on the spectrogram → label receives `scientificName = Turdus merula` (no modal).
3. User clears the topbar and draws again → modal opens, prefilled from reference (last label): `initialScientificName = Turdus merula`.
4. User clicks `Save` without further selection → new label still receives `scientificName = Turdus merula`.

Open items / recommendations for developers
- Modal accessibility: ensure modal focus trap and `inert` on background content are implemented correctly.
- Tests: add tests for edge cases (manual input clears `scientificName`, double-click vs save, color auto-assign).
- Documentation: link this file from the main README or a test FAQ so testers know which scenarios to verify.

---

Date: (generated automatically)
