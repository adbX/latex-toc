# Design decisions

LaTeX TOC is a source-navigation tool, not a replacement for a compiled table of contents. It keeps navigation useful while a document is being edited, including before an unsaved change can compile. The [backend contract](backend.md) specifies the supported syntax and exact limits.

## Source model and navigation

- **Parse source rather than execute TeX.** The Workshop-derived parser expands supported literal `input`/`include` paths in order. This avoids compiler setup and reads current editor buffers, but cannot interpret arbitrary macros, conditionals, or class-specific numbering. Numbers are source-derived hints, not exact PDF references.
- **Keep source authority in the host.** The sidebar requests navigation by node ID and model version. The host validates the request and source snapshot before revealing the complete heading or caption command. The webview cannot supply an arbitrary file path or command.
- **Retain identity conservatively.** Parsed files are reused; command identities are reconciled from source evidence. Ambiguous changes discard selection rather than silently moving it to a similar title. Repeated includes retain separate occurrences.
- **Prefer explicit ambiguity over a guessed root.** Current graph membership, remembered choices, magic comments, and bounded discovery determine the project. Multiple candidates require a choice. Automatic search does not crawl ancestors.

## Reading a compact outline

Rows omit numerical prefixes to reserve width for titles. The footer carries type, number, filename, and full title, while a compact breadcrumb opens read-only full ancestry. Hiding a rank promotes visible descendants without changing their numbers or semantic parents.

Figures and tables have a separate flat view. Their navigation targets are captions rather than environment starts. Clicking a caption keeps that float selected through the resulting editor events; subsequent user movement into prose follows its containing heading.

Keyboard focus, hover preview, and committed source selection are distinct. Arrows and Home/End explore without moving the editor; Enter, Space, or a click commits navigation. Hover shows detail without changing selection. Chapter filtering follows committed selection, so merely exploring another row cannot unexpectedly replace the visible tree.

## Appearance and accessibility boundaries

Typography, zoom, surfaces, focus, and selection use VS Code conventions. Rank colors supplement hierarchy and weight rather than being the only structural signal. Both high-contrast theme classes use native foregrounds even when explicit color overrides exist.

Indentation and appearance updates preserve navigation state without reparsing. Palettes are validated values stored in the profile, not live dependencies on an imported file. Individual overrides survive palette changes; resets require an explicit scope and key selection.

Prior checks covered keyboard interaction and Chromium accessibility metadata, including names, levels, expansion, and current selection. They do not establish native screen-reader compatibility. Initial support is local desktop macOS; remote/browser hosts, virtual workspaces, and Restricted Mode are excluded.

## Lifetime, privacy, and performance

Explicit root choices and user settings persist. Selection, expansion, focus, filter, and scroll are per-project window-session state; reload starts new navigation state. Hidden webviews can be disposed and reconstructed from host memory rather than retaining an entire hidden UI.

Source processing is local and read-only: no TeX compilation, shell execution, remote fetching, or telemetry. Bundled assets and a restrictive content security policy keep source titles as text. Regular-file symlinks and external includes remain supported, so the inclusion graph is not a filesystem sandbox.

Resource limits bound source bytes, expanded work, and root discovery. Exceeding a limit is a visible failure, not a partial outline presented as complete. Cancellation is cooperative and cannot interrupt an individual synchronous parse.

The tree currently renders every expanded row and caret updates send full snapshots. A prior 10,000-heading probe produced a 4.3-second renderer stall. Parsed-source reuse does not solve that rendering cost; large-outline optimization is deferred, and processing limits are not responsiveness guarantees. See [the measured results](backend.md#measured-large-outline-limitation).

## Provenance

The parser, label handling, and numbering adapt a pinned LaTeX Workshop revision; [the extraction inventory](backend.md#extraction-inventory) identifies the boundaries and retained notices. The fictional [example thesis](../examples/synthetic-thesis/README.md) provides reproducible source targets without a third-party template. All first-party material is MIT-licensed; third-party notices remain unchanged.
