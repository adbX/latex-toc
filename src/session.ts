import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Outline, OutlineConfig, ReadSource, SourceSnapshot } from './model.js'
import { createSourceParser, type ParsedFile } from './parse.js'
import { assembleOutline } from './project.js'
import { ProcessingLimitError } from './processing.js'

type CachedFile = { text: string; parserRevision: number } & ({ parsed: ParsedFile } | { error: unknown })
interface RootState {
    generation: number
    files: Map<string, CachedFile>
}

let nextSession = 0

/** Incremental source parsing with isolated reconciliation history for each root. */
export class OutlineSession {
    private config: OutlineConfig
    private parseSource: (source: SourceSnapshot) => ParsedFile
    private parserRevision = 0
    private configurationRevision = 0
    private readonly roots = new Map<string, RootState>()
    private readonly identityPrefix = `s${++nextSession}e`
    private nextIdentity = 0

    constructor(config: OutlineConfig = {}) {
        this.config = { sectionCommands: { ...config.sectionCommands }, texDirs: [...(config.texDirs ?? [])] }
        this.parseSource = createSourceParser(this.config)
    }

    configure(config: OutlineConfig): void {
        const next = { sectionCommands: { ...config.sectionCommands }, texDirs: [...(config.texDirs ?? [])] }
        const previousAliases = Object.entries(this.config.sectionCommands ?? {}).sort(([a], [b]) => a.localeCompare(b))
        const nextAliases = Object.entries(next.sectionCommands).sort(([a], [b]) => a.localeCompare(b))
        if (JSON.stringify(nextAliases) !== JSON.stringify(previousAliases)) {
            this.parseSource = createSourceParser(next)
            this.parserRevision++
        }
        this.config = next
        this.configurationRevision++
    }

    async build(root: string, read: ReadSource, signal?: AbortSignal): Promise<Outline> {
        signal?.throwIfAborted()
        root = pathToFileURL(fileURLToPath(root)).href
        let state = this.roots.get(root)
        if (state === undefined) {
            state = { generation: 0, files: new Map() }
            this.roots.set(root, state)
        }
        const generation = ++state.generation
        const previous = state.files
        const config = this.config
        const parseSource = this.parseSource
        const parserRevision = this.parserRevision
        const configurationRevision = this.configurationRevision
        const files = new Map<string, CachedFile>()
        const parse = (source: SourceSnapshot): ParsedFile => {
            signal?.throwIfAborted()
            const cached = previous.get(source.uri)
            if (cached?.text === source.text && cached.parserRevision === parserRevision) {
                if ('error' in cached) {
                    files.set(source.uri, cached)
                    throw cached.error
                }
                // A version-only buffer edit does not require a parse, but its version is current.
                const parsed = cached.parsed.source === source ? cached.parsed : { ...cached.parsed, source }
                files.set(source.uri, { text: source.text, parserRevision, parsed })
                return parsed
            }
            try {
                const parsed = parseSource(source)
                signal?.throwIfAborted()
                const matches = cached !== undefined && 'parsed' in cached ? reconcile(cached.parsed, parsed) : new Map<number, string>()
                const identified: ParsedFile = {
                    ...parsed,
                    events: parsed.events.map((event, index) => ({
                        ...event,
                        identity: matches.get(index) ?? `${this.identityPrefix}${++this.nextIdentity}`,
                    })),
                }
                files.set(source.uri, { text: source.text, parserRevision, parsed: identified })
                return identified
            } catch (error) {
                signal?.throwIfAborted()
                if (error instanceof ProcessingLimitError || (error instanceof Error && error.name === 'AbortError')) throw error
                files.set(source.uri, { text: source.text, parserRevision, error })
                throw error
            }
        }
        const outline = await assembleOutline(root, read, config, parse, signal)
        signal?.throwIfAborted()
        // Missing, unreachable and failed files lose their old identity evidence. A superseded
        // completion must not roll that history back, even if its I/O finished last.
        if (state.generation === generation && this.configurationRevision === configurationRevision) state.files = files
        return outline
    }
}

interface Evidence {
    readonly command: string
    readonly body?: string
}

function evidence(file: ParsedFile): Evidence[] {
    return file.events.map((event, index) => {
        // Raw command evidence distinguishes equal rendered titles, caption/float kinds,
        // aliases and starred ranks. Offsets locate evidence; they are never matching keys.
        const command = JSON.stringify([
            event.type,
            'command' in event ? event.command : undefined,
            event.type === 'heading' ? event.rank : undefined,
            file.source.text.slice(event.range.start.offset, event.range.end.offset),
        ])
        // A file suffix (such as \end{document}) is not occurrence evidence: deleting
        // either of two identical final commands would leave that same suffix behind.
        const nextStart = file.events[index + 1]?.range.start.offset ?? event.range.end.offset
        const body = file.source.text.slice(event.range.end.offset, Math.max(event.range.end.offset, nextStart)).trim()
        return { command, body: body ? JSON.stringify([command, body]) : undefined }
    })
}

