import type { AppearanceState } from '../appearance.js'
import type { Rank } from '../model.js'

export interface ViewNode {
    readonly id: string
    readonly parentId?: string
    readonly title: string
    readonly number?: string
    readonly kind: 'heading' | 'figure' | 'table'
    readonly rank?: Rank
    readonly source: string
}

export interface HostState {
    readonly type: 'state'
    readonly status: 'empty' | 'loading' | 'ready' | 'unresolved' | 'error' | 'unsupported'
    readonly message: string
    readonly notice?: string
    readonly project?: { readonly key: string; readonly root: string; readonly scope: string; readonly texDirs: readonly string[] }
    readonly version: number
    readonly nodes: readonly ViewNode[]
    readonly currentNodeId?: string
    readonly focusedNodeId?: string
    readonly contentMode: 'headings' | 'floats'
    readonly chapterOnly: boolean
    readonly expanded: readonly string[]
    readonly scrollTop: number
    readonly followEditor: boolean
    readonly diagnostics: readonly string[]
    readonly appearance: AppearanceState
}

export type ViewMessage =
    | { type: 'ready' }
    | { type: 'chooseRoot' }
    | { type: 'toggleFollow' }
    | { type: 'selectPalette' }
    | { type: 'navigate'; version: number; id: string }
    | { type: 'expand'; version: number; id: string; expanded: boolean }
    | { type: 'scroll'; version: number; top: number }
    | { type: 'focus'; version: number; id: string }
    | { type: 'view'; version: number; contentMode: 'headings' | 'floats'; chapterOnly: boolean }
    | { type: 'bulkExpand'; version: number; expanded: boolean }

/** The webview never supplies source paths, ranges, configuration values, or command names. */
export function parseViewMessage(value: unknown): ViewMessage | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const item = value as Record<string, unknown>
    const keys = Object.keys(item).sort().join(',')
    if (['ready', 'chooseRoot', 'toggleFollow', 'selectPalette'].includes(item.type as string) && keys === 'type') return item as ViewMessage
    if (!Number.isSafeInteger(item.version) || (item.version as number) < 1) return
    if (item.type === 'scroll' && keys === 'top,type,version' && typeof item.top === 'number' && Number.isFinite(item.top) && item.top >= 0) {
        return item as ViewMessage
    }
    if (item.type === 'view' && keys === 'chapterOnly,contentMode,type,version'
        && (item.contentMode === 'headings' || item.contentMode === 'floats') && typeof item.chapterOnly === 'boolean') return item as ViewMessage
    if (item.type === 'bulkExpand' && keys === 'expanded,type,version' && typeof item.expanded === 'boolean') return item as ViewMessage
    if (typeof item.id !== 'string' || !item.id.length || item.id.length > 4096) return
    if ((item.type === 'navigate' || item.type === 'focus') && keys === 'id,type,version') return item as ViewMessage
    if (item.type === 'expand' && keys === 'expanded,id,type,version' && typeof item.expanded === 'boolean') return item as ViewMessage
    return
}
