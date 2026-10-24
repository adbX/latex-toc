# Changelog

## Unreleased

### Public-release preparation

- Prepared the standalone `adbX/latex-toc` repository with the display name LaTeX TOC and VSIX publisher `adbX`.
- Licensed all first-party material under MIT, Copyright (c) 2026 Adhithya Bhaskar; retained third-party notices unchanged.
- Included the fictional eight-source thesis, its 54 headings and 12 floats, and one retained PDF under `examples/synthetic-thesis/`.
- Added self-contained installation, design, and demonstration documentation, preserving source-numbering limits, platform boundaries, and prior verification provenance.
- This preparation does not claim a Marketplace publication, normal-profile installation, or a new verification run. Results below describe earlier acceptance work.

### Privacy, bounded processing, and local packaging

- Added inclusive limits for UTF-8 source/project bytes, expanded file occurrences and structural events, and automatic discovery entries. Limit failures are visible and never publish truncated models.
- Rejected special disk files while preserving regular-file symlinks and external includes. Added cooperative cancellation through readers, discovery, graph assembly, and host supersession.
- Added source-boundary, cancellation, strict-message, and CRLF/Unicode range regressions. All 90 deterministic checks and expanded macOS host scenarios passed at VS Code 1.85.0 and 1.143.0.
- Added local `vsce` packaging, an exact payload allowlist, bundle-derived runtime license notices, and an installed-only isolated launcher. Minified webview assets remove generated absolute checkout-path comments and target the minimum editor's Chromium 114.
- Inspected the actual VSIX archive and exercised its installed sidebar on macOS, including source navigation, unsaved edits, literal HTML-like titles, state recovery surfaces, four theme classes, keyboard interaction, narrow width, and zoom.
- Limited initial support to local desktop macOS. Windows/Linux verification is future work; native screen-reader compatibility is not claimed. Virtual workspaces and Restricted Mode remain disabled.
- Measured a 4.3-second renderer stall with 10,000 headings. Large-outline optimization is explicitly deferred for personal use; resource limits are not responsiveness guarantees.
- At that stage the package remained unpublished and first-party licensing and example migration were deferred; the public-release preparation above supersedes those identity and licensing decisions.

### Appearance and rank settings

- Added root-scoped live indentation, seven-rank visibility, custom ASCII-letter heading aliases, and independent light/dark rank overrides.
- Added the approved Balanced dark palette while retaining the existing light colors and four-rank visibility default. Both high-contrast theme classes use native foregrounds.
- Added validated, versioned palette JSON imports, profile-local saved values, explicit rename/replacement, optional dark-branch fallback, and native selection/reset commands with explicit available scopes.
- Preserved overrides across palette changes, inherited optional rank colors, and reported missing palettes truthfully. Cancelled or invalid imports leave the library and active appearance unchanged.
- Preserved navigation state and model versions during indentation/color changes. Hidden-rank promotion retains semantic chapter scope, numbering, source targets, and full ancestry.
- Passed 69 deterministic regressions and expanded host scenarios on macOS at VS Code 1.85.0 and 1.143.0. Exercised the live import/select/reset controls, state retention, theme precedence, and rank projection in an isolated profile.
- Appearance/rank work did not include packaging, publication, or normal-profile installation.

### Svelte sidebar

- Replaced the host-validation surface with Svelte 5 toolbar, compact heading tree, separate figures/tables view, content-sized footer, and read-only full ancestry.
- Added independent keyboard focus, 100 ms hover previews, two-stage Escape dismissal, chapter-scoped expansion, and source-caption selection retention.
- Added per-project session-only content/filter/focus state and valid restoration after webview disposal, without retaining hidden contexts or persisting navigation across window reloads.
- Preserved the approved light hierarchy colors, using neutral VS Code foregrounds in dark and high-contrast themes until palette review. Retained notices for the three Lucide glyphs.
- Passed 50 deterministic regressions and host scenarios on macOS at VS Code 1.85.0 and 1.143.0. Exercised the live sidebar at 300/344/420 CSS pixels, including keyboard, hover, disposal, and window reloads.
- Native screen-reader compatibility was not verified. Appearance/rank controls, packaging, and publication remained outside the sidebar milestone; the current support boundary is recorded above.

### Project and navigation milestone

- Added the local desktop extension entry point, Explorer webview, validated host messages, scoped settings, and isolated development launcher.
- Added Workshop-derived root discovery with current-graph retention, explicit root selection, persistent project-scoped choices, bounded workspace/local-directory search, and visible unresolved/ambiguous states.
- Added incremental parsed-file reuse, conservative source identity reconciliation, superseded-result rejection, and watching for changed, created, or deleted dependencies.
- Added exact heading/caption navigation, float-selection retention across its own editor events, caret following, project pinning, and root-specific expansion/scroll state.
- Exercised real editor scenarios on macOS with VS Code 1.85.0 and stable 1.143.0, including the canonical synthetic thesis's 54 headings and 12 floats.
- Verified remembered roots across separate editor processes and retained 47 deterministic regressions; fixed stale selections for magic-root nonmembers, obsolete pending disk reads, and duplicate-command replacement identity.
- Kept the accepted Svelte presentation, appearance settings, cross-platform release checks, packaging, and publication out of this milestone.

### Source-processing milestone

- Extracted the pinned LaTeX Workshop AST recognition, plain-label rendering, and numbering logic behind explicit source-snapshot and configuration inputs.
- Added ordered nested input/include expansion, open-buffer precedence, exact heading/caption ranges, cross-file containment, duplicate inclusion identities, and visible missing-file, cycle, and parse diagnostics.
- Corrected appendix state across include boundaries and repeated letter-prefix conversion; retained documented source-numbering limits instead of claiming TeX execution.
- Added nine boundary regressions, a command-line inspector, and an isolated Extension Development Host experiment using public stock Workshop symbol APIs.
- Compared 66 synthetic and 10 USC nodes, checked all source ranges, and exercised actual caption navigation and an unsaved edit without changing fixture files on disk.
