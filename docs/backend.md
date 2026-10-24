# Source-processing backend

The backend is an extraction from LaTeX Workshop, not a TeX engine or a projection of compiled output. It accepts an explicit local build-root URI, a source-snapshot reader, and parser configuration. It has no runtime dependency on an installed Workshop extension, VS Code, or a compiler.

## Inputs and outputs

`buildOutline(root, read, config, signal?)` produces one ordered project model. A source snapshot supplies its URI, exact text, and document version or disk-content revision. The filesystem adapter snapshots open buffers before a build and reads disk only for other sources. URI escaping is normalized before matching buffers, including spaces and apostrophes.

The result contains heading and figure/table nodes, source ranges, parent IDs, inclusion occurrences, source versions, containing-heading spans, and diagnostics. `dependencies` records every attempted source URI, including missing include candidates, so their creation and deletion can invalidate the model. Ranges use zero-based UTF-16 line, character, and offset coordinates. Heading targets cover their complete command. Float targets cover the caption command, including optional and multiline arguments; an uncaptioned float targets its environment.

`findContaining(model, uri, offset, occurrence?)` prefers a caption only while the caret is inside that caption. Other prose, including prose in a float environment, follows its containing heading. Spans cross file boundaries and include the end-of-file caret position. Repeated inclusion can make a source position ambiguous; the lookup returns all candidates rather than choosing the first occurrence. A known inclusion occurrence disambiguates that result.

The one-shot `buildOutline` IDs are structural addresses, suitable for an individual inspection but not selection retention across structural edits. The host instead uses `OutlineSession.build(root, read, signal?)`, which caches unchanged parsed files and reconciles source-command identities before assembling inclusion occurrences, parents, numbering, and containment. `configure(config)` preserves reconciliation history while updating include directories or parser configuration.

Reconciliation uses exact source-command evidence and ordered structural anchors within each source file. Duplicate positions survive a prose-only change when the changed source interval touches no commands; an unchanged command sequence alone is insufficient evidence. Insertions above unique commands and separately anchored repeated includes retain their identities. Changed commands, ambiguous duplicate deletion, missing sources, and parse failures discard affected identities rather than transferring a selection to a similar title. Previously published outlines are not mutated, and older concurrent completions cannot replace newer reconciliation history.

### Processing limits and cancellation

The local reader accepts regular files, including symlinks to regular files, but rejects pipes, devices, and directories before consuming their contents. Bounded reads also reject files that grow past the source limit after opening. Open buffers and injected readers receive the same UTF-8 text-size check.

| Resource | Inclusive limit |
|---|---|
| One source snapshot | 4 MiB of UTF-8 text |
| Unique source text in one project build | 32 MiB, counted once per resolved source URI |
| Expanded file occurrences | 10,000, including the root and repeated inclusion |
| Expanded structural events | 100,000, including heading, float, include, counter, and appendix events |
| Automatic discovery entries | 20,000 filesystem entries, including non-TeX and skipped entries |
| Automatic TeX candidates | 200 |

Exceeding a resource limit throws `ProcessingLimitError`. The host displays the failure and disables navigation from the old model; it never publishes a truncated replacement. Correcting the source triggers a fresh build. Explicit roots and magic comments bypass automatic candidate traversal, not source or graph limits.

The host aborts superseded discovery/build work, explicit-root loads, pinned-follow transitions, and disposal. Readers close handles on failure or cancellation. Graph and discovery loops periodically yield to editor events, and aborted sessions cannot commit reconciliation history or obsolete disk snapshots. Cancellation is cooperative between I/O, parser calls, and work batches; it does not preempt a synchronous parser call.

## Project discovery and host state

`src/roots.ts` adapts the pinned Workshop root-discovery conventions without accessing its installed extension or private singleton. The host uses this precedence:

1. Retain the current root when the active source belongs to its actual inclusion graph, including standalone-capable chapters.
2. Rebuild applicable remembered explicit roots and require actual graph membership. Multiple applicable roots produce a picker.
3. Follow `% !TEX root = ...` or `% !TeX root = ...` comment chains from source snapshots. Missing targets, cycles, and malformed terminal documents are visible errors.
4. Recognize the active document's `documentClass` through the production parser.
5. Search bounded candidates and require their supported transitive include graph to contain the active file.

