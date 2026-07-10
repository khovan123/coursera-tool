# Coursera Tool extension

## Build

```bash
npm run check
npm run build
```

Load `apps/extension/dist` as an unpacked extension from `chrome://extensions`.

The popup automatically injects the content script when a Coursera tab does not yet have a message receiver. Site access covers `coursera.org` and all HTTPS Coursera subdomains.

Use **Start course runner** to open the next incomplete lesson, skip video or audio media to its end, and advance to the next item. The runner skips assessments without calling the LLM. Assessment filling remains a separate manual action and requires a Gemini API key; starting it pauses the course runner.

When no video or audio is present, the runner verifies that the page is a reading, including Coursera `/supplement/` readings and `/ungradedWidget/` plugins. It clicks **Mark as complete/completed**, waits for Coursera to update the item, and only then advances to the next item.

For external app/LTI/lab items, the runner checks every required checkbox in the main activity area, waits for **Launch App** or the corresponding external link to become enabled, opens it, waits briefly, and then advances to the next Coursera item.

Proctored `assignment-submission` items and `locked-browser-start` pages are detected and left for manual completion in Coursera's locking browser. The extension does not bypass proctoring or run its assessment assistant inside a locked-browser flow.

## Network and privacy

- Video automation, page scanning, answer matching, form filling, and navigation run locally in the browser.
- Assessment text is sent only to the configured Gemini API when answer generation is requested.
- The extension has no payment, subscription, advertising, analytics, or other external API integration.
