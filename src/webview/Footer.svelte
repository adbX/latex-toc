<script lang="ts">
    import { onMount, tick } from 'svelte'
    import type { ViewNode } from '../host/messages.js'
    import AncestryPopover from './AncestryPopover.svelte'
    import { fitBreadcrumb, nodeReference, nodeType } from './breadcrumb.js'
    import { titleOf } from './outline.js'

    interface Props {
        node: ViewNode | undefined
        ancestors: readonly ViewNode[]
        preview: boolean
        popoverOpen?: boolean
        onkeep: () => void
        onleave: () => void
    }

    let { node, ancestors, preview, popoverOpen = $bindable(false), onkeep, onleave }: Props = $props()
    let footer = $state<HTMLElement>()
    let breadcrumb = $state<HTMLButtonElement>()
    let measurement = $state<HTMLSpanElement>()
    let ellipsis = $state<HTMLSpanElement>()
    let popover = $state<{ focusClose: () => void }>()
    let metrics = $state.raw<{
        nodes: readonly ViewNode[]
        available: number
        widths: readonly number[]
        minimums: readonly number[]
    }>({ nodes: [], available: 0, widths: [], minimums: [] })
    let lines = $derived(fitBreadcrumb(
        ancestors,
        metrics.nodes === ancestors ? metrics.widths : [],
        metrics.nodes === ancestors ? metrics.minimums : [],
        metrics.available,
    ))
    let ancestryLabel = $derived(ancestors.map(ancestor =>
        `${nodeType(ancestor)}${ancestor.number ? ` ${ancestor.number}` : ''}: ${ancestor.title}`,
    ).join(' › '))
    let frame: number | undefined

    function measure(): void {
        frame = undefined
        if (!breadcrumb || !measurement || !ellipsis) return
        const parts = measurement.querySelectorAll<HTMLElement>('[data-crumb]')
        const widths: number[] = []
        const minimums: number[] = []
        const ellipsisWidth = ellipsis.getBoundingClientRect().width
        for (const part of parts) {
            const reference = part.querySelector<HTMLElement>('.reference')!
            const title = part.querySelector<HTMLElement>('.crumb-title')!
            const separator = part.querySelector<HTMLElement>('.separator')
            widths.push(part.getBoundingClientRect().width)
            minimums.push(reference.getBoundingClientRect().width + 3
                + Math.min(title.getBoundingClientRect().width, ellipsisWidth)
                + (separator ? separator.getBoundingClientRect().width + 4 : 0))
        }
        metrics = { nodes: ancestors, available: breadcrumb.clientWidth, widths, minimums }
    }

    function scheduleMeasure(): void {
        if (frame === undefined) frame = requestAnimationFrame(measure)
    }

    function close(returnFocus: boolean): void {
        if (!popoverOpen) return
        popoverOpen = false
        if (returnFocus) {
            breadcrumb?.focus({ preventScroll: true })
            onkeep()
        } else {
            onleave()
        }
    }

    async function toggleAncestry(): Promise<void> {
        if (popoverOpen) {
            close(true)
            return
        }
        onkeep()
        popoverOpen = true
        await tick()
        if (popoverOpen) popover?.focusClose()
    }

    $effect(() => {
        ancestors
        scheduleMeasure()
    })

    onMount(() => {
        const observer = new ResizeObserver(scheduleMeasure)
        if (breadcrumb) observer.observe(breadcrumb)
        if (measurement) observer.observe(measurement)
        let disposed = false
        void document.fonts.ready.then(() => { if (!disposed) scheduleMeasure() })
        scheduleMeasure()
        return () => {
            disposed = true
            observer.disconnect()
            if (frame !== undefined) cancelAnimationFrame(frame)
        }
    })
</script>

