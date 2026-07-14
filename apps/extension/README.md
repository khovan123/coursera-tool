# Coursera Tool extension

## Build

```bash
npm run check
npm run build
```

Load `apps/extension/dist` as an unpacked extension from `chrome://extensions`.

## Install from GitHub Release

1. Open the GitHub Pages download page: `https://khovan123.github.io/coursera-tool/`.
2. Click **Tải bản mới nhất** to download the latest release zip.
3. Extract the zip file.
4. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the extracted folder.

The popup automatically injects the content script when a Coursera tab does not yet have a message receiver. Site access covers `coursera.org` and all HTTPS Coursera subdomains.

Use **Start course runner** to open the next incomplete lesson, skip video or audio media to its end, and advance to the next item. By default, assessments are skipped and the runner looks for the next runnable course item after the current item in the course outline, opening later collapsed modules when needed. Enable **Open quizzes for manual completion** to let the runner open quiz pages from the course outline before pausing.

When no video or audio is present, the runner verifies that the page is a reading, including Coursera `/supplement/` readings and `/ungradedWidget/` plugins. It clicks **Mark as complete/completed**, waits for Coursera to update the item, and only then advances to the next item.

For external app/LTI/lab items, the runner checks every required checkbox in the main activity area, waits for **Launch App** or the corresponding external link to become enabled, opens it, waits briefly, and then advances to the next Coursera item.

Proctored `assignment-submission` items and `locked-browser-start` pages are left for manual completion in Coursera's locking browser. The extension does not bypass proctoring or answer assessments.

## Network and privacy

- Video automation, page scanning, and navigation run locally in the browser.
- The extension does not generate answers, fill assessment forms, submit assessments, or send assessment text to an AI service.
- The extension has no payment, subscription, advertising, analytics, or other external API integration.
