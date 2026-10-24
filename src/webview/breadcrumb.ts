import type { ViewNode } from '../host/messages.js'

export function nodeType(node: ViewNode): string {
    const kind = node.kind === 'heading' ? node.rank ?? 'heading' : node.kind
    return kind.charAt(0).toUpperCase() + kind.slice(1)
}

export function nodeReference(node: ViewNode): string {
    if (!node.number) return nodeType(node)
    return node.rank === 'chapter' ? `Ch ${node.number}` : node.number
}

export interface BreadcrumbItem {
    readonly node: ViewNode
    readonly width?: number
}

export interface BreadcrumbLine {
    readonly id: string
    readonly items: readonly BreadcrumbItem[]
}

/** Keep all references; share clipping among long titles after choosing at most two rows. */
export function fitBreadcrumb(
    nodes: readonly ViewNode[],
    widths: readonly number[],
    minimums: readonly number[],
    available: number,
): readonly BreadcrumbLine[] {
    if (!nodes.length) return []
    if (widths.length !== nodes.length || available <= 0) {
        return [{ id: nodes[0]!.id, items: nodes.map(node => ({ node })) }]
    }
    const gap = 4
    const total = (values: readonly number[], start: number, end: number): number => {
        let result = gap * Math.max(0, end - start - 1)
        for (let index = start; index < end; index++) result += values[index]!
        return result
    }
    let split = nodes.length
    if (nodes.length > 1 && total(widths, 0, nodes.length) > available) {
        let bestOverflow = Infinity
        let bestLoss = Infinity
        let bestBalance = Infinity
        for (let index = 1; index < nodes.length; index++) {
            const left = total(widths, 0, index)
            const right = total(widths, index, nodes.length)
            const overflow = Math.max(0, total(minimums, 0, index) - available)
                + Math.max(0, total(minimums, index, nodes.length) - available)
            const loss = Math.max(0, left - available) + Math.max(0, right - available)
            const balance = Math.abs(left - right)
            if (overflow < bestOverflow || (overflow === bestOverflow
                && (loss < bestLoss || (loss === bestLoss && balance < bestBalance)))) {
                split = index
                bestOverflow = overflow
                bestLoss = loss
                bestBalance = balance
            }
        }
    }
    const line = (start: number, end: number): BreadcrumbLine => {
        const sizes = widths.slice(start, end)
        let excess = total(widths, start, end) - available
        // Water-fill the longest labels, never clipping a reference or its separator.
        while (excess > 0.1) {
            let largest = 0
            for (let index = 0; index < sizes.length; index++) {
                if (sizes[index]! > minimums[start + index]! + 0.1) largest = Math.max(largest, sizes[index]!)
            }
            if (!largest) break
            const longest: number[] = []
            let next = 0
            for (let index = 0; index < sizes.length; index++) {
                if (sizes[index]! >= largest - 0.1 && sizes[index]! > minimums[start + index]! + 0.1) longest.push(index)
                else if (sizes[index]! < largest - 0.1) next = Math.max(next, sizes[index]!)
            }
            const reduction = Math.min(excess / longest.length, largest - next)
            for (const index of longest) {
                const removed = Math.min(reduction, sizes[index]! - minimums[start + index]!)
                sizes[index] = sizes[index]! - removed
                excess -= removed
            }
        }
        return { id: nodes[start]!.id, items: nodes.slice(start, end).map((node, index) => ({ node, width: sizes[index]! })) }
    }
    return split === nodes.length ? [line(0, split)] : [line(0, split), line(split, nodes.length)]
}
