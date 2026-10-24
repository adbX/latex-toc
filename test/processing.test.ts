import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { promisify } from 'node:util'
import { fileUri, sourceReader } from '../src/files.js'
import type { ReadSource, SourceSnapshot } from '../src/model.js'
import type { ParsedFile } from '../src/parse.js'
import { assembleOutline, buildOutline } from '../src/project.js'
import { MAX_FILE_OCCURRENCES, MAX_PROJECT_BYTES, MAX_SOURCE_BYTES, MAX_STRUCTURAL_EVENTS, ProcessingLimitError } from '../src/processing.js'
import { OutlineSession } from '../src/session.js'

const root = 'file:///fixture/main.tex'
const uri = (name: string) => new URL(name, root).href
const reader = (files: Record<string, string>): ReadSource => async target => {
    const text = files[target]
    return text === undefined ? undefined : { uri: target, text, version: 1 }
}
const limit = (kind: ProcessingLimitError['limit']) => (error: unknown) => error instanceof ProcessingLimitError && error.limit === kind
const point = { offset: 0, line: 0, character: 0 }
const range = { start: point, end: point }
const include = (path: string, ordinal: number): ParsedFile['events'][number] => ({ type: 'include', command: 'input', path, ordinal, range })
const parsed = (events: readonly ParsedFile['events'][number][] = []) => (source: SourceSnapshot): ParsedFile => ({ source, events })

async function directory(t: TestContext): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), 'latex-toc-processing-'))
    t.after(() => rm(path, { recursive: true, force: true }))
    return path
}

test('disk, dirty buffers and injected sources share an inclusive UTF-8 byte limit', async t => {
    const path = join(await directory(t), 'main.tex')
    const target = fileUri(path)
    const boundary = 'é'.repeat(MAX_SOURCE_BYTES / 2)
    await writeFile(path, boundary)
    assert.equal((await sourceReader()(target))?.text, boundary)
    assert.equal((await sourceReader([{ uri: target, text: boundary, version: 2 }])(target))?.version, 2)
    await writeFile(path, boundary + 'x')
    await assert.rejects(sourceReader()(target), limit('source-bytes'))
    await assert.rejects(sourceReader([{ uri: target, text: boundary + 'x', version: 3 }])(target), limit('source-bytes'))
    assert.equal((await sourceReader([{ uri: target, text: 'unsaved', version: 4 }])(target))?.text, 'unsaved')
    let parsedOversized = false
    await assert.rejects(assembleOutline(root, reader({ [root]: boundary + 'x' }), {}, source => {
        parsedOversized = true
        return parsed()(source)
    }), limit('source-bytes'))
    assert.equal(parsedOversized, false)
    assert.equal(await sourceReader()(fileUri(join(path, '..', 'missing.tex'))), undefined)
})

test('regular symlinks remain readable while FIFOs, device targets and directories reject promptly', { skip: process.platform === 'win32' }, async t => {
    const path = await directory(t)
    const regular = join(path, 'regular.tex')
    const alias = join(path, 'alias.tex')
    const fifo = join(path, 'pipe.tex')
    const fifoAlias = join(path, 'pipe-alias.tex')
    await writeFile(regular, '\\section{Linked}')
    await symlink(regular, alias)
    assert.equal((await sourceReader()(fileUri(alias)))?.text, '\\section{Linked}')
    await promisify(execFile)('mkfifo', [fifo])
    await symlink(fifo, fifoAlias)
    // A supervised child keeps a regression to blocking FIFO open from hanging the test runner.
    const script = `
        import assert from 'node:assert/strict'
        import { sourceReader } from ${JSON.stringify(new URL('../src/files.js', import.meta.url).href)}
        for (const uri of process.argv.slice(1)) await assert.rejects(sourceReader()(uri))
    `
    await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script,
        ...[fifo, fifoAlias, path, '/dev/null'].map(fileUri)], { timeout: 5000, killSignal: 'SIGKILL' })
    // Buffer precedence does not inspect or open the special disk target.
    assert.equal((await sourceReader([{ uri: fileUri(fifo), text: 'dirty', version: 1 }])(fileUri(fifo)))?.text, 'dirty')
})

test('project text counts unique resolved sources once and accepts exactly 32 MiB', async () => {
    const text = 'x'.repeat(MAX_SOURCE_BYTES)
    const sources: Record<string, string> = { [root]: text }
    const uniqueChildren = MAX_PROJECT_BYTES / MAX_SOURCE_BYTES - 1
    const events = Array.from({ length: uniqueChildren }, (_, index) => include(`child${index}`, index))
    for (let index = 0; index < uniqueChildren; index++) sources[uri(`child${index}.tex`)] = text
    // Re-expanding a large source many times does not consume unique text again.
    for (let index = 0; index < 12; index++) events.push(include('child0', events.length))
    const reads = new Map<string, number>()
    const read: ReadSource = async target => {
        reads.set(target, (reads.get(target) ?? 0) + 1)
        return reader(sources)(target)
    }
    const parse = (source: SourceSnapshot) => parsed(source.uri === root ? events : [])(source)
    const outline = await assembleOutline(root, read, {}, parse)
    assert.equal(outline.files.length, uniqueChildren + 1)
    assert.equal(outline.includes.length, events.length)
    assert.ok([...reads.values()].every(count => count === 1))
    sources[uri('extra.tex')] = 'x'
    events.push(include('extra', events.length))
    await assert.rejects(assembleOutline(root, reader(sources), {}, parse), limit('project-bytes'))
})

