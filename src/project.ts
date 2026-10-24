import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ranks, type ContainmentSpan, type ContainingNode, type Diagnostic, type Outline, type OutlineConfig, type OutlineNode, type ReadSource, type SourceSnapshot } from './model.js'
import { createSourceParser, type ParsedFile } from './parse.js'
import { numberNodes, type NumberedNode } from './numbering.js'
import { MAX_FILE_OCCURRENCES, MAX_PROJECT_BYTES, MAX_STRUCTURAL_EVENTS, ProcessingLimitError, sourceBytes, yieldProcessing } from './processing.js'

/** One explicit root and a consistent set of source snapshots, without editor/global state. */
export async function buildOutline(root: string, read: ReadSource, config: OutlineConfig = {}, signal?: AbortSignal): Promise<Outline> {
    return assembleOutline(root, read, config, createSourceParser(config), signal)
}

/** Assemble fresh graph state with either a one-shot or session-cached source parser. */
export async function assembleOutline(
    root: string,
    read: ReadSource,
    config: OutlineConfig,
    parseSource: (source: SourceSnapshot) => ParsedFile,
    signal?: AbortSignal,
): Promise<Outline> {
    signal?.throwIfAborted()
    root = pathToFileURL(fileURLToPath(root)).href
    const snapshots = new Map<string, SourceSnapshot | undefined>()
    const parsed = new Map<string, ParsedFile | undefined>()
    const diagnostics: Diagnostic[] = []
    const nodes: NumberedNode[] = []
    const flat: NumberedNode[] = []
    const spans: ContainmentSpan[] = []
    const includes: { from: string; to: string; occurrence: string }[] = []
    const stack: NumberedNode[] = []
    const pending: Record<string, number> = {}
    let appendix = false
    let current: NumberedNode | undefined
    let projectBytes = 0
    let occurrences = 0
    let events = 0
    let work = 0

    function reserveOccurrence(): void {
        signal?.throwIfAborted()
        if (occurrences === MAX_FILE_OCCURRENCES) {
            throw new ProcessingLimitError('file-occurrences', 'Expanded project exceeds 10,000 file occurrences.')
        }
        occurrences++
    }

    async function snapshot(uri: string): Promise<SourceSnapshot | undefined> {
        signal?.throwIfAborted()
        if (!snapshots.has(uri)) {
            const source = await read(uri)
            signal?.throwIfAborted()
            if (source !== undefined) {
                const bytes = sourceBytes(source)
                if (projectBytes + bytes > MAX_PROJECT_BYTES) {
                    throw new ProcessingLimitError('project-bytes', 'Unique project sources exceed 32 MiB of UTF-8 text.')
                }
                projectBytes += bytes
            }
            snapshots.set(uri, source)
        }
        return snapshots.get(uri)
    }

    async function parse(uri: string): Promise<ParsedFile | undefined> {
        if (!parsed.has(uri)) {
            const source = await snapshot(uri)
            signal?.throwIfAborted()
            try {
                parsed.set(uri, source === undefined ? undefined : parseSource(source))
                signal?.throwIfAborted()
            } catch (error) {
                signal?.throwIfAborted()
                if (error instanceof ProcessingLimitError || (error instanceof Error && error.name === 'AbortError')) throw error
                diagnostics.push({ code: 'parse-error', uri, message: error instanceof Error ? error.message : String(error) })
                parsed.set(uri, undefined)
            }
        }
        return parsed.get(uri)
    }

    async function expand(uri: string, occurrence: string, ancestors: readonly string[]): Promise<void> {
        signal?.throwIfAborted()
        if (++work % 256 === 0) await yieldProcessing(signal)
        const file = await parse(uri)
        if (file === undefined) {
            return
        }
        let cursor = 0
        const span = (end: number, endOfFile = false) => {
            if (end > cursor || endOfFile) {
                spans.push({ uri, occurrence, start: cursor, end, endOfFile, headingId: current?.id })
            }
            cursor = end
        }
        for (const event of file.events) {
            signal?.throwIfAborted()
            if (events === MAX_STRUCTURAL_EVENTS) {
                throw new ProcessingLimitError('structural-events', 'Expanded project exceeds 100,000 structural events.')
            }
            events++
            if (++work % 256 === 0) await yieldProcessing(signal)
            if (event.type === 'appendix') {
                appendix = true
                continue
            }
            if (event.type === 'counter') {
                pending[event.name] = event.value
                continue
            }
            if (event.type === 'include') {
                span(event.range.end.offset)
                const directories = [dirname(fileURLToPath(uri)), dirname(fileURLToPath(root)), ...(config.texDirs ?? [])]
                let target: string | undefined
                for (const directory of directories) {
                    let path = resolve(directory, event.path)
                    if (!extname(path)) path += '.tex'
                    const candidates = [path, path + '.tex']
                    for (const candidate of candidates) {
                        const candidateUri = pathToFileURL(candidate).href
                        if (await snapshot(candidateUri) !== undefined) {
                            target = candidateUri
                            break
                        }
                    }
                    if (target !== undefined) {
                        break
                    }
                }
                if (target === undefined) {
                    diagnostics.push({ code: 'missing-include', uri, range: event.range, message: `Cannot resolve ${event.command}{${event.path}}` })
                } else {
                    const cycle = ancestors.includes(target)
                    if (!cycle) reserveOccurrence()
                    const childOccurrence = `${occurrence}/i${event.identity ?? event.ordinal}`
                    includes.push({ from: uri, to: target, occurrence: childOccurrence })
                    if (cycle) {
                        diagnostics.push({ code: 'include-cycle', uri, range: event.range, message: `Include cycle to ${target}` })
                    } else {
                        await expand(target, childOccurrence, [...ancestors, target])
                    }
                }
                continue
            }
            if (event.type === 'heading') {
                span(event.range.start.offset)
                while (stack.length > 0 && ranks.indexOf(stack[stack.length - 1].rank!) >= ranks.indexOf(event.rank)) {
                    stack.pop()
                }
            }
            const parent = stack[stack.length - 1]
            const node: NumberedNode = {
                id: `${occurrence}/n${event.identity ?? event.ordinal}`,
                occurrence,
                kind: event.type === 'heading' ? 'heading' : event.kind,
                command: event.command,
                rank: event.type === 'heading' ? event.rank : undefined,
                title: event.title,
                starred: event.type === 'heading' && event.starred,
                uri,
                range: event.range,
                parentId: parent?.id,
                children: [],
                appendix,
                counterValue: event.type === 'heading' && !event.starred ? pending[event.rank] : undefined,
            }
            if (event.type === 'heading' && !event.starred) {
                delete pending[event.rank]
            }
            ;(parent?.children ?? nodes).push(node)
            flat.push(node)
            if (event.type === 'heading') {
                stack.push(node)
                current = node
            }
        }
        span(file.source.text.length, true)
    }

    const rootSource = await snapshot(root)
    if (rootSource === undefined) {
        diagnostics.push({ code: 'missing-root', uri: root, message: 'The selected root does not exist.' })
    } else {
        reserveOccurrence()
        await expand(root, 'root', [root])
        signal?.throwIfAborted()
        numberNodes(nodes, parsed.get(root)?.documentClass)
    }
    signal?.throwIfAborted()
    return {
        root, nodes, flat, spans, includes, diagnostics,
        dependencies: [...snapshots.keys()],
        files: [...snapshots.values()].filter((source): source is SourceSnapshot => source !== undefined)
            .map(({ uri, version }) => ({ uri, version })),
    }
}

/** Captions take precedence; ordinary prose follows a heading, never its float environment. */
export function findContaining(outline: Outline, uri: string, offset: number, occurrence?: string): ContainingNode {
    uri = pathToFileURL(fileURLToPath(uri)).href
    const matches = new Map<string, OutlineNode>()
    for (const node of outline.flat) {
        if (node.kind !== 'heading' && node.uri === uri && (occurrence === undefined || node.occurrence === occurrence)
            && offset >= node.range.start.offset && offset < node.range.end.offset) {
            matches.set(node.id, node)
        }
    }
    if (matches.size === 0) {
        const ids = new Set(outline.spans.filter(span => span.uri === uri && offset >= span.start
            && (offset < span.end || (span.endOfFile && offset === span.end))
            && (occurrence === undefined || span.occurrence === occurrence)).map(span => span.headingId))
        for (const node of outline.flat) {
            if (ids.has(node.id)) {
                matches.set(node.id, node)
            }
        }
    }
    const candidates = [...matches.values()]
    if (candidates.length === 0) {
        return { kind: 'none' }
    }
    return candidates.length === 1 ? { kind: 'match', node: candidates[0] } : { kind: 'ambiguous', candidates }
}
