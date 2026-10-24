# LaTeX TOC

LaTeX TOC provides a project-wide LaTeX outline in VS Code's Explorer. Navigate directly to headings and captions across included files, follow the editor caret, and inspect full ancestry without compiling. Unsaved buffers are included; an installed LaTeX Workshop extension is not required.

The sidebar separates headings from figures/tables and offers chapter filtering, hover inspection, configurable indentation, rank visibility, custom heading commands, palettes, and individual color overrides. Numbers are **source-derived**, not a promise to reproduce a compiled PDF's TOC.

Source and issues: [adbX/latex-toc](https://github.com/adbX/latex-toc). The initial supported environment is **local desktop VS Code on macOS, version 1.85.0 or newer**. Acceptance covered 1.85.0 and stable 1.143.0; other platforms, remote/browser hosts, virtual workspaces, Restricted Mode, and native screen-reader compatibility are not supported claims. See [limitations](docs/backend.md#unsupported-constructs-and-compatibility-limits), [design decisions](docs/design.md), and the [reproducible walkthrough](docs/demo.md).

## Build and install locally

LaTeX TOC is not available on the Visual Studio Marketplace. Build a VSIX from this checkout and use an isolated profile as described below; no normal-profile installation is needed.

Use Node.js 22 or newer and npm to build and package the extension. The verified toolchain is Node.js 24.20.0 and npm 11.19.0 on macOS; the bundled extension still targets the Node 18 runtime in the minimum supported editor.

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run inspect -- examples/synthetic-thesis/main.tex
```

The build and deterministic parsing, identity, and root-discovery regressions are self-contained. The inspection command accepts a local LaTeX root and prints headings, floats, numbers, source targets, and diagnostics. It never launches TeX. Diagnostics make the command exit nonzero while retaining valid outline results.

Read [the backend and host contract](docs/backend.md) before treating the output as a document's compiled TOC. The command-line inspector requires an explicit root; the Explorer host implements automatic discovery and a root picker.

Package the local extension with `npm run package`; `npm run package:files` lists the payload. The result is `dist/latex-toc.vsix`. Follow [the isolated installation steps](#package-and-inspect-locally) to try that package without affecting your normal editor profile.

Source processing is local and read-only: it does not compile TeX, execute shell commands, fetch remote resources, or send telemetry. Regular files and regular-file symlinks are supported, including intentional external includes. [Processing limits](docs/backend.md#processing-limits-and-cancellation) bound source bytes, expanded work, and discovery; exceeding a limit produces a visible error instead of a truncated outline. Superseded work is cancelled cooperatively.

## Run the isolated navigation host

Build first, then supply the editor executable, not its CLI shim:

```sh
npm run host -- --code "$VSCODE_EXECUTABLE" --smoke --hold
```

This creates fresh user-data and extension directories under `.host/navigation-*`, with two generated fictional projects in a multi-root workspace and a separate loose-file project. It does not install into your normal editor profile or load Workshop. Approve Workspace Trust only for those fixtures when prompted. `--smoke` loads a separate development-only driver from `test/driver/`; ordinary launches load only the product extension. The runtime checks modify only generated fixtures, and their reports stay in the ignored run directory. `--hold` leaves the real sidebar open until **Finish** is selected.

An optional `--synthetic "$PWD/examples/synthetic-thesis/main.tex"` adds the included fictional thesis for visual inspection and checks its 54 headings and 12 floats without modifying its source or PDF. It is not required to build or run the generated fixtures. `--port NUMBER` exposes a local Electron debugging port for development inspection; omit it for ordinary use.

To check remembered roots across separate processes, finish the initial run and use its printed run directory. The driver uses real isolated-profile storage rather than the transient storage of `--extensionTestsPath`:

```sh
npm run host -- --code "$VSCODE_EXECUTABLE" --smoke --reuse "$RUN_DIRECTORY" --stage remember
npm run host -- --code "$VSCODE_EXECUTABLE" --smoke --reuse "$RUN_DIRECTORY" --stage restore
```

The development launch configuration also uses isolated user-data/extension directories and asks for a synthetic-only workspace. Do not point it at a private manuscript.

For manual window-reload checks, finish the smoke run and reopen its isolated profile without the smoke driver:

```sh
npm run host -- --code "$VSCODE_EXECUTABLE" --reuse "$RUN_DIRECTORY"
```

The initial `--smoke` scenario requires a fresh run directory. Reusing that driver is reserved for the `remember` and `restore` stages above.

### Commands and settings

**LaTeX TOC: Choose Project Root** and **LaTeX TOC: Toggle Editor Following** are available from the Command Palette and the view-title menu. The follow command asks for an explicit User or available Workspace target. Turning following off pins the project and committed selection, but outline clicks still navigate.

| Setting | Scope | Behavior |
|---|---|---|
| `latexToc.followEditor` | Window | Follow the active LaTeX project and caret; default `true` |
| `latexToc.texDirs` | Resource | Additional include search directories, relative to the selected root; default `[]` |
| `latexToc.indentPx` | Resource | Integer indentation from 8 to 32 pixels; default `16` |
| `latexToc.palette` | Resource | Built-in or imported palette name; default `purple-red-green-muted` |
| `latexToc.colors.light.<rank>` | Resource | Individual light-theme hex override; default `null` inherits |
| `latexToc.colors.dark.<rank>` | Resource | Individual dark-theme hex override; default `null` inherits |
| `latexToc.visibleRanks` | Resource | Unique subset of the seven ranks; default chapter through subsubsection; `[]` hides all heading rows |
| `latexToc.sectionCommands` | Resource | Custom ASCII-letter command names mapped to semantic ranks; default `{}` |

Explicit root choices survive reloads in the isolated profile's extension storage. Selection, remembered tree focus, expansion, content view, chapter filter, and scroll live only in the current window session, separately for each project. Automatic root search stays inside the active workspace folder, or the containing directory for loose files. It does not crawl ancestors. Root magic comments and explicit choices can reference roots elsewhere.

Resource settings are resolved against the selected project root, not whichever included file is active. Indentation, palette, and color changes preserve committed selection, remembered focus, expansion, and scroll without reparsing. Hidden ranks promote visible descendants without changing source order, numbering, full ancestry, or semantic chapter filtering. Changing command aliases reparses the project and reconciles source identities.

The seven rank names are `part`, `chapter`, `section`, `subsection`, `subsubsection`, `paragraph`, and `subparagraph`. An alias such as `"latexToc.sectionCommands": { "topic": "section" }` recognizes `\topic`, `\topic*`, and an optional short title followed by the mandatory title. Names contain only ASCII letters, without the leading backslash. Standard heading commands and parser structural commands cannot be remapped. Aliases do not expand macros or infer different argument signatures.

The verified macOS host baseline is VS Code 1.85.0, with matching API typings and a Node 18 runtime bundle. The same navigation scenarios passed on stable 1.143.0. Windows/Linux acceptance is future work, not an initial support claim. Remote, browser, virtual-workspace, and Restricted Mode support are not enabled. Native screen-reader compatibility is not claimed.

## Package and inspect locally

```sh
npm run package
npm run package:files
```

Packaging builds first and writes `dist/latex-toc.vsix`. The manifest's exact `files` allowlist contains only the manifest, README/changelog, product icon, host and webview bundles, and required license notices. It excludes source maps, examples/PDFs, tests, development drivers, compatibility downloads, caches, profiles, private records, and `node_modules`. All runtime dependencies are bundled; the build derives their full license notices from the code actually included. It fails if a bundled dependency's license text cannot be found.

The VSIX publisher identity is `adbX`, and first-party material is licensed under [MIT](LICENSE). Local packaging does not publish to the Marketplace. Third-party notices remain applicable to their respective material.

After an isolated development run has finished and closed, use its printed run directory to install the package. `VSCODE_CLI` is the editor's `code` CLI, whereas `VSCODE_EXECUTABLE` remains the actual application executable:

```sh
"$VSCODE_CLI" --user-data-dir "$RUN_DIRECTORY/user-data" \
  --extensions-dir "$RUN_DIRECTORY/extensions" --install-extension "$PWD/dist/latex-toc.vsix"
npm run host -- --code "$VSCODE_EXECUTABLE" --reuse "$RUN_DIRECTORY" --installed
```

`--installed` omits every extension-development path and cannot load the smoke driver. It requires the existing isolated run directory; it never installs into or opens the normal editor profile. In that window, open the generated `project-a/main.tex`, click a heading and a caption in another included file, move the source caret back to prose, and make an unsaved heading edit. Confirm the complete outline updates without compilation, then discard the edit.

## Sidebar interaction

Headings omit numerical prefixes in rows; the content-sized footer retains type, number, source filename, and every ancestor. Its full title wraps naturally. The compact breadcrumb uses at most two lines, shortening titles rather than reference numbers; click it for read-only full ancestry. The default tree displays chapter through subsubsection, while other parsed ranks remain in the source model and ancestry.

- Arrow keys and Home/End move keyboard focus or expand/collapse without navigating. Click, Enter, or Space commits source navigation.
- Hover previews after 100 ms without changing selection. A 180 ms return grace lets the pointer enter the footer. Escape closes ancestry before clearing a hover preview.
- `Ch` follows the committed node's nearest chapter, not hover or keyboard focus. Front matter without a chapter uses the whole document.
- Collapse all and Expand all affect only the current chapter when filtered, preserve hidden chapters' expansion state, and never change selection. Both are disabled in Figures and tables.
- Hiding and reopening the view restores valid session state without moving keyboard focus. Hover and popovers are transient. Reloading the window starts fresh navigation and view state; persisted settings and explicit root choices remain.

The sidebar inherits VS Code fonts, zoom, and surface tokens. The built-in palette provides light colors and a Balanced dark branch. Both high-contrast theme classes use VS Code's native foreground instead of rank colors, including explicit overrides. Structure, weight, selection, and focus remain independent of color. The three inline Lucide glyphs and the list-tree product icon retain their [license notices](third-party/Lucide-LICENSE.txt).

### Release verification

Clean-checkout release verification passed the Svelte/TypeScript build with zero errors or warnings and all 90 deterministic regressions. All 13 navigation-host checks passed on macOS with VS Code 1.143.0. The installed VSIX, without development extensions, exercised cross-file headings and captions, unsaved updates, caret following and pinning, full ancestry, and a palette import that preserved an individual override and selection.

The eight-source example produced 54 headings, 12 floats, and no diagnostics. All 66 source targets and compiled label numbers matched. Its rebuilt 20-page PDF had the same extracted text as the retained copy. The actual VSIX contained 11 extension payload files and two metadata files, with no example, screenshot, profile, or development dependency. Runtime bundles and generated notices are byte-identical to the earlier accepted build.

### Prior verification evidence

The following results describe earlier acceptance. All 90 deterministic regressions passed in that run. Navigation, appearance-state retention, root-specific configuration, aliases, and oversized unsaved-source recovery passed on macOS at VS Code 1.85.0 and 1.143.0. Separate host processes verified remembered roots and rejected obsolete pending disk reads.

The installed VSIX was exercised in an isolated 1.143.0 profile without development extensions: cross-file heading/caption navigation, subsequent caret following, unsaved edits, literal HTML-like titles, and loading, empty, malformed, ambiguous-root, and missing-palette states. Inspected light, dark, high-contrast dark/light captures cover a 297 CSS-pixel sidebar and 120% zoom. Keyboard focus remained independent of source selection; Chromium accessibility metadata exposed names, levels, expansion, and current selection. This is not a native screen-reader compatibility claim.

Earlier acceptance covered live palette import/cancellation/replacement/reset, all seven ranks, 300/344/420 CSS-pixel layouts, hover/popover dismissal, disposal/restoration, and window reloads. The current tree still renders every expanded row: a 10,000-heading probe produced a 4.3-second renderer stall. [Large-outline optimization is deferred](docs/backend.md#measured-large-outline-limitation); the processing limits do not guarantee interactive responsiveness.

## Palettes and individual overrides

**LaTeX TOC: Select Palette**, **LaTeX TOC: Import Palette**, and **LaTeX TOC: Reset Color Overrides** are available from the Command Palette and view-title menu. Selection asks for an explicit User, Workspace, or Workspace Folder target. Only available scopes are offered; Workspace Folder means the folder containing the selected root. Writes are never redirected to another scope. A higher-precedence setting can keep another palette effective, which the command reports.

Imports store validated color values in the current profile's extension storage, not a path to the source JSON. Choose import-only or import-and-select. Name collisions require an explicit replacement or rename; the built-in palette cannot be overwritten. Cancelling any prompt or importing invalid JSON leaves the saved library and active appearance unchanged. Selecting or importing a palette never clears individual color overrides.

Palette files are UTF-8 JSON, at most 64 KiB, with the format defined by [the palette schema](schemas/palette.schema.json):

```json
{
  "version": 1,
  "name": "Example",
  "light": {
    "chapter": "#3c2a62ff",
    "section": "#984620ff",
    "subsection": "#135043ff",
    "subsubsection": "#131313ff"
  },
  "dark": {
    "chapter": "#c5b4e3ff",
    "section": "#e3b09aff",
    "subsection": "#9dcbbbff",
    "subsubsection": "#cececeff"
  }
}
```

`light` is required; `dark` is optional. An omitted dark branch uses the built-in dark branch and is disclosed during import and in the sidebar. Each supplied branch requires the four ranks shown above and may also specify the other three. Colors accept only 3-, 4-, 6-, or 8-digit CSS hex values, normalized to `#rrggbbaa`. Unknown fields are rejected. Names are trimmed, contain 1-80 characters without control characters, and are compared case-insensitively.

For each theme branch, an explicit rank override wins over that palette's rank value. If absent from the palette, `part` inherits the effective chapter color; `paragraph` and `subparagraph` independently inherit the effective subsubsection color. A `null` override means inherit; palette JSON colors themselves cannot be `null`.

Reset Color Overrides asks for a scope and one or more explicitly configured color keys at that scope. Resetting one key removes only that override and reveals the remaining settings/palette inheritance. A missing imported palette name stays visible in settings, but the sidebar reports the actual built-in fallback and offers **Choose palette** rather than claiming the missing palette is active.

## Run the retained backend comparison

The development-only extension in `experiment/` contributes **LaTeX TOC Experiment: Inspect Root**. Its command reads current editor buffers and displays the resulting outline in an output channel. It is not an installable product or sidebar prototype.

The host smoke experiment compares the extracted backend against stock Workshop using VS Code's public workspace-symbol command. It also exercises real caption navigation, caption/prose containment, unsaved-buffer versions, explicit-root retention while editors change, and restoration without saving the edited fixture. Neither extension is installed into the normal profile.

Fetch the two pinned public references separately. They are ignored compatibility inputs, not product dependencies or redistributable demo assets.

```sh
mkdir -p .compat/latex-workshop .compat/USCthesis
curl -fL https://codeload.github.com/James-Yu/LaTeX-Workshop/tar.gz/fb1d13108f1947028edb3d9881ed4843b983a3c8 -o .compat/workshop.tar.gz
tar -xzf .compat/workshop.tar.gz -C .compat/latex-workshop --strip-components=1
curl -fL https://codeload.github.com/rudazhang/USCthesis/tar.gz/faf5402eec50d95c7c2a2800d5a2c4c25affaad5 -o .compat/usc.tar.gz
tar -xzf .compat/usc.tar.gz -C .compat/USCthesis --strip-components=1
npm --prefix .compat/latex-workshop ci --ignore-scripts
npm --prefix .compat/latex-workshop run compile
```

Use the included synthetic thesis root. `VSCODE_EXECUTABLE` must name the editor executable, not its CLI shim; on macOS, it is the `Contents/MacOS/Code` executable inside the application bundle.

```sh
npm run host:backend -- \
  --code "$VSCODE_EXECUTABLE" \
  --synthetic "$PWD/examples/synthetic-thesis/main.tex" \
  --usc "$PWD/.compat/USCthesis/tex/main.tex" \
  --workshop "$PWD/.compat/latex-workshop" \
  --hold
```

Each invocation creates a new `.host/run-*` user-data directory, empty extension directory, and workspace containing only the synthetic and public compatibility sources. Automatic TeX builds, cleaning, and external linting are disabled in that isolated profile. Workspace Trust is not bypassed: approve only those fixture folders when prompted. The original fixture text is restored after the unsaved-buffer probe; no source is saved. The JSON report remains in the ignored run directory. `--hold` leaves the report open until **Finish** is selected.

The original backend comparison ran on VS Code 1.142.0 on macOS. Its separate development manifest retains the original 1.140.0 requirement; use the navigation host above to verify the product's 1.85.0 baseline.

## Observed compatibility

| Corpus | Sources | Headings | Floats | Labels matching stock | Intentional appendix-label corrections | Caption-target corrections |
|---|---:|---:|---:|---:|---:|---:|
| Synthetic thesis | 8 | 54 | 12 | 60 | 6 | 12 |
| Pinned USCthesis | 8 | 9 | 1 | 10 | 0 | 1 |

The isolated host checked all 76 command ranges against actual VS Code documents. Synthetic appendix labels are corrected from Workshop's cross-file `7` prefix to `A`. Caption navigation intentionally differs from Workshop's environment-start targets. The nine USC headings include its empty `paragraph` command because all seven semantic ranks are parsed.

USC's macro-generated front matter and manually redefined appendix numbering remain unsupported, as documented in the backend contract. Matching stock on those cases is evidence of an inherited limitation, not evidence of compiled-template correctness.

## License and provenance

[MIT](LICENSE), Copyright (c) 2026 Adhithya Bhaskar, covers all first-party material: extension code, documentation, and the fictional example's prose, diagrams, tables, LaTeX sources, and retained PDF. Retained third-party notices are unchanged and apply to their respective material, including [LaTeX Workshop's MIT notice](third-party/LaTeX-Workshop-LICENSE.txt). [The extraction inventory](docs/backend.md#extraction-inventory) identifies adapted code and data.

The [synthetic thesis](examples/synthetic-thesis/README.md) is included for reproducible demonstrations, not shipped in the VSIX. The USC template and artwork are excluded from the repository and package; optional compatibility downloads retain their own notices. No compatibility extension or external example is needed to build or use LaTeX TOC.