test('occurrence limit includes the root, excludes cycle-skipped edges, and accepts its boundary', async () => {
    const leaf = uri('leaf.tex')
    const events = Array.from({ length: MAX_FILE_OCCURRENCES - 1 }, (_, index) => include('leaf', index))
    events.push(include('main', events.length))
    const read = reader({ [root]: '', [leaf]: '' })
    const parse = (source: SourceSnapshot) => parsed(source.uri === root ? events : [])(source)
    const outline = await assembleOutline(root, read, {}, parse)
    assert.equal(outline.includes.length, MAX_FILE_OCCURRENCES)
    assert.equal(outline.diagnostics.filter(item => item.code === 'include-cycle').length, 1)
    events.push(include('leaf', events.length))
    await assert.rejects(assembleOutline(root, read, {}, parse), limit('file-occurrences'))
})

test('a small exponentially expanding real include graph fails instead of returning a partial outline', async () => {
    const sources: Record<string, string> = {}
    for (let index = 0; index < 13; index++) {
        sources[index === 0 ? root : uri(`level${index}.tex`)] = `\\input{level${index + 1}}\\input{level${index + 1}}`
    }
    sources[uri('level13.tex')] = '\\section{Leaf}'
    await assert.rejects(buildOutline(root, reader(sources)), limit('file-occurrences'))
})

test('structural event budget counts non-node events across repeated expansion', async () => {
    const includes = 10
    const leafEvents = Array.from({ length: (MAX_STRUCTURAL_EVENTS - includes) / includes }, (_, ordinal): ParsedFile['events'][number] =>
        ordinal % 2 === 0 ? { type: 'appendix', ordinal, range } : { type: 'counter', name: 'section', value: 0, ordinal, range })
    const rootEvents = Array.from({ length: includes }, (_, ordinal) => include('leaf', ordinal))
    const read = reader({ [root]: '', [uri('leaf.tex')]: '' })
    const parse = (source: SourceSnapshot) => parsed(source.uri === root ? rootEvents : leafEvents)(source)
    const outline = await assembleOutline(root, read, {}, parse)
    assert.equal(outline.includes.length, includes)
    assert.equal(outline.flat.length, 0)
    leafEvents.push({ type: 'appendix', ordinal: leafEvents.length, range })
    await assert.rejects(assembleOutline(root, read, {}, parse), limit('structural-events'))
})

test('cached include expansion yields for cancellation and aborted sessions preserve committed identities', async () => {
    const session = new OutlineSession()
    const original = '\\section{Kept}' + '\\input{leaf}'.repeat(600)
    const sources = { [root]: original, [uri('leaf.tex')]: '\\subsection{Leaf}' }
    const first = await session.build(root, reader(sources))
    const originalIds = first.flat.map(node => node.id)
    const serialized = JSON.stringify(first)
    sources[root] = '\\section{Replacement}' + '\\input{leaf}'.repeat(600)
    const controller = new AbortController()
    const reason = new Error('Superseded build')
    const pending = session.build(root, reader(sources), controller.signal)
    const cancellation = setImmediate(() => controller.abort(reason))
    try {
        await assert.rejects(pending, error => error === reason)
    } finally {
        clearImmediate(cancellation)
    }
    sources[root] = original
    const restored = await session.build(root, reader(sources))
    assert.deepEqual(restored.flat.map(node => node.id), originalIds)
    assert.equal(JSON.stringify(first), serialized)
})

test('cancellation after a pending read rejects before parsing or publishing', async () => {
    const controller = new AbortController()
    const reason = new Error('Superseded read')
    const { promise, resolve: release } = Promise.withResolvers<SourceSnapshot>()
    let parses = 0
    const pending = assembleOutline(root, () => promise, {}, source => {
        parses++
        return parsed()(source)
    }, controller.signal)
    controller.abort(reason)
    release({ uri: root, text: '', version: 1 })
    await assert.rejects(pending, error => error === reason)
    assert.equal(parses, 0)
    await assert.rejects(sourceReader([], controller.signal)(root), error => error === reason)
    await assert.rejects(sourceReader([{ uri: root, text: '', version: 1 }], controller.signal)(root), error => error === reason)
})

test('resource and abort failures from parsers never become parse diagnostics', async () => {
    for (const error of [new ProcessingLimitError('structural-events', 'limit'), new DOMException('cancelled', 'AbortError')]) {
        await assert.rejects(assembleOutline(root, reader({ [root]: '' }), {}, () => { throw error }), caught => caught === error)
    }
})
