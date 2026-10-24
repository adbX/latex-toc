// Adapted from LaTeX Workshop src/outline/structure/latex.ts at
// fb1d13108f1947028edb3d9881ed4843b983a3c8 (MIT, Copyright 2016 James Yu).
// See third-party/LaTeX-Workshop-LICENSE.txt and docs/backend.md.
import { ranks, type OutlineNode } from './model.js'

export interface NumberedNode extends OutlineNode {
    readonly appendix: boolean
    readonly counterValue?: number
    readonly children: NumberedNode[]
}

/** Preserve Workshop's source-derived numbering, separate from display titles. */
export function numberNodes(nodes: NumberedNode[], documentClass?: string): void {
    numberFloats(nodes, documentClass, { counters: {} })
    numberSections(nodes)
}

interface FloatState {
    counters: Record<string, number>
    chapterNumber?: number
    inAppendix?: boolean
}

function numberFloats(nodes: NumberedNode[], documentClass: string | undefined, state: FloatState): void {
    const hierarchical = documentClass === 'report' || documentClass === 'book'
    for (const node of nodes) {
        if (hierarchical && node.appendix && !state.inAppendix) {
            state.inAppendix = true
            state.chapterNumber = 0
            state.counters.figure = 0
            state.counters.table = 0
        }
        if (hierarchical && node.rank === 'chapter' && !node.starred) {
            state.chapterNumber = (node.counterValue ?? state.chapterNumber ?? 0) + 1
            state.counters.figure = 0
            state.counters.table = 0
        }
        if (node.kind !== 'heading') {
            state.counters[node.kind] = (state.counters[node.kind] ?? 0) + 1
            const chapter = state.inAppendix && state.chapterNumber !== undefined
                ? String.fromCharCode(state.chapterNumber + 64)
                : state.chapterNumber?.toString()
            node.number = hierarchical && state.chapterNumber !== undefined && state.chapterNumber > 0
                ? `${chapter}.${state.counters[node.kind]}`
                : state.counters[node.kind].toString()
        }
        numberFloats(node.children, documentClass, state)
    }
}

function numberSections(nodes: NumberedNode[], prefix = '', lowest?: number): void {
    lowest ??= Math.min(...nodes.filter(node => node.rank !== undefined).map(node => ranks.indexOf(node.rank!)))
    let counters: Record<number, number> = {}
    let inAppendix = false
    for (const node of nodes) {
        if (node.appendix && !inAppendix) {
            inAppendix = true
            counters = {}
        }
        if (node.rank === undefined) {
            continue
        }
        const level = ranks.indexOf(node.rank)
        if (!node.starred) {
            counters[level] = (node.counterValue ?? counters[level] ?? 0) + 1
        }
        let number = prefix + '0.'.repeat(level - lowest) + (counters[level] ?? 0)
        if (inAppendix) {
            const segments = number.split('.')
            const first = Number.parseInt(segments[0])
            if (!Number.isNaN(first)) segments[0] = String.fromCharCode(first + 64)
            number = segments.join('.')
        }
        node.number = node.starred ? undefined : number
        numberSections(node.children, number + '.', level + 1)
    }
}
