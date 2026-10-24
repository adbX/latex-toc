# A short LaTeX TOC walkthrough

Use the included fictional thesis, not a private manuscript. This walkthrough needs local desktop VS Code on macOS and the build prerequisites in the [README](../README.md). It does not need TeX, a PDF viewer, LaTeX Workshop, or Marketplace access.

## Prepare an isolated window

From the checkout root, with `VSCODE_EXECUTABLE` set to the real application executable (the `Contents/MacOS/Code` file inside the VS Code application bundle, not the `code` CLI shim):

```sh
npm ci --ignore-scripts
npm run build
npm run host -- --code "$VSCODE_EXECUTABLE" \
  --synthetic "$PWD/examples/synthetic-thesis/main.tex"
```

The existing launcher creates `.host/navigation-*` with separate user-data and extension directories. It opens two generated fixture projects and **Canonical synthetic thesis**, loading only the product development extension. This is a manual walkthrough: omit `--smoke` and `--hold`. The canonical source and retained PDF are not modified by launching. If Workspace Trust is requested, review and trust only these fixture folders.

Open `main.tex` under **Canonical synthetic thesis**, then expand **LaTeX TOC** in Explorer. If necessary, use **LaTeX TOC: Choose Project Root** and select that same `main.tex`. The project contains eight sources, 54 headings, and 12 figures/tables. Keep chapter filtering off initially so the whole outline is available.

To demonstrate the packaged build instead, finish and close this window, retain the printed run-directory path, and follow the README's [isolated VSIX installation](../README.md#package-and-inspect-locally) using that same directory. Its workspace already contains the canonical example. Do not install into the normal profile.

## Navigate and inspect

1. Expand **Introduction** and click **Research questions and objectives**. The editor moves from `main.tex` to `chapters/01-framing.tex` and selects the complete section command.
2. Expand **Conclusions** and click **Synthesis**. Navigation now selects a command in `chapters/06-outlook.tex`. This demonstrates one project spanning multiple source files, not separate file outlines.
3. Move the caret into the prose below **Conclusions within the model** in that file. With editor following enabled, the outline's committed selection follows the containing subsection. Run **LaTeX TOC: Toggle Editor Following**, choose **Workspace**, and move the caret elsewhere: selection stays pinned. Outline clicks still navigate. Toggle following back on at the same scope.
4. In the sensor-placement chapter, select **Resolving equal coverage gains through warning delay and a stable candidate ordering**. The footer shows its full title, source filename `03-placement.tex`, and source-derived number. Click the breadcrumb to inspect every ancestor, then press Escape to close it. Hover a different row to inspect it without committing navigation; move away to restore the selected detail.
5. Switch to **Figures and tables**. Select **An invented two-branch river, with a confluence and one downstream observation site.** The editor selects the caption in `chapters/01-framing.tex`, not the figure environment start. Select **A literal three-tick ledger for one invented pulse.** to navigate to the table caption in `chapters/appendix.tex`. Move into adjacent prose to resume heading following. Return to the headings view.

Numbers come from supported source conventions. The retained PDF is a reading copy, not an input to this sidebar or a guarantee of exact compiled numbering for arbitrary documents.

## Change appearance without losing your place

Use **Preferences: Open Workspace Settings (JSON)** in this isolated workspace. Merge these keys into the existing settings object, without replacing other entries:

```json
{
  "latexToc.indentPx": 24,
  "latexToc.colors.light.section": "#006699",
  "latexToc.colors.dark.section": "#66ccff"
}
```

Select a section and note the deeper indentation and explicit section color in a regular light or dark theme. High-contrast themes intentionally use native foregrounds instead.

Save the following as `demo-palette.json` inside the printed ignored run directory, then run **LaTeX TOC: Import Palette**, select that file, choose import-and-select, and select **Workspace** as the setting target:

```json
{
  "version": 1,
  "name": "River demo",
  "light": {
    "chapter": "#563d7c",
    "section": "#a04424",
    "subsection": "#24634a",
    "subsubsection": "#333333"
  },
  "dark": {
    "chapter": "#c7b4e6",
    "section": "#e8b098",
    "subsection": "#9dceb5",
    "subsubsection": "#dddddd"
  }
}
```

The chapter palette changes, but the explicit section override remains `#006699` in light themes or `#66ccff` in dark themes. Selection, expansion, and remembered focus remain intact. Use **LaTeX TOC: Select Palette** to switch back to `purple-red-green-muted` at Workspace scope: the section override still survives. **LaTeX TOC: Reset Color Overrides** can remove just one selected override at that scope without resetting the palette or indentation. Imported palettes store validated values; the JSON file is not a runtime dependency.

Close the isolated window when finished. Settings and imported palettes stay in its separate profile/workspace; navigation state does not persist through a window reload. Before recording or sharing, review window titles, paths, recent files, notifications, terminals, and any visible personal information. Exercised results and limitations are recorded in the README's [release verification](../README.md#release-verification) and earlier acceptance evidence.