Automatic discovery searches the active workspace folder recursively, or only the containing directory outside a workspace. It excludes dependency/build metadata directories and does not traverse directory symlinks. It streams directory entries, stops visibly above 20,000 visited entries or 200 `.tex` candidates, and never selects from incomplete results. It never crawls ancestor directories or an unrelated workspace folder. Explicit choices and magic comments may reference roots outside those bounds.

These policies intentionally differ from Workshop's self-root-before-current-graph precedence and arbitrary first-candidate fallback. No compiled `.fls` discovery or broader `subfile`/`import` support is added. A root selected through a magic comment can be shown even when the supported include graph cannot attribute the active source; that source has no inferred containing node.

Explicit choices are stored in profile-local extension storage, keyed by root and the workspace-folder scopes represented in its source graph, with a containing-directory identity for loose roots. The resolver revalidates membership before reuse. A loose nested chapter can recover an explicitly chosen root across reloads without broadening automatic directory search. A remembered choice cannot capture an unrelated document simply because it shares a folder.

The window controller retains per-project selection, remembered tree focus, expansion, content mode, chapter filtering, and scroll in memory only. Reconciliation removes selection/focus IDs that no longer exist rather than matching replacement titles. Non-TeX tabs and absent editors retain the current project. Disabling `latexToc.followEditor` pins the project and committed selection while leaving explicit navigation available; enabling it resolves the active LaTeX document immediately. An unresolved new project is shown as unresolved, not mislabeled as the previous project.

Open document snapshots take precedence over disk, including unsaved edits. Source changes invalidate disk snapshots and trigger a 100 ms debounced rebuild; unchanged parsed files are reused while graph order, numbering, and containment are recomputed. Generation checks discard superseded host results, and a disk read invalidated while pending cannot repopulate the cache. Caret movement and switching between unchanged included files do not rebuild the model. Resource-scoped include directories, aliases, and appearance settings are resolved against the selected root; follow policy is window-scoped. Changes to `texDirs` or `sectionCommands` reconfigure and rebuild the project; appearance-only changes publish a snapshot without reparsing or changing the model version.

## Navigation and webview boundary

Each published host model has a monotonically increasing window-local version. The webview sends validated navigation, focus, view-mode/filter, individual/bulk expansion, scroll, ready, root-picker, follow-toggle, or palette-picker messages. Navigation accepts a current node ID and model version, never a source URI, range, configuration value, or arbitrary command from the webview. The palette-picker request carries no name, path, setting, or target; those choices remain native host UI. Invalid, stale, and removed-node requests produce visible notices without navigating. Bulk expansion uses the committed node's semantic chapter, falls back to the whole document without a chapter, and rejects requests in the flat float view.

The host checks the source snapshot before calling `showTextDocument`, selects the complete heading/caption range, and reveals it. Navigation origin is tracked against project, model version, node, URI, range, and editor-opening phase. Matching editor events retain a clicked float; subsequent user movement follows its containing heading. Repeated source inclusions use an already selected occurrence where available, otherwise report ambiguity.

The Explorer webview uses Svelte 5 runes, immutable raw host snapshots, keyed tree rows, and scoped CSS. Its toolbar, tree, content-sized footer, and ancestry popover derive from the same host model. The displayed tree promotes descendants of hidden ranks without changing source numbers or full ancestry. Source filenames are supplied by the host for footer display; source paths and ranges remain host-owned navigation authority.

The script and stylesheet are bundled local resources, source titles are interpolated as text, and the CSP permits only the nonce-bearing script and local stylesheet. Inline style attributes support measured breadcrumb/popover geometry; remote resources, arbitrary scripts, and raw source HTML are not allowed. The view does not use `retainContextWhenHidden`, `webview.setState`, or restart-restoration context. Each webview lifetime registers fresh listeners and restores host-memory state, suppressing restoration-generated scroll writes. Selection changes reveal a branch without moving keyboard focus; hover and popovers clear on model changes, interaction, and hiding.

Each snapshot includes validated `AppearanceState`: effective light/dark colors for all seven ranks, indentation, visible ranks, the requested palette name, the resolved palette name, and any fallback notice. `src/appearance.ts` owns palette validation, inheritance, alias validation, and resolution without VS Code dependencies. `src/host/appearance.ts` owns profile-local palette storage, root-scoped configuration, native pickers, and explicit setting writes. Imports validate the entire bounded UTF-8 file and finish all cancellation points before changing storage or configuration. Palette selection and replacement retain individual overrides.