{#snippet crumb(ancestor: ViewNode, separator: boolean, width?: number)}
    <span class="path-part" data-crumb style:width={width === undefined ? undefined : `${width}px`}>
        {#if separator}<span class="separator" aria-hidden="true">›</span>{/if}
        <span class="ancestor rank-color" data-rank={ancestor.rank}>
            <span class="reference">{nodeReference(ancestor)}</span>
            <span class="crumb-title">{ancestor.title}</span>
        </span>
    </span>
{/snippet}

<section
    bind:this={footer}
    class="footer"
    data-preview={preview}
    aria-label={preview ? 'Hover preview' : 'Current location'}
    onpointerenter={onkeep}
    onpointerleave={onleave}
    onfocusin={onkeep}
>
    <div class="detail-title rank-color" data-rank={node?.rank}>
        {node ? titleOf(node) : 'Select a heading or float'}
    </div>
    <button
        bind:this={breadcrumb}
        class="breadcrumb"
        type="button"
        disabled={!ancestors.length}
        aria-haspopup={ancestors.length ? 'dialog' : undefined}
        aria-expanded={ancestors.length ? popoverOpen : undefined}
        aria-label={ancestors.length ? `Show full ancestry: ${ancestryLabel}` : 'Document root'}
        onpointerdown={event => { if (popoverOpen) event.preventDefault() }}
        onclick={toggleAncestry}
    >
        {#each lines as line (line.id)}
            <span class="path-line">
                {#each line.items as item (item.node.id)}
                    {@render crumb(item.node, item.node !== ancestors[0], item.width)}
                {/each}
            </span>
        {:else}
            <span class="root-path">{node ? 'Document root' : 'No current location'}</span>
        {/each}
    </button>
    {#if node}
        <div class="metadata">
            <span class="kind">{nodeType(node)}{node.number ? ` ${node.number}` : ''}</span>
            <span class="source" title={node.source}>{node.source}</span>
        </div>
    {/if}
    <span bind:this={measurement} class="measurement" aria-hidden="true">
        {#each ancestors as ancestor (ancestor.id)}
            {@render crumb(ancestor, ancestor !== ancestors[0])}
        {/each}
    </span>
    <span bind:this={ellipsis} class="measurement ellipsis" aria-hidden="true">…</span>
</section>

{#if popoverOpen && ancestors.length && breadcrumb && footer}
    <AncestryPopover
        bind:this={popover}
        {ancestors}
        anchor={breadcrumb}
        {footer}
        onclose={close}
        {onkeep}
        {onleave}
    />
{/if}

<style>
    .footer {
        flex: 0 0 auto;
        display: grid;
        gap: 1px;
        min-width: 0;
        padding: 4px 8px;
        border-top: 1px solid var(--rule);
        background: var(--footer);
        color: var(--text);
    }

    .footer[data-preview='true'] {
        --preview-tint: color-mix(in srgb, var(--text) 4%, transparent);
        background: linear-gradient(var(--preview-tint), var(--preview-tint)), var(--footer);
    }

    .detail-title {
        font-size: 1em;
        line-height: 1.3077;
        font-weight: 600;
        white-space: normal;
        overflow-wrap: anywhere;
        text-wrap: pretty;
        color: var(--node-color, var(--text));
    }

    .breadcrumb {
        display: grid;
        align-content: start;
        width: 100%;
        min-width: 0;
        min-height: 0;
        margin: 0;
        padding: 0;
        border: 0;
        border-radius: 0;
        background: transparent;
        color: var(--muted);
        font: inherit;
        font-size: 0.923077em;
        font-weight: 500;
        line-height: 1.166667;
        text-align: left;
        cursor: pointer;
        overflow-x: auto;
    }

    .breadcrumb:disabled { cursor: default; opacity: 1; }
    .breadcrumb:focus-visible { outline: 1px dashed var(--vscode-focusBorder); outline-offset: 1px; }
    .breadcrumb:not(:disabled):is(:hover, :focus-visible) .ancestor {
        text-decoration: underline;
        text-underline-offset: 2px;
    }

    .path-line {
        display: flex;
        align-items: baseline;
        gap: 4px;
        width: 100%;
        min-width: 0;
    }

    .path-part {
        display: inline-flex;
        flex: 0 0 auto;
        align-items: baseline;
        gap: 4px;
        min-width: 0;
    }

    .ancestor {
        display: flex;
        align-items: baseline;
        gap: 3px;
        min-width: 0;
        color: var(--node-color, var(--text));
    }

    .reference { flex: 0 0 auto; white-space: nowrap; }
    .crumb-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .separator { flex: 0 0 auto; color: var(--muted); }

    .metadata {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 8px;
        min-width: 0;
        font-size: 0.846154em;
        line-height: 1.181818;
        color: var(--muted);
    }

    .kind, .source { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .kind { flex: 1 1 auto; }
    .source { flex: 0 1 auto; text-align: right; }

    .measurement {
        position: fixed;
        top: 0;
        left: 0;
        display: flex;
        width: max-content;
        visibility: hidden;
        pointer-events: none;
        font-size: 0.923077em;
        font-weight: 500;
        line-height: 1.166667;
    }
</style>
