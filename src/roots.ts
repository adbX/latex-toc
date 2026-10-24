// Root discovery and magic-comment conventions adapted from LaTeX Workshop
// src/core/root.ts at fb1d13108f1947028edb3d9881ed4843b983a3c8.
// MIT, Copyright 2016 James Yu; see third-party/LaTeX-Workshop-LICENSE.txt.
// Intentional differences: current graph first, project-scoped remembered choices,
// parser-based indicators, bounded local search, and no arbitrary first candidate.
import { opendir, realpath } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Outline, ReadSource, SourceSnapshot } from './model.js'
import { createSourceParser } from './parse.js'
import { MAX_DISCOVERY_ENTRIES, ProcessingLimitError, sourceBytes, yieldProcessing } from './processing.js'

export interface RootChoice {
    readonly scope: string
    readonly root: string
}

export type RootResolution =
    | { readonly kind: 'resolved'; readonly root: string }
    | { readonly kind: 'ambiguous'; readonly candidates: readonly string[] }
    | { readonly kind: 'unresolved'; readonly message: string; readonly candidates?: readonly string[] }

export interface ResolveRootInput {
    readonly active: string
    readonly current?: Outline
    readonly choices: readonly RootChoice[]
    readonly workspaceFolder?: string
    readonly openUris?: readonly string[]
    readonly read: ReadSource
    readonly build: (root: string) => Promise<Outline>
    readonly signal?: AbortSignal
}

export const ROOT_SEARCH_LIMIT = 200
const excludedDirectories = new Set(['.git', '.hg', '.svn', 'node_modules', 'bower_components', '.yarn', '.pnpm', '.venv', 'venv', 'build', 'dist', 'out', '.next', '.cache'])
// Workshop recognizes TEX and TeX, with lowercase `root`. Restrict extensions to
// this extension's TeX sources, accepting trailing whitespace and CRLF as well.
const magicRoot = /^%\s*!\s*T[Ee]X\sroot\s*=\s*(.*\.tex)\s*$/m

function normalize(uri: string): string {
    return pathToFileURL(resolve(fileURLToPath(uri))).href
}

function normalized(uri: string): string | undefined {
    try {
        return normalize(uri)
    } catch {
        return undefined
    }
}

