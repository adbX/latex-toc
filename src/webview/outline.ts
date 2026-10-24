import type { HostState, ViewNode } from '../host/messages.js'
import { isAppearanceState } from '../appearance.js'
import type { Rank } from '../model.js'

export interface TreeNode {
    readonly node: ViewNode
    readonly parentId?: string
    readonly children: TreeNode[]
}

export function indexOutline(nodes: readonly ViewNode[]): Map<string, ViewNode> {
    return new Map(nodes.map(node => [node.id, node]))
}

export function ancestry(byId: ReadonlyMap<string, ViewNode>, id?: string): ViewNode[] {
    const path: ViewNode[] = []
    for (let node = id ? byId.get(id) : undefined; node; node = node.parentId ? byId.get(node.parentId) : undefined) path.push(node)
    return path.reverse()
}

export function chapterFor(byId: ReadonlyMap<string, ViewNode>, id?: string): ViewNode | undefined {
    for (let node = id ? byId.get(id) : undefined; node; node = node.parentId ? byId.get(node.parentId) : undefined) {
        if (node.kind === 'heading' && node.rank === 'chapter') return node
    }
    return undefined
}

export function headingTree(nodes: readonly ViewNode[], byId: ReadonlyMap<string, ViewNode>, visibleRanks: readonly Rank[]): TreeNode[] {
    const roots: TreeNode[] = []
    const displayed = new Map<string, TreeNode>()
    const visible = new Set(visibleRanks)
    for (const node of nodes) {
        if (node.kind !== 'heading' || !node.rank || !visible.has(node.rank)) continue
        let parent = node.parentId ? byId.get(node.parentId) : undefined
        while (parent && !displayed.has(parent.id)) parent = parent.parentId ? byId.get(parent.parentId) : undefined
        const item: TreeNode = { node, parentId: parent?.id, children: [] }
        displayed.set(node.id, item)
        if (parent) displayed.get(parent.id)!.children.push(item)
        else roots.push(item)
    }
    return roots
}

export function scopedTree(roots: readonly TreeNode[], byId: ReadonlyMap<string, ViewNode>, chapterId?: string): readonly TreeNode[] {
    if (!chapterId) return roots
    const scoped: TreeNode[] = []
    const visit = (items: readonly TreeNode[]) => {
        for (const item of items) {
            if (chapterFor(byId, item.node.id)?.id === chapterId) {
                // A hidden chapter can leave its descendants under a visible part.
                // Detach only the displayed parent; canonical ancestry stays intact.
                scoped.push(item.parentId ? { ...item, parentId: undefined } : item)
            } else visit(item.children)
        }
    }
    visit(roots)
    return scoped
}

export function visibleRows(roots: readonly TreeNode[], expanded: ReadonlySet<string>): TreeNode[] {
    const result: TreeNode[] = []
    const visit = (items: readonly TreeNode[]) => {
        for (const item of items) {
            result.push(item)
            if (expanded.has(item.node.id)) visit(item.children)
        }
    }
    visit(roots)
    return result
}

export function titleOf(node: ViewNode): string {
    return node.title || (node.kind === 'heading' ? '(Untitled heading)' : '(No caption)')
}

export function isHostState(value: unknown): value is HostState {
    if (!value || typeof value !== 'object') return false
    const state = value as HostState
    return state.type === 'state' && Number.isSafeInteger(state.version) && state.version >= 0
        && ['empty', 'loading', 'ready', 'unresolved', 'error', 'unsupported'].includes(state.status)
        && typeof state.message === 'string' && (state.notice === undefined || typeof state.notice === 'string')
        && typeof state.followEditor === 'boolean' && typeof state.chapterOnly === 'boolean'
        && isAppearanceState(state.appearance)
        && ['headings', 'floats'].includes(state.contentMode)
        && Number.isFinite(state.scrollTop) && state.scrollTop >= 0
        && (state.currentNodeId === undefined || typeof state.currentNodeId === 'string')
        && (state.focusedNodeId === undefined || typeof state.focusedNodeId === 'string')
        && (!state.project || typeof state.project.key === 'string')
        && Array.isArray(state.nodes) && state.nodes.every(node => node && typeof node.id === 'string'
            && typeof node.title === 'string' && typeof node.source === 'string'
            && ['heading', 'figure', 'table'].includes(node.kind))
        && Array.isArray(state.expanded) && state.expanded.every(id => typeof id === 'string')
        && Array.isArray(state.diagnostics) && state.diagnostics.every(message => typeof message === 'string')
}
