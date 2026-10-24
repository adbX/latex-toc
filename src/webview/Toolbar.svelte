<script lang="ts">
    import type { ViewNode } from '../host/messages.js'

    let { mode, chapterOnly, chapter, disabled, onmode, onscope, onbulk }: {
        mode: 'headings' | 'floats'
        chapterOnly: boolean
        chapter?: ViewNode
        disabled: boolean
        onmode: (mode: 'headings' | 'floats') => void
        onscope: () => void
        onbulk: (expanded: boolean) => void
    } = $props()

    let scope = $derived(chapterOnly && chapter ? `chapter ${chapter.number ?? ''}: ${chapter.title}` : 'the whole outline')
    let scopeTip = $derived(chapter
        ? `${chapterOnly ? 'Show the whole outline' : 'Limit to current chapter'} (${chapter.number ?? ''} ${chapter.title})`
        : 'Limit to current chapter (no current chapter; showing the whole document)')
</script>

<div class="toolbar" role="group" aria-label="Outline views and expansion">
    <button class="mode" aria-pressed={mode === 'headings'} {disabled} onclick={() => onmode('headings')}>Headings</button>
    <button class="mode" aria-pressed={mode === 'floats'} {disabled} onclick={() => onmode('floats')}>Figures and tables</button>
    <div class="actions">
        <button class="action scope" aria-label="Limit to current chapter" aria-pressed={chapterOnly} title={scopeTip} {disabled} onclick={onscope}>Ch</button>
        <button class="action" aria-label="Collapse all" title={`Collapse all in ${scope}`} disabled={disabled || mode === 'floats'} onclick={() => onbulk(false)}>
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m7 20l5-5l5 5M7 4l5 5l5-5" /></svg>
        </button>
        <button class="action" aria-label="Expand all" title={`Expand all in ${scope}`} disabled={disabled || mode === 'floats'} onclick={() => onbulk(true)}>
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m7 15l5 5l5-5M7 9l5-5l5 5" /></svg>
        </button>
    </div>
</div>

<style>
    .toolbar { display: flex; gap: 2px; padding: 1px 4px; align-items: center; border-bottom: 1px solid var(--rule); flex: 0 0 auto; }
    button { font: inherit; font-size: .923077em; color: var(--muted); background: transparent; border: 1px solid transparent; border-radius: 2px; padding: 2px 6px; min-height: 24px; cursor: pointer; }
    button:hover:not(:disabled) { background: var(--hover); }
    button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -2px; }
    button:disabled { opacity: .4; cursor: default; }
    .mode { white-space: nowrap; }
    .mode[aria-pressed='true'] { color: var(--text); box-shadow: inset 0 -2px var(--text); border-radius: 0; }
    .actions { display: flex; gap: 2px; margin-left: auto; flex: 0 0 auto; }
    .action { display: inline-flex; align-items: center; justify-content: center; width: 28px; flex: 0 0 28px; padding: 3px; }
    svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .scope { font-weight: 600; }
    .scope[aria-pressed='true'] { color: var(--text); background: var(--selected); border-color: var(--border); }
</style>
