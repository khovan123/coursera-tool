# Coursera Tool

Manifest V3 browser extension for local Coursera video automation and optional Gemini-assisted assessment filling.

## Repository layout

```text
apps/
  extension/       Browser extension source and build tooling
    src/
      background/  Service worker and external API boundary
      content/     Coursera page automation
      popup/       Extension controls and status UI
    scripts/       Dependency-free build script
    dist/          Generated unpacked extension
  site/            Static project information page
data/
  course-map.json  Legacy course mapping reference data
```

## Commands

Run commands from the repository root:

```bash
npm run check
npm run build
```

After building, load `apps/extension/dist` from `chrome://extensions` using **Load unpacked**.

## Runtime boundaries

- The course runner opens lessons, skips video or audio media, and advances through non-assessment items locally in the browser.
- Quiz answering is a separate manual action and pauses the course runner.
- Gemini is the only external API and is called only for answer generation.
- The project contains no payment, subscription, advertising, or analytics integration.

See [`apps/extension/README.md`](apps/extension/README.md) for extension-specific details.
