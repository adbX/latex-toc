<script lang="ts">
    import { titleOf, visibleRows, type TreeNode } from './outline.js'
    import { nodeType } from './breadcrumb.js'

    let { roots, expanded, currentNodeId, focusedNodeId, mode, disabled, scroller = $bindable(), onfocusid, onnavigate, ontoggle, onpreview, onleave, oninteraction, onscroll }: {
        roots: readonly TreeNode[]
        expanded: ReadonlySet<string>
        currentNodeId?: string
        focusedNodeId?: string
        mode: 'headings' | 'floats'
        disabled: boolean
        scroller?: HTMLDivElement
        onfocusid: (id: string) => void
        onnavigate: (id: string) => void
        ontoggle: (id: string, expanded: boolean) => void
        onpreview: (id: string) => void
        onleave: () => void
        oninteraction: () => void
        onscroll: (top: number) => void
    } = $props()

    let rows = $derived(visibleRows(roots, expanded))
    let tabstop = $derived(rows.find(item => item.node.id === focusedNodeId)?.node.id
        ?? rows.find(item => item.node.id === currentNodeId)?.node.id ?? rows[0]?.node.id)
    const elements = new Map<string, HTMLLIElement>()

    function register(id: string) {
        return (element: HTMLLIElement) => {
            elements.set(id, element)
            return () => { elements.delete(id) }
        }
    }

    function focusRow(id?: string): void {
        if (!id) return
        const element = elements.get(id)
        element?.focus({ preventScroll: true })
        if (element && scroller) {
            const box = element.firstElementChild!.getBoundingClientRect()
            const viewport = scroller.getBoundingClientRect()
            if (box.top < viewport.top) scroller.scrollTop += box.top - viewport.top
            else if (box.bottom > viewport.bottom) scroller.scrollTop += box.bottom - viewport.bottom
        }
    }

    function keydown(event: KeyboardEvent, item: TreeNode): void {
        if (event.target !== event.currentTarget || disabled) return
        if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' '].includes(event.key)) return
        event.preventDefault()
        event.stopPropagation()
        oninteraction()
        const id = item.node.id
        const index = rows.findIndex(row => row.node.id === id)
        if (event.key === 'ArrowDown') focusRow(rows[Math.min(index + 1, rows.length - 1)]?.node.id)
        else if (event.key === 'ArrowUp') focusRow(rows[Math.max(index - 1, 0)]?.node.id)
        else if (event.key === 'Home') focusRow(rows[0]?.node.id)
        else if (event.key === 'End') focusRow(rows.at(-1)?.node.id)
        else if (event.key === 'ArrowRight' && item.children.length) {
            if (!expanded.has(id)) ontoggle(id, true)
            else focusRow(item.children[0].node.id)
        } else if (event.key === 'ArrowLeft') {
            if (item.children.length && expanded.has(id)) ontoggle(id, false)
            else focusRow(item.parentId)
        } else if (event.key === 'Enter' || event.key === ' ') onnavigate(id)
    }

    function click(event: MouseEvent, item: TreeNode): void {
        event.stopPropagation()
        if (disabled) return
        oninteraction()
        focusRow(item.node.id)
        if ((event.target as HTMLElement).closest('[data-disclosure]')) ontoggle(item.node.id, !expanded.has(item.node.id))
        else onnavigate(item.node.id)
    }
</script>