The Svelte view switches light/dark colors through the native theme classes and always uses the native foreground in both high-contrast classes. Hidden-rank projection never alters the model, source ancestry, or semantic chapter membership. Appearance updates reuse indexed source nodes and suppress scroll events caused by restoration or layout clamping, retaining logical focus, selection, expansion, and remembered scroll. Typography, zoom, and surfaces follow VS Code rather than a machine-specific prototype theme. The inline disclosure and bulk-action glyphs use Lucide `play`, `chevrons-down-up`, and `chevrons-up-down`, with retained [Lucide/Feather notices](../third-party/Lucide-LICENSE.txt). Keyboard and Chromium accessibility-metadata checks do not establish native screen-reader compatibility.

The desktop entry point rejects remote/browser hosts. The manifest explicitly disables virtual workspaces and Restricted Mode. It uses stable WebviewView, document/selection, workspace-trust, resource-configuration, and filesystem-watcher APIs available at the 1.85.0 typing baseline, and bundles for Node 18. Initial support is macOS only; Windows/Linux acceptance is future work. Native screen-reader compatibility is not claimed.

### Measured large-outline limitation

The current tree renders every expanded row, and caret events send complete host snapshots. The following installed-VSIX measurements came from one isolated macOS VS Code 1.143.0 run, including opening the source editor and rendering the outline. They are observations, not latency guarantees or supported-size thresholds.

| Headings | First open | End-key focus move |
|---|---:|---:|
| 1,000 | 1.4 s | 17 ms |
| 10,000 | 8.6 s | 206 ms |

A repeated 10,000-heading load produced a 4.3-second webview main-thread task. Large-outline optimization is deferred; no responsive 10,000-heading support claim is made. Virtualization was not introduced, and moving parsing to a worker would not remove that rendering stall. These measurements predate public-release preparation.

Caret-driven selection changes retained model version 15 in that run. A separate instrumented Node run built the unchanged 10,000-heading source twice with one parser invocation and identical node identities. Parsed-source reuse therefore works, but does not remove rendering and full-snapshot costs.

## Extraction inventory

