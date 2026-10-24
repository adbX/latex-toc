<script lang="ts">
    import { onMount, tick } from 'svelte'
    import type { HostState, ViewMessage } from '../host/messages.js'
    import { defaultAppearance } from '../appearance.js'
    import { ranks } from '../model.js'
    import Toolbar from './Toolbar.svelte'
    import Tree from './Tree.svelte'
    import Footer from './Footer.svelte'
    import { ancestry, chapterFor, headingTree, indexOutline, isHostState, scopedTree, type TreeNode } from './outline.js'

    let { post }: { post: (message: ViewMessage) => void } = $props()
    let snapshot = $state.raw<HostState>({ type: 'state', status: 'loading', message: 'Loading the project outline…', version: 0,
        nodes: [], expanded: [], scrollTop: 0, contentMode: 'headings', chapterOnly: false, followEditor: true, diagnostics: [], appearance: defaultAppearance })
    let previewNodeId = $state<string>()
    let popoverOpen = $state(false)
    let scroller = $state<HTMLDivElement>()
    let hoverTimer: ReturnType<typeof setTimeout> | undefined
    let returnTimer: ReturnType<typeof setTimeout> | undefined
    let restoringScroll = false
    let pendingScroll: number | undefined
    let restoreFrame = 0
    let received = false
    let update = 0

    let modelNodes = $derived(snapshot.nodes)
    let byId = $derived(indexOutline(modelNodes))
    let appearance = $derived(snapshot.appearance)
    let visibleRanks = $derived(appearance.visibleRanks)
    let headings = $derived(headingTree(modelNodes, byId, visibleRanks))
    let chapter = $derived(chapterFor(byId, snapshot.currentNodeId))
    let scopedChapter = $derived(snapshot.chapterOnly ? chapter?.id : undefined)
    let roots = $derived.by((): readonly TreeNode[] => snapshot.contentMode === 'headings'
        ? scopedTree(headings, byId, scopedChapter)
        : modelNodes.filter(node => node.kind !== 'heading' && (!scopedChapter || chapterFor(byId, node.id)?.id === scopedChapter))
            .map(node => ({ node, children: [] })))
    let expanded = $derived(new Set(snapshot.expanded))
    let detail = $derived(byId.get(previewNodeId ?? snapshot.currentNodeId ?? ''))
    let parents = $derived(ancestry(byId, detail?.id).slice(0, -1))
    let disabled = $derived(snapshot.status !== 'ready')

    function stopTimers(): void {
        clearTimeout(hoverTimer)
        clearTimeout(returnTimer)
        hoverTimer = returnTimer = undefined
    }

    function clearPreview(): void {
        stopTimers()
        previewNodeId = undefined
        popoverOpen = false
    }

    function preview(id: string): void {
        if (popoverOpen || disabled) return
        stopTimers()
        if (id === snapshot.currentNodeId) { previewNodeId = undefined; return }
        hoverTimer = setTimeout(() => { previewNodeId = id }, 100)
    }

    function leavePreview(): void {
        if (popoverOpen) return
        clearTimeout(hoverTimer)
        clearTimeout(returnTimer)
        returnTimer = setTimeout(clearPreview, 180)
    }

    function reveal(id?: string): void {
        if (!id || !scroller) return
        const row = scroller.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"] > .row`)
        if (!row) return
        const box = row.getBoundingClientRect()
        const viewport = scroller.getBoundingClientRect()
        if (box.top < viewport.top) scroller.scrollTop += box.top - viewport.top
        else if (box.bottom > viewport.bottom) scroller.scrollTop += box.bottom - viewport.bottom
    }

    async function receive(event: MessageEvent<unknown>): Promise<void> {
        if (!isHostState(event.data)) return
        const next = event.data
        const previous = snapshot
        const changedProject = previous.project?.key !== next.project?.key
        const newModel = changedProject || previous.version !== next.version
        const changedSelection = previous.currentNodeId !== next.currentNodeId
        const changedView = previous.contentMode !== next.contentMode || previous.chapterOnly !== next.chapterOnly
        const changedAppearance = previous.appearance.indentPx !== next.appearance.indentPx
            || previous.appearance.notice !== next.appearance.notice
            || previous.appearance.requestedPalette !== next.appearance.requestedPalette
            || previous.appearance.resolvedPalette !== next.appearance.resolvedPalette
            || previous.appearance.visibleRanks.length !== next.appearance.visibleRanks.length
            || previous.appearance.visibleRanks.some((rank, index) => rank !== next.appearance.visibleRanks[index])
            || ranks.some(rank => previous.appearance.colors.light[rank] !== next.appearance.colors.light[rank]
                || previous.appearance.colors.dark[rank] !== next.appearance.colors.dark[rank])
        if (newModel || changedSelection || changedView || previous.expanded.length !== next.expanded.length
            || previous.expanded.some((id, index) => id !== next.expanded[index])) clearPreview()
        const restore = changedProject || !received
        received = true
        // Immutable model identity keeps appearance/caret updates out of the index.
        snapshot = { ...next, nodes: newModel ? next.nodes : previous.nodes,
            appearance: changedAppearance ? next.appearance : previous.appearance }
        const revision = ++update
        if (restore || changedAppearance) {
            restoringScroll = true
            pendingScroll = next.scrollTop
            cancelAnimationFrame(restoreFrame)
        }
        await tick()
        if (revision !== update) return
        if (pendingScroll !== undefined && scroller) {
            scroller.scrollTop = pendingScroll
            pendingScroll = undefined
            cancelAnimationFrame(restoreFrame)
            // A layout clamp is physical only: never replace the host's retained
            // position with the scroll event produced by restoring that position.
            restoreFrame = requestAnimationFrame(() => {
                restoreFrame = requestAnimationFrame(() => { restoringScroll = false })
            })
        } else if (changedSelection || changedView) reveal(next.currentNodeId)
    }

    function focus(id: string): void {
        if (disabled || snapshot.focusedNodeId === id) return
        snapshot = { ...snapshot, focusedNodeId: id }
        post({ type: 'focus', version: snapshot.version, id })
    }

    function navigate(id: string): void {
        clearPreview()
        if (!disabled) post({ type: 'navigate', version: snapshot.version, id })
    }

    function toggle(id: string, open: boolean): void {
        clearPreview()
        if (disabled) return
        snapshot = { ...snapshot, expanded: open ? [...new Set([...snapshot.expanded, id])] : snapshot.expanded.filter(value => value !== id) }
        post({ type: 'expand', version: snapshot.version, id, expanded: open })
    }

    function changeView(contentMode = snapshot.contentMode, chapterOnly = snapshot.chapterOnly): void {
        clearPreview()
        post({ type: 'view', version: snapshot.version, contentMode, chapterOnly })
    }

    function bulk(open: boolean): void {
        clearPreview()
        post({ type: 'bulkExpand', version: snapshot.version, expanded: open })
    }

    function scroll(top: number): void {
        if (restoringScroll) return
        clearPreview()
        if (!disabled && snapshot.project) post({ type: 'scroll', version: snapshot.version, top })
    }

    function escape(event: KeyboardEvent): void {
        if (event.key === 'Escape' && !event.defaultPrevented && !popoverOpen && previewNodeId) {
            event.preventDefault()
            clearPreview()
        }
    }

    onMount(() => {
        post({ type: 'ready' })
        return () => { stopTimers(); cancelAnimationFrame(restoreFrame) }
    })