{#snippet branch(items: readonly TreeNode[], depth: number)}
    {#each items as item, index (item.node.id)}
        <li role="treeitem" class={['treeitem', { current: item.node.id === currentNodeId, parent: item.children.length > 0 }]}
            data-node-id={item.node.id} data-rank={item.node.rank}
            aria-label={`${nodeType(item.node)}${item.node.number ? ` ${item.node.number}` : ''}: ${titleOf(item.node)}`}
            aria-level={depth} aria-posinset={index + 1} aria-setsize={items.length}
            aria-expanded={item.children.length ? expanded.has(item.node.id) : undefined}
            aria-selected={item.node.id === currentNodeId} aria-current={item.node.id === currentNodeId ? 'location' : undefined}
            aria-disabled={disabled} tabindex={item.node.id === tabstop ? 0 : -1}
            {@attach register(item.node.id)}
            onfocus={() => onfocusid(item.node.id)}
            onclick={event => click(event, item)} onkeydown={event => keydown(event, item)}>
            <div class="row" role="presentation" onpointerenter={() => onpreview(item.node.id)} onpointerleave={onleave}>
                {#if mode === 'headings'}
                    <span class="twisty" data-disclosure={item.children.length ? '' : undefined} aria-hidden="true">
                        {#if item.children.length}
                            <svg class={expanded.has(item.node.id) ? 'open' : ''} viewBox="0 0 24 24" focusable="false"><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" /></svg>
                        {/if}
                    </span>
                {:else}
                    <span class="float-kind">{nodeType(item.node)}</span>
                {/if}
                <span class="title rank-color" data-rank={item.node.rank}>{titleOf(item.node)}</span>
            </div>
            {#if item.children.length && expanded.has(item.node.id)}
                <ul role="group" class={item.children.some(child => child.node.id === currentNodeId) ? 'nearest' : ''}>
                    {@render branch(item.children, depth + 1)}
                </ul>
            {/if}
        </li>
    {/each}
{/snippet}

<div class="tree-scroll" bind:this={scroller} onscroll={() => onscroll(scroller?.scrollTop ?? 0)} onwheel={oninteraction}>
    {#if roots.length}
        <ul class={['tree', { floats: mode === 'floats' }]} role="tree" aria-label={mode === 'headings' ? 'LaTeX headings' : 'Figures and tables'} aria-busy={disabled}>
            {@render branch(roots, 1)}
        </ul>
    {:else}
        <p class="empty">{mode === 'headings' ? 'No supported headings in this scope.' : 'No figures or tables in this scope.'}</p>
    {/if}
</div>

<style>
    .tree-scroll { flex: 1; min-height: 0; overflow: auto; overflow-anchor: none; overscroll-behavior: contain; scrollbar-color: var(--border) var(--surface); scrollbar-gutter: stable; padding: 3px 5px 6px; }
    ul { list-style: none; margin: 0; padding: 0; }
    .treeitem { position: relative; outline: none; min-width: 0; }
    .row { position: relative; display: flex; align-items: center; gap: 3px; height: 22px; padding: 0 5px 0 3px; border-radius: 2px; cursor: pointer; }
    .row:hover { background: var(--hover); }
    .treeitem:focus-visible > .row { outline: 1px dashed var(--vscode-focusBorder, var(--text)); outline-offset: -1px; background: var(--focus); }
    .treeitem.current > .row { background: var(--selected); }
    .treeitem[aria-disabled='true'] > .row { cursor: default; }
    .twisty { display: flex; align-items: center; justify-content: center; width: 16px; flex: 0 0 16px; height: 22px; color: var(--muted); }
    .twisty[data-disclosure]:hover { background: var(--selected); color: var(--text); }
    svg { width: 10px; height: 10px; fill: currentColor; pointer-events: none; }
    svg.open { transform: rotate(90deg); }
    .title { color: var(--node-color, var(--text)); font-size: inherit; font-weight: 400; line-height: 22px; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .treeitem[data-rank='chapter'] { margin-top: 5px; border-top: 1px solid var(--rule); }
    .treeitem[data-rank='chapter']:first-child { margin-top: 0; border-top: none; }
    .treeitem[data-rank='chapter']:not(.current):not(:focus-visible) > .row:not(:hover) { background: var(--grouped); }
    .treeitem[data-rank='section'] { margin-top: 3px; }
    .treeitem[data-rank='chapter'] > .row .title { font-weight: 600; }
    .treeitem[data-rank='section'] > .row .title, .treeitem[data-rank='subsection'] > .row .title { font-weight: 500; }
    .treeitem.current > .row .title, .treeitem.parent[data-rank='subsection'] > .row .title { font-weight: 600; }
    ul[role='group'] { position: relative; margin-left: var(--indent); }
    ul.nearest::before { content: ''; position: absolute; left: calc(10.5px - var(--indent)); top: 0; bottom: 0; width: 1px; background: var(--border); pointer-events: none; }
    .float-kind { font-size: .846154em; color: var(--muted); min-width: 34px; }
    .floats .row { gap: 6px; padding-left: 7px; }
    .empty { margin: 0; padding: 8px 5px; color: var(--muted); }
</style>