function inside(directory: string, file: string): boolean {
    const path = relative(directory, file)
    return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

/** Only actual graph edges count: attempted/missing include candidates do not. */
async function contains(outline: Outline, active: string, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted()
    if (normalized(outline.root) === active) return true
    for (let index = 0; index < outline.includes.length; index++) {
        if (index % 64 === 0) await yieldProcessing(signal)
        if (normalized(outline.includes[index].to) === active) return true
    }
    return false
}

function result(roots: readonly string[]): RootResolution {
    return roots.length === 1 ? { kind: 'resolved', root: roots[0] } : { kind: 'ambiguous', candidates: roots }
}

function detail(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function rethrowProcessingFailure(error: unknown, signal?: AbortSignal): void {
    signal?.throwIfAborted()
    if (error instanceof ProcessingLimitError || (error instanceof Error && error.name === 'AbortError')) throw error
}

/** Resolve against a consistent snapshot reader; host owns persistence and cancellation. */
export async function resolveRoot(input: ResolveRootInput): Promise<RootResolution> {
    const { signal } = input
    signal?.throwIfAborted()
    const active = normalized(input.active)
    if (active === undefined) return { kind: 'unresolved', message: 'Root discovery requires a local file URI.' }
    // Do not replace a known project with a standalone-capable chapter, even when
    // another branch has missing/parse diagnostics. The host refreshes this graph.
    if (input.current && await contains(input.current, active, signal)) {
        return { kind: 'resolved', root: normalize(input.current.root) }
    }

    const activePath = fileURLToPath(active)
    const workspace = input.workspaceFolder === undefined ? undefined : normalized(input.workspaceFolder)
    if (input.workspaceFolder !== undefined && workspace === undefined) {
        return { kind: 'unresolved', message: 'The active workspace folder must be a local file URI.' }
    }
    const inWorkspace = workspace !== undefined && inside(fileURLToPath(workspace), activePath)
    const directory = inWorkspace ? fileURLToPath(workspace) : dirname(activePath)
    const snapshots = new Map<string, Promise<SourceSnapshot | undefined>>()
    const read = async (uri: string): Promise<SourceSnapshot | undefined> => {
        signal?.throwIfAborted()
        let pending = snapshots.get(uri)
        if (pending === undefined) {
            pending = input.read(uri).then(source => {
                signal?.throwIfAborted()
                if (source !== undefined) sourceBytes(source)
                return source
            })
            snapshots.set(uri, pending)
        }
        const source = await pending
        signal?.throwIfAborted()
        return source
    }
    const parse = createSourceParser({})
    const failures: string[] = []
    const remembered = new Set<string>()
    for (let index = 0; index < input.choices.length; index++) {
        if (index % 64 === 0) await yieldProcessing(signal)
        const choice = input.choices[index]
        // Loose files may live below an explicitly chosen root's scope directory.
        // Scope is a persistence identity, never evidence of include membership.
        if (inWorkspace && normalized(choice.scope) !== workspace) continue
        const root = normalized(choice.root)
        if (root !== undefined) remembered.add(root)
    }
    const applicable: string[] = []
    for (const root of [...remembered].sort()) {
        await yieldProcessing(signal)
        try {
            const outline = await input.build(root)
            signal?.throwIfAborted()
            if (!outline.diagnostics.some(item => item.code === 'missing-root') && await contains(outline, active, signal)) applicable.push(root)
        } catch (error) {
            rethrowProcessingFailure(error, signal)
            failures.push(`Cannot inspect remembered root ${root}: ${detail(error)}`)
        }
    }
    if (applicable.length > 0) {
        if (failures.length > 0) return { kind: 'unresolved', message: failures.join('\n'), candidates: applicable }
        return result(applicable)
    }

    let source: SourceSnapshot | undefined
    try {
        source = await read(active)
    } catch (error) {
        rethrowProcessingFailure(error, signal)
        return { kind: 'unresolved', message: `Cannot read the active TeX document: ${detail(error)}` }
    }
    if (source === undefined) return { kind: 'unresolved', message: `The active TeX document does not exist: ${active}` }

    let root = active
    const chain = new Set([active])
    let magic = source.text.match(magicRoot)
    while (magic !== null) {
        await yieldProcessing(signal)
        const target = pathToFileURL(resolve(dirname(fileURLToPath(root)), magic[1].trim())).href
        if (chain.has(target)) {
            return { kind: 'unresolved', message: `Root magic comment cycle: ${[...chain, target].join(' → ')}` }
        }
        chain.add(target)
        root = target
        try {
            source = await read(root)
        } catch (error) {
            rethrowProcessingFailure(error, signal)
            return { kind: 'unresolved', message: `Cannot read root magic comment target ${root}: ${detail(error)}` }
        }
        if (source === undefined) return { kind: 'unresolved', message: `Root magic comment target does not exist: ${root}` }
        magic = source.text.match(magicRoot)
    }
    try {
        await yieldProcessing(signal)
        const parsed = parse(source)
        if (chain.size > 1 || parsed.documentClass !== undefined) return { kind: 'resolved', root }
    } catch (error) {
        rethrowProcessingFailure(error, signal)
        return { kind: 'unresolved', message: `Cannot parse ${root}: ${detail(error)}` }
    }

    const discovered = await discover(directory, inWorkspace, input.openUris ?? [], signal)
    if (discovered.kind === 'unresolved') return discovered
    const candidates: string[] = []
    for (const candidate of discovered.uris) {
        await yieldProcessing(signal)
        if (candidate === active) continue
        try {
            const snapshot = await read(candidate)
            if (snapshot === undefined || parse(snapshot).documentClass === undefined) continue
            const outline = await input.build(candidate)
            signal?.throwIfAborted()
            if (await contains(outline, active, signal)) candidates.push(candidate)
        } catch (error) {
            rethrowProcessingFailure(error, signal)
            failures.push(`Cannot inspect candidate ${candidate}: ${detail(error)}`)
        }
    }
    if (failures.length > 0) {
        return { kind: 'unresolved', message: failures.join('\n'), candidates }
    }
    if (candidates.length > 0) return result(candidates)
    return { kind: 'unresolved', message: `No TeX root containing the active document was found in ${directory}. Select a root explicitly or add a root magic comment.` }
}

async function discover(directory: string, recursive: boolean, openUris: readonly string[], signal?: AbortSignal): Promise<
    { kind: 'found'; uris: readonly string[] } | Extract<RootResolution, { kind: 'unresolved' }>
> {
    const uris = new Set<string>()
    let visited = 0
    const add = (uri: string): void => {
        uris.add(uri)
        if (uris.size > ROOT_SEARCH_LIMIT) throw new Error(`Root search exceeded ${ROOT_SEARCH_LIMIT} TeX candidates in ${directory}. Select a root explicitly or add a root magic comment.`)
    }
    const walk = async (path: string): Promise<void> => {
        signal?.throwIfAborted()
        const entries = await opendir(path)
        // Async iteration closes the directory on completion, cancellation, and
        // errors, including failures propagated from recursive walks.
        for await (const entry of entries) {
            signal?.throwIfAborted()
            if (++visited > MAX_DISCOVERY_ENTRIES) {
                throw new ProcessingLimitError('discovery-entries', `Root search exceeded ${MAX_DISCOVERY_ENTRIES} filesystem entries in ${directory}. Select a root explicitly or add a root magic comment.`)
            }
            if (visited % 64 === 0) await yieldProcessing(signal)
            if (entry.isDirectory()) {
                if (recursive && !excludedDirectories.has(entry.name)) await walk(join(path, entry.name))
            } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.tex') {
                add(pathToFileURL(join(path, entry.name)).href)
            }
            // Never traverse directory symlinks or discover symlinked files.
        }
    }
    try {
        // Open, not-yet-saved files count, but cannot smuggle another folder or an
        // excluded directory into automatic discovery. Resolve the nearest existing
        // parent to ensure a symlink does not escape the physical search boundary.
        signal?.throwIfAborted()
        const boundary = await realpath(directory)
        signal?.throwIfAborted()
        for (let index = 0; index < openUris.length; index++) {
            if (index % 64 === 0) await yieldProcessing(signal)
            const raw = openUris[index]
            const uri = normalized(raw)
            if (uri === undefined) continue
            const path = fileURLToPath(uri)
            if (!inside(directory, path) || extname(path).toLowerCase() !== '.tex') continue
            if (!recursive && dirname(path) !== directory) continue
            if (relative(directory, path).split(sep).slice(0, -1).some(part => excludedDirectories.has(part))) continue
            let parent = path
            let physical: string
            while (true) {
                try {
                    signal?.throwIfAborted()
                    physical = await realpath(parent)
                    signal?.throwIfAborted()
                    break
                } catch (error) {
                    rethrowProcessingFailure(error, signal)
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
                    await yieldProcessing(signal)
                    const next = dirname(parent)
                    if (next === parent) throw error
                    parent = next
                }
            }
            if (inside(boundary, physical)) add(uri)
        }
        await walk(directory)
        signal?.throwIfAborted()
        return { kind: 'found', uris: [...uris].sort() }
    } catch (error) {
        rethrowProcessingFailure(error, signal)
        return { kind: 'unresolved', message: `Automatic root search could not complete: ${detail(error)}` }
    }
}
