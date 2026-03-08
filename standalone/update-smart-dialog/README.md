# Update Smart Dialog (Standalone)

This folder contains the extracted update smart dialog from AppManager in a reusable standalone format.

## Files

- `update-smart-dialog.html`
  - Original dialog markup block (copied from `index.html`).
- `update-smart-dialog.css`
  - Original update dialog styling block (copied from `styles.css`).
- `update-smart-dialog.js`
  - Standalone controller API exposed as `window.UpdateSmartDialog`.
- `demo.html`
  - Working demo page for checking/available/downloading/installing states.

## Quick Integration

1. Copy this folder into your target project.
2. Include Font Awesome (optional but recommended for icon classes used by defaults).
3. Include CSS and JS:

```html
<link rel="stylesheet" href="/path/to/update-smart-dialog.css" />
<script src="/path/to/update-smart-dialog.js"></script>
```

4. Add markup in either way:

- Option A: Paste `update-smart-dialog.html` near the end of `<body>`.
- Option B: Skip manual HTML and let JS inject it automatically (`UpdateSmartDialog.mount()` or first `show()` call).

5. Open the dialog:

```js
await UpdateSmartDialog.show({
  mode: 'progress',
  title: 'Installing Update',
  subtitle: 'Restarting app to finish installation.',
  detail: 'The app will close and relaunch automatically.',
  version: 'v1.1.0',
  channel: 'stable',
  checkedAt: new Date().toISOString(),
  progress: 100,
  progressLabel: 'Preparing restart...',
  dismissible: false,
  allowEscape: false,
  allowEmptyActions: true,
  actions: []
});
```

## API

- `UpdateSmartDialog.mount()`
- `UpdateSmartDialog.show(options)` -> `Promise<string>`
- `UpdateSmartDialog.close(result?)`
- `UpdateSmartDialog.setProgress(progress, label?)`
- `UpdateSmartDialog.isActive()` -> `boolean`

`show(options)` supports:

- `mode`: `info | success | warning | danger | progress`
- `context`: free-form string
- `title`, `subtitle`, `detail`
- `iconHtml`
- `version`, `channel`, `checkedAt`
- `progress` (number or `null` for indeterminate), `progressLabel`
- `notes`: string or string[]
- `actions`: `{ label, value, variant, icon, disabled }[]`
- `dismissible`, `allowEscape`, `dismissOnBackdrop`, `allowEmptyActions`
