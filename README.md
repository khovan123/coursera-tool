# Coursera Tool

Manifest V3 browser extension for local Coursera video automation and optional manual quiz entry.

## Repository layout

```text
apps/
  extension/       Browser extension source and build tooling
    src/
      background/  Extension defaults
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

## GitHub Pages and releases

This repository includes GitHub Actions workflows for the public download page and extension release artifacts.

### One-time GitHub setup

1. Push the repository to GitHub.
2. Open **Settings > Pages**.
3. Set **Source** to **GitHub Actions**.
4. Open **Settings > Actions > General** and allow workflows to create and approve pull requests only if your organization policy requires it. The release workflow only needs the default `GITHUB_TOKEN` with `contents: write`, declared in the workflow.

### Publish the download page

The `Deploy GitHub Pages` workflow deploys `apps/site` when files in that folder change on `main`. You can also run it manually from **Actions > Deploy GitHub Pages > Run workflow**.

After deployment, the page will be available at:

```text
https://khovan123.github.io/coursera-tool/
```

The page automatically checks the latest GitHub Release and points the download button to the latest `.zip` asset.

### Create a release build

Use either option:

```bash
git tag v2.0.0
git push origin v2.0.0
```

Or run **Actions > Build Extension Release > Run workflow** and enter a version tag such as `v2.0.0`.

The release workflow runs `npm run check`, builds `apps/extension/dist`, creates `coursera-tool-extension-<tag>.zip`, and publishes it to GitHub Releases. The manual workflow also creates and pushes the tag if it does not already exist.

## Runtime boundaries

- The course runner opens lessons, skips video or audio media, and advances through course items locally in the browser.
- Quiz answering is manual. By default the runner skips quizzes and continues with the next runnable course item. When quiz entry is enabled, the runner opens quizzes and pauses so the user can complete them.
- The project contains no external AI, payment, subscription, advertising, or analytics integration.

See [`apps/extension/README.md`](apps/extension/README.md) for extension-specific details.