/** Unique, order-preserving source anchors only; no arbitrary LCS tie-breaking for duplicates. */
function reconcile(previous: ParsedFile, current: ParsedFile): Map<number, string> {
    const before = evidence(previous)
    const after = evidence(current)
    const matches = new Map<number, string>()
    // Retain duplicate positions only when the changed source interval touches no
    // commands. An equal command sequence alone can hide a deletion/replacement.
    if (before.length === after.length && before.every((item, index) => item.command === after[index].command)) {
        const oldText = previous.source.text
        const newText = current.source.text
        let start = 0
        while (start < oldText.length && start < newText.length && oldText[start] === newText[start]) start++
        let oldEnd = oldText.length
        let newEnd = newText.length
        while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) { oldEnd--; newEnd-- }
        if (previous.events.every(event => event.range.end.offset <= start || event.range.start.offset >= oldEnd)
            && current.events.every(event => event.range.end.offset <= start || event.range.start.offset >= newEnd)) {
            previous.events.forEach((event, index) => { if (event.identity !== undefined) matches.set(index, event.identity) })
            return matches
        }
    }
    const intervals = [{ oldStart: 0, oldEnd: before.length, newStart: 0, newEnd: after.length }]
    while (intervals.length > 0) {
        const { oldStart, oldEnd, newStart, newEnd } = intervals.pop()!
        if (oldStart === oldEnd || newStart === newEnd) continue
        const candidates = new Map<number, Set<number>>()
        for (const key of ['command', 'body'] as const) {
            const oldUnique = unique(before, oldStart, oldEnd, key)
            const newUnique = unique(after, newStart, newEnd, key)
            for (const [value, newIndex] of newUnique) {
                const oldIndex = oldUnique.get(value)
                if (newIndex < 0 || oldIndex === undefined || oldIndex < 0) continue
                const options = candidates.get(newIndex) ?? new Set<number>()
                options.add(oldIndex)
                candidates.set(newIndex, options)
            }
        }
        const oldCounts = new Map<number, number>()
        for (const options of candidates.values()) {
            for (const oldIndex of options) oldCounts.set(oldIndex, (oldCounts.get(oldIndex) ?? 0) + 1)
        }
        const ordered: { oldIndex: number; newIndex: number }[] = []
        for (const [newIndex, options] of candidates) {
            if (options.size !== 1) continue
            const oldIndex = options.values().next().value!
            if (oldCounts.get(oldIndex) === 1) ordered.push({ oldIndex, newIndex })
        }
        ordered.sort((a, b) => a.newIndex - b.newIndex)
        const suffixMinimum = new Array<number>(ordered.length + 1)
        suffixMinimum[ordered.length] = oldEnd
        for (let index = ordered.length - 1; index >= 0; index--) {
            suffixMinimum[index] = Math.min(ordered[index].oldIndex, suffixMinimum[index + 1])
        }
        let maximum = oldStart - 1
        let oldCursor = oldStart
        let newCursor = newStart
        for (let index = 0; index < ordered.length; index++) {
            const { oldIndex, newIndex } = ordered[index]
            const orderedAnchor = oldIndex > maximum && oldIndex < suffixMinimum[index + 1]
            maximum = Math.max(maximum, oldIndex)
            if (!orderedAnchor) continue
            const identity = previous.events[oldIndex].identity
            if (identity !== undefined) matches.set(newIndex, identity)
            intervals.push({ oldStart: oldCursor, oldEnd: oldIndex, newStart: newCursor, newEnd: newIndex })
            oldCursor = oldIndex + 1
            newCursor = newIndex + 1
        }
        // If no anchor survived, this entire interval is ambiguous. Do not match by index.
        if (oldCursor !== oldStart) {
            intervals.push({ oldStart: oldCursor, oldEnd, newStart: newCursor, newEnd })
        }
    }
    return matches
}

function unique(events: readonly Evidence[], start: number, end: number, key: keyof Evidence): Map<string, number> {
    const indices = new Map<string, number>()
    const incomplete = new Set<string>()
    if (key === 'body') {
        // A lone trailing body cannot distinguish which of two adjacent identical
        // commands was deleted. Every occurrence must carry independent evidence.
        for (let index = start; index < end; index++) {
            if (events[index].body === undefined) incomplete.add(events[index].command)
        }
    }
    for (let index = start; index < end; index++) {
        if (incomplete.has(events[index].command)) continue
        const value = events[index][key]
        if (value !== undefined) indices.set(value, indices.has(value) ? -1 : index)
    }
    return indices
}
