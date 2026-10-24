<script lang="ts">
    import { onMount } from 'svelte'
    import type { ViewNode } from '../host/messages.js'
    import { nodeReference } from './breadcrumb.js'

    interface Props {
        ancestors: readonly ViewNode[]
        anchor: HTMLButtonElement
        footer: HTMLElement
        onclose: (returnFocus: boolean) => void
        onkeep: () => void
        onleave: () => void
    }

    let { ancestors, anchor, footer, onclose, onkeep, onleave }: Props = $props()
    let panel: HTMLDivElement
    let closeButton: HTMLButtonElement
    let position = $state.raw({ left: 8, top: 8, width: 0, maxHeight: 0 })

    export function focusClose(): void {
        closeButton?.focus({ preventScroll: true })
    }

    function place(): void {
        if (!panel || !footer) return
        const margin = 8
        const gap = 6
        const box = footer.getBoundingClientRect()
        const width = Math.max(0, Math.min(420, window.innerWidth - margin * 2))
        const above = box.top - gap - margin
        const maxHeight = Math.max(0, above >= 64 ? above : window.innerHeight - margin * 2)
        const height = Math.min(panel.scrollHeight + 2, maxHeight)
        const left = Math.max(margin, Math.min(box.left, window.innerWidth - width - margin))
        const top = Math.max(margin, box.top - height - gap)
        if (left !== position.left || top !== position.top || width !== position.width || maxHeight !== position.maxHeight) {
            position = { left, top, width, maxHeight }
        }
    }

    function contains(target: EventTarget | null): boolean {
        return target instanceof Node && (panel?.contains(target) || anchor.contains(target))
    }

    function outside(event: PointerEvent): void {
        if (!contains(event.target)) onclose(false)
    }

    function focusChanged(event: FocusEvent): void {
        if (!(event.target instanceof Node) || !panel?.contains(event.target)) onclose(false)
    }

    function focusLeft(event: FocusEvent): void {
        if (!(event.relatedTarget instanceof Node) || !panel?.contains(event.relatedTarget)) onclose(false)
    }

    function escape(event: KeyboardEvent): void {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopImmediatePropagation()
        onclose(true)
    }

    onMount(() => {
        const observer = new ResizeObserver(place)
        observer.observe(footer)
        observer.observe(panel)
        place()
        return () => observer.disconnect()
    })
</script>

<svelte:window onresize={place} />
<svelte:document onpointerdowncapture={outside} onfocusin={focusChanged} onkeydowncapture={escape} />

<div
    bind:this={panel}
    class="ancestry-popover"
    role="dialog"
    aria-label="Full ancestry"
    tabindex="-1"
    style:left={`${position.left}px`}
    style:top={`${position.top}px`}
    style:width={`${position.width}px`}
    style:max-height={`${position.maxHeight}px`}
    onpointerenter={onkeep}
    onpointerleave={onleave}
    onfocusout={focusLeft}
>
    <header>
        <h3>Full ancestry</h3>
        <button bind:this={closeButton} type="button" onclick={() => onclose(true)}>Close</button>
    </header>
    <ol>
        {#each ancestors as ancestor (ancestor.id)}
            <li class="rank-color" data-rank={ancestor.rank}>
                <span class="reference">{nodeReference(ancestor)}</span>
                <span class="title">{ancestor.title}</span>
            </li>
        {/each}
    </ol>
</div>

<style>
    .ancestry-popover {
        position: fixed;
        z-index: 10;
        box-sizing: border-box;
        margin: 0;
        padding: 8px 10px;
        overflow: auto;
        background: var(--surface);
        color: var(--text);
        border: 1px solid var(--border);
        border-radius: 3px;
        box-shadow: 0 4px 16px color-mix(in srgb, var(--text) 16%, transparent);
        font: inherit;
        font-weight: 500;
        line-height: 1.4;
    }

    header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
    }

    h3 {
        margin: 0;
        font-size: inherit;
        font-weight: 600;
    }

    button {
        min-height: 24px;
        padding: 1px 5px;
        border: 1px solid var(--border);
        border-radius: 2px;
        background: var(--surface);
        color: var(--text);
        font: inherit;
        cursor: pointer;
    }

    button:hover { background: var(--hover); }
    button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }

    ol {
        list-style: none;
        margin: 6px 0 0;
        padding: 0;
    }

    li {
        display: flex;
        align-items: baseline;
        gap: 6px;
        padding: 4px 0;
        color: var(--node-color, var(--text));
        border-top: 1px solid var(--rule);
    }

    li:first-child { border-top: 0; padding-top: 0; }
    .reference { flex: 0 0 auto; white-space: nowrap; }
    .title { min-width: 0; overflow-wrap: anywhere; }
</style>