</script>

<svelte:window onmessage={receive} onkeydown={escape} />
<svelte:document onvisibilitychange={() => { if (document.hidden) clearPreview() }} />

<main class="sidebar" aria-label="LaTeX project outline"
    style:--indent={`${appearance.indentPx}px`}
    style:--light-part={appearance.colors.light.part} style:--dark-part={appearance.colors.dark.part}
    style:--light-chapter={appearance.colors.light.chapter} style:--dark-chapter={appearance.colors.dark.chapter}
    style:--light-section={appearance.colors.light.section} style:--dark-section={appearance.colors.dark.section}
    style:--light-subsection={appearance.colors.light.subsection} style:--dark-subsection={appearance.colors.dark.subsection}
    style:--light-subsubsection={appearance.colors.light.subsubsection} style:--dark-subsubsection={appearance.colors.dark.subsubsection}
    style:--light-paragraph={appearance.colors.light.paragraph} style:--dark-paragraph={appearance.colors.dark.paragraph}
    style:--light-subparagraph={appearance.colors.light.subparagraph} style:--dark-subparagraph={appearance.colors.dark.subparagraph}>
    <Toolbar mode={snapshot.contentMode} chapterOnly={snapshot.chapterOnly} {chapter} {disabled}
        onmode={mode => changeView(mode)} onscope={() => changeView(snapshot.contentMode, !snapshot.chapterOnly)} onbulk={bulk} />
    {#if snapshot.status !== 'ready' || snapshot.notice}
        <div class="status" role="status">
            <p>{snapshot.notice ?? snapshot.message}</p>
            {#if ['empty', 'unresolved', 'error'].includes(snapshot.status)}
                <button onclick={() => post({ type: 'chooseRoot' })}>Choose project root</button>
            {/if}
        </div>
    {/if}
    {#if appearance.notice}
        <div class="status appearance-notice" role="status">
            <p>{appearance.notice}</p>
            <button onclick={() => post({ type: 'selectPalette' })}>Choose palette</button>
        </div>
    {/if}
    {#if snapshot.diagnostics.length}
        <details class="diagnostics"><summary>Source diagnostics</summary><ul>{#each snapshot.diagnostics as diagnostic, index (index)}<li>{diagnostic}</li>{/each}</ul></details>
    {/if}
    <Tree {roots} {expanded} currentNodeId={snapshot.currentNodeId} focusedNodeId={snapshot.focusedNodeId}
        mode={snapshot.contentMode} {disabled} bind:scroller onfocusid={focus} onnavigate={navigate} ontoggle={toggle}
        onpreview={preview} onleave={leavePreview} oninteraction={clearPreview} onscroll={scroll} />
    <Footer node={detail} ancestors={parents} preview={previewNodeId !== undefined} bind:popoverOpen onkeep={stopTimers} onleave={leavePreview} />
</main>

<style>
    .sidebar { height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden; outline: 1px solid transparent; outline-offset: -1px; }
    .sidebar:focus-within { outline-color: var(--vscode-focusBorder, var(--border)); }
    .status { padding: 6px 8px; color: var(--muted); flex: 0 0 auto; }
    .status p { margin: 0 0 4px; overflow-wrap: anywhere; }
    .status button { font: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 5px 8px; cursor: pointer; }
    .status button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    .diagnostics { flex: 0 1 auto; max-height: 30%; overflow: auto; padding: 4px 8px; color: var(--vscode-editorWarning-foreground, var(--text)); }
    .diagnostics ul { padding-left: 16px; overflow-wrap: anywhere; }
</style>