The implementation baseline is [LaTeX Workshop revision fb1d13108f1947028edb3d9881ed4843b983a3c8](https://github.com/James-Yu/LaTeX-Workshop/tree/fb1d13108f1947028edb3d9881ed4843b983a3c8). The [upstream MIT notice](../third-party/LaTeX-Workshop-LICENSE.txt) applies to the adapted material.

| Upstream source | Retained responsibility | Local implementation |
|---|---|---|
| `src/parse/parser/unified.ts`, `unified-defs.ts` | Configured unified-latex parsing, fixed `s o m` section signatures, automatic expl3/at-letter handling | `src/parse.ts` |
| `src/utils/utils.ts` | Comment/verbatim filtering and literal include-file search order | `src/parse.ts`, `src/project.ts` |
| `src/utils/parser.ts` | Argument text and plain-label extraction, formatting wrappers, PDF strings, citations, math symbols | `src/labels.ts` |
| `data/unimathsymbols.json` | Command-to-Unicode label lookup | `src/math-symbols.json`, reduced to the 2,414 entries and values used by the upstream label helper |
| `src/outline/structure/latex.ts` | AST section/float recognition, optional titles, counters, hierarchy, source numbering | `src/parse.ts`, `src/project.ts`, `src/numbering.ts` |
| `src/core/cache.ts`, `src/core/cache/dependencies.ts` | Snapshot/graph boundary was inspected, not copied as a service | Per-build source and parse maps in `src/project.ts` |
| `src/core/root.ts` | Magic-root conventions and discovery strategies, with the explicit precedence/bounds above | `src/roots.ts` |

The only direct parser runtime dependency is `@unified-latex/unified-latex-util-parse` 1.8.4, matching the pinned upstream version. The lockfile records its transitive packages. No worker pool, compiler, PDF server, completions, bibliography cache, file watcher, FLS/AUX reader, or Workshop singleton is imported. The separately downloaded stock extension is a black-box comparison target only.

Packaging derives `dist/THIRD-PARTY-LICENSES.txt` from packages contributing code to the host/webview bundles, including Svelte runtime dependencies even though Svelte is a development dependency. The unified-latex npm packages omit their monorepo license, so its [MIT text](../third-party/unified-latex-LICENSE.txt) is retained from npm's recorded source revision `7a74e60c4fbaf2527b9cf79772c0c7266f3d2b2c`. The [trie-prefix-tree notice](../third-party/trie-prefix-tree-NOTICE.txt) preserves its README license declaration and attribution from revision `dcb48612606e4af37f9c1d240420bf9b13228f65`, together with the referenced MIT terms. These pinned exceptions do not cover arbitrary upgraded packages; a missing notice fails the build.

All first-party code and documentation are covered by the repository's [MIT license](../LICENSE), Copyright (c) 2026 Adhithya Bhaskar. This does not replace or alter the retained third-party notices.

## Supported source contract

All seven standard ranks, from `part` through `subparagraph`, are parsed regardless of display visibility. The resource-scoped `latexToc.sectionCommands` setting maps custom ASCII-letter control words, without a leading backslash, to those ranks with the same `s o m` argument signature. Standard ranks and parser structural commands cannot be overridden. Stars produce unnumbered headings. Nonempty optional short titles and captions take precedence, matching Workshop. Supported label rendering unwraps common formatting commands, uses the PDF branch of `texorpdfstring`, removes citations, and retains upstream math-symbol substitution.

Literal, braced `input` and `include` commands expand in document order. Search the including file's directory, the build root's directory, then explicitly supplied `texDirs`. Within a directory, append `.tex` when the name has no extension; try that path before appending another `.tex`, following Workshop's resolver. Absolute paths remain absolute. Each source is read and parsed once per build, but each inclusion receives its own structural occurrence. Missing files and cycles produce diagnostics without dropping the rest of the valid project. Malformed files produce parse diagnostics, not a regex fallback tree.

Numbering retains Workshop's source-level section counter and hierarchy rules, including literal integer `setcounter` assignments to standard section counters. Report/book figures and tables reset at numbered chapters; starred chapters do not advance or reset those counters. A literal `appendix` changes subsequent numbering in expanded document order, including included files. Numbers are stored separately from titles.

## Intentional deviations

Caption navigation replaces Workshop's float-environment start target. This is required for direct source navigation to the caption rather than the surrounding figure/table body.

Comments and excluded verbatim environments are replaced with equal-length whitespace, preserving raw UTF-16 offsets and line endings. Workshop deletes some text while retaining line counts; its AST offsets therefore cannot directly index the original document. Macro argument endpoints are recovered from the parsed argument nodes and delimiters because unified-latex retains the macro token's position but not complete argument ranges.

Appendix state follows the expanded input stream rather than restarting separately in every included file. Recursive section numbering also avoids converting an already-lettered appendix prefix a second time. Without that correction, an `A` prefix becomes a null character when passed through the upstream numeric conversion again.

Containing-heading intervals follow source order across includes, rather than extending same-file line intervals to an artificial maximum line. Repeated inclusion returns an explicit ambiguous lookup unless the caller supplies its occurrence. Graph cycles and missing inputs are visible diagnostics rather than outline entries that resemble navigable headings.

## Unsupported constructs and compatibility limits

This is not arbitrary TeX execution. In particular:

- Macro expansion, conditional execution, generated section commands, manual `addcontentsline` entries, and bibliography/list-page generation are not interpreted.
- `renewcommand` counter formatting, `numberwithin`, arbitrary float-counter changes, `secnumdepth`, and class/package-specific numbering are not modeled. Part and skipped-rank numbers retain Workshop's outline heuristic rather than promising compiled-PDF numbering.
- `subfile`, `import`, their related include families, unbraced filename syntax, `includeonly`, Rnw/knitr children, and compiled dependency discovery are outside the extracted input/include contract.
- Aliases do not infer whether a custom command internally creates an unnumbered heading or has a different argument signature.
- Source parsing alone does not resolve projects or navigate editors. Those responsibilities live in the independent root resolver and project/navigation host described above. Caret lookup itself performs no parse.

The separately fetched [USCthesis revision faf5402eec50d95c7c2a2800d5a2c4c25affaad5](https://github.com/rudazhang/USCthesis/tree/faf5402eec50d95c7c2a2800d5a2c4c25affaad5) exercises two important limits. Its `prefacesection` and generated front-matter/list/bibliography headings are not default nodes. Its manually redefined appendix section numbers are not interpreted: the inherited source numbers remain `3.1`, `3.1.1`, and `3.1.2`, not the rendered lettered convention. These limits must not be presented as exact USC template or PDF compatibility. The template and its artwork remain in the ignored compatibility directory, with their original notices, and are not product assets.
