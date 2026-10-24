export const ranks = ['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph'] as const
export type Rank = typeof ranks[number]

/** Local file URI, editor text, and its document version (or a disk revision). */
export interface SourceSnapshot {
    readonly uri: string
    readonly text: string
    readonly version: number | string
}

export type ReadSource = (uri: string) => Promise<SourceSnapshot | undefined>

export interface OutlineConfig {
    readonly sectionCommands?: Readonly<Record<string, Rank>>
    /** Absolute local directory paths, searched after the source and root directories. */
    readonly texDirs?: readonly string[]
}

export interface Position {
    readonly line: number
    readonly character: number
    readonly offset: number
}

export interface SourceRange {
    readonly start: Position
    readonly end: Position
}

export interface OutlineNode {
    readonly id: string
    readonly occurrence: string
    readonly kind: 'heading' | 'figure' | 'table'
    readonly command: string
    readonly rank?: Rank
    readonly title: string
    readonly starred: boolean
    readonly uri: string
    /** Exact heading/caption command; an uncaptioned float targets its environment. */
    readonly range: SourceRange
    readonly parentId?: string
    readonly children: OutlineNode[]
    number?: string
}

export interface ContainmentSpan {
    readonly uri: string
    readonly occurrence: string
    readonly start: number
    readonly end: number
    readonly endOfFile?: boolean
    readonly headingId?: string
}

export interface Diagnostic {
    readonly code: 'missing-root' | 'missing-include' | 'include-cycle' | 'parse-error'
    readonly uri: string
    readonly message: string
    readonly range?: SourceRange
}

export interface Outline {
    readonly root: string
    readonly nodes: readonly OutlineNode[]
    readonly flat: readonly OutlineNode[]
    readonly spans: readonly ContainmentSpan[]
    readonly files: readonly { uri: string; version: number | string }[]
    readonly includes: readonly { from: string; to: string; occurrence: string }[]
    /** Every attempted source URI, including missing include candidates and the root. */
    readonly dependencies: readonly string[]
    readonly diagnostics: readonly Diagnostic[]
}

export type ContainingNode =
    | { readonly kind: 'match'; readonly node: OutlineNode }
    | { readonly kind: 'none' }
    | { readonly kind: 'ambiguous'; readonly candidates: readonly OutlineNode[] }
