import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { fileUri, sourceReader } from '../src/files.js'
import type { Outline, ReadSource, SourceSnapshot } from '../src/model.js'
import { buildOutline } from '../src/project.js'
import { resolveRoot, ROOT_SEARCH_LIMIT, type ResolveRootInput, type RootResolution } from '../src/roots.js'
import { MAX_DISCOVERY_ENTRIES, MAX_SOURCE_BYTES, ProcessingLimitError } from '../src/processing.js'

async function fixture(t: TestContext, files: Record<string, string>) {
    const directory = await mkdtemp(join(tmpdir(), 'latex-toc-roots-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    for (const [name, content] of Object.entries(files)) {
        const path = join(directory, name)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, content)
    }
    const uri = (name: string) => fileUri(join(directory, name))
    const resolve = (active: string, options: Partial<Omit<ResolveRootInput, 'active'>> = {}) => {
        const read = options.read ?? sourceReader()
        return resolveRoot({ active: uri(active), workspaceFolder: uri('.'), choices: [], ...options, read,
            build: options.build ?? (root => buildOutline(root, read)) })
    }
    return { directory, uri, resolve }
}

function unresolved(result: RootResolution, message: RegExp): void {
    assert.equal(result.kind, 'unresolved')
    if (result.kind === 'unresolved') assert.match(result.message, message)
}

const document = '\\documentclass{report}\n'

test('standalone document uses the production parser and normalized file URI', async t => {
    const f = await fixture(t, { "author's main.tex": document + '\\chapter{Start}' })
    const active = f.uri("author's main.tex").replaceAll("'", '%27')
    const read = sourceReader()
    assert.deepEqual(await resolveRoot({ active, choices: [], read, build: root => buildOutline(root, read) }),
        { kind: 'resolved', root: f.uri("author's main.tex") })
})

test('commented, verbatim, and macro-definition document classes are not self roots', async t => {
    const f = await fixture(t, {
        'chapter.tex': '% \\documentclass{book}\n\\begin{verbatim}\n\\documentclass{book}\n\\end{verbatim}\n\\newcommand{\\hidden}{\\documentclass{article}}\n',
    })
    unresolved(await f.resolve('chapter.tex'), /No TeX root/)
})

test('magic chains use snapshots, Workshop case conventions, and relative then absolute paths', async t => {
    const f = await fixture(t, { 'chapter.tex': 'saved prose', 'hop.tex': 'old prose', 'elsewhere/root.tex': document })
    const buffers: SourceSnapshot[] = [
        { uri: f.uri('chapter.tex'), text: '% !TeX root = ./hop.tex\r\n', version: 2 },
        { uri: f.uri('hop.tex'), text: `% !TEX root = ${join(f.directory, 'elsewhere/root.tex')}   \n`, version: 3 },
    ]
    assert.deepEqual(await f.resolve('chapter.tex', { read: sourceReader(buffers) }),
        { kind: 'resolved', root: f.uri('elsewhere/root.tex') })
})

test('magic comments may explicitly leave workspace search bounds', async t => {
    const f = await fixture(t, {
        'workspace/chapter.tex': '% !TEX root = ../external/root.tex\n',
        'external/root.tex': document,
    })
    assert.deepEqual(await f.resolve('workspace/chapter.tex', { workspaceFolder: f.uri('workspace') }),
        { kind: 'resolved', root: f.uri('external/root.tex') })
})

test('magic cycles and missing targets stay visible instead of falling back to self', async t => {
    const f = await fixture(t, {
        'cycle.tex': '% !TEX root = hop.tex\n' + document,
        'hop.tex': '% !TEX root = cycle.tex\n',
        'missing.tex': '% !TEX root = absent.tex\n' + document,
        'self.tex': '% !TEX root = self.tex\n' + document,
    })
    unresolved(await f.resolve('cycle.tex'), /magic comment cycle/)
    unresolved(await f.resolve('missing.tex'), /target does not exist/)
    unresolved(await f.resolve('self.tex'), /magic comment cycle/)
})

test('malformed magic targets return an understandable error', async t => {
    const f = await fixture(t, {
        'chapter.tex': '% !TEX root = broken.tex\n',
        'broken.tex': document + '\\section{Unclosed',
    })
    unresolved(await f.resolve('chapter.tex'), /Cannot parse/)
})

test('current graph wins over a standalone-capable child, its magic comment, and remembered roots', async t => {
    const f = await fixture(t, {
        'main.tex': document + '\\input{child}',
        'child.tex': '% !TEX root = other.tex\n' + document,
        'other.tex': document + '\\input{child}',
    })
    const current = await buildOutline(f.uri('main.tex'), sourceReader())
    const rejectRead: ReadSource = async () => { throw new Error('Current graph must resolve without reading') }
    assert.deepEqual(await f.resolve('child.tex', { current, read: rejectRead,
        build: async () => { throw new Error('Current graph must resolve without building') },
        choices: [{ scope: f.uri('.'), root: f.uri('other.tex') }],
    }), { kind: 'resolved', root: f.uri('main.tex') })
})

test('current graph retains known members despite missing or malformed branches', async t => {
    const f = await fixture(t, {
        'main.tex': document + '\\input{missing}\\input{broken}\\input{child}',
        'broken.tex': '\\section{Unclosed',
        'child.tex': document,
    })
    const current = await buildOutline(f.uri('main.tex'), sourceReader())
    assert.ok(current.diagnostics.some(item => item.code === 'missing-include'))
    assert.ok(current.diagnostics.some(item => item.code === 'parse-error'))
    assert.deepEqual(await f.resolve('child.tex', { current }), { kind: 'resolved', root: f.uri('main.tex') })
})

test('attempted missing dependency URIs are not proof of current membership', async t => {
    const f = await fixture(t, { 'main.tex': document, 'other.tex': document })
    const built = await buildOutline(f.uri('main.tex'), sourceReader())
    const current: Outline = { ...built, dependencies: [...built.dependencies, f.uri('other.tex')] }
    assert.deepEqual(await f.resolve('other.tex', { current }), { kind: 'resolved', root: f.uri('other.tex') })
})

test('candidate graphs support nested, repeated, and cyclic input/include membership', async t => {
    const f = await fixture(t, {
        'main.tex': document + '\\input{chapters/first}\\input{chapters/first}',
        'chapters/first.tex': '\\include{nested/second}',
        'chapters/nested/second.tex': '\\section{Nested}\\input{../../main}',
    })
    assert.deepEqual(await f.resolve('chapters/nested/second.tex'), { kind: 'resolved', root: f.uri('main.tex') })
})

test('multiple containing roots return sorted ambiguity rather than a nearby first root', async t => {
    const f = await fixture(t, {
        'z.tex': document + '\\input{shared}',
        'a.tex': document + '\\input{shared}',
        'nearby.tex': document,
        'shared.tex': '\\section{Shared}',
    })
    assert.deepEqual(await f.resolve('shared.tex'), { kind: 'ambiguous', candidates: [f.uri('a.tex'), f.uri('z.tex')] })
})

test('a nearby standalone root that does not include the active file is never selected', async t => {
    const f = await fixture(t, { 'main.tex': document, 'unrelated.tex': '\\section{Unrelated}' })
    unresolved(await f.resolve('unrelated.tex'), /No TeX root containing/)
})

test('remembered choices are rebuilt, beat self and magic, and cannot capture unrelated projects', async t => {
    const f = await fixture(t, {
        'a/main.tex': document + '\\input{child}',
        'a/child.tex': '% !TEX root = missing.tex\n' + document,
        'b/main.tex': document + '\\input{child}',
        'b/child.tex': '\\section{Different project}',
    })
    const choices = [{ scope: f.uri('.'), root: f.uri('a/main.tex') }]
    assert.deepEqual(await f.resolve('a/child.tex', { choices }), { kind: 'resolved', root: f.uri('a/main.tex') })
    assert.deepEqual(await f.resolve('b/child.tex', { choices }), { kind: 'resolved', root: f.uri('b/main.tex') })
    const read = sourceReader([{ uri: f.uri('a/main.tex'), text: document, version: 2 }])
    unresolved(await f.resolve('a/child.tex', { choices, read }), /target does not exist/)
})

test('multiple remembered containing roots are ambiguous and duplicate choices are deduplicated', async t => {
    const f = await fixture(t, {
        'a.tex': document + '\\input{shared}',
        'b.tex': document + '\\input{shared}',
        'shared.tex': document,
    })
    const choices = ['b.tex', 'a.tex', 'b.tex'].map(name => ({ scope: f.uri('.'), root: f.uri(name) }))
    assert.deepEqual(await f.resolve('shared.tex', { choices }), { kind: 'ambiguous', candidates: [f.uri('a.tex'), f.uri('b.tex')] })
})

test('remembered choices respect workspace scope but may point outside that folder', async t => {
    const f = await fixture(t, {
        'workspace/child.tex': document,
        'external/root.tex': document + '\\input{../workspace/child}',
    })
    const root = f.uri('external/root.tex')
    assert.deepEqual(await f.resolve('workspace/child.tex', { workspaceFolder: f.uri('workspace'),
        choices: [{ scope: f.uri('external'), root }],
    }), { kind: 'resolved', root: f.uri('workspace/child.tex') })
    assert.deepEqual(await f.resolve('workspace/child.tex', { workspaceFolder: f.uri('workspace'),
        choices: [{ scope: f.uri('workspace'), root }],
    }), { kind: 'resolved', root })
})

test('loose nested chapters recover remembered roots across directory scopes after reload', async t => {
    const f = await fixture(t, {
        'project/main.tex': document + '\\input{chapters/nested/a}',
        'project/chapters/nested/a.tex': document,
        'other/main.tex': document,
    })
    const choices = [
        { scope: f.uri('other'), root: f.uri('other/main.tex') },
        { scope: f.uri('project'), root: f.uri('project/main.tex') },
    ]
    assert.deepEqual(await f.resolve('project/chapters/nested/a.tex', { workspaceFolder: undefined, choices }),
        { kind: 'resolved', root: f.uri('project/main.tex') })
})

test('automatic search stays inside the active workspace folder, including open file candidates', async t => {
    const f = await fixture(t, {
        'workspace/child.tex': '\\section{Child}',
        'other/root.tex': document + '\\input{../workspace/child}',
        'root.tex': document + '\\input{workspace/child}',
    })
    unresolved(await f.resolve('workspace/child.tex', { workspaceFolder: f.uri('workspace'), openUris: [f.uri('other/root.tex'), f.uri('root.tex')] }), /No TeX root/)
})

test('loose-file search is nonrecursive and never crawls ancestors', async t => {
    const f = await fixture(t, {
        'parent.tex': document + '\\input{local/child}',
        'local/child.tex': '\\section{Child}',
        'local/nested/root.tex': document + '\\input{../child}',
    })
    unresolved(await f.resolve('local/child.tex', { workspaceFolder: undefined,
        openUris: [f.uri('parent.tex'), f.uri('local/nested/root.tex')],
    }), /No TeX root/)
    const read = sourceReader([{ uri: f.uri('local/root.tex'), text: document + '\\input{child}', version: 1 }])
    assert.deepEqual(await f.resolve('local/child.tex', { workspaceFolder: undefined, read, openUris: [f.uri('local/root.tex')] }),
        { kind: 'resolved', root: f.uri('local/root.tex') })
})

test('workspace recursion includes unsaved open roots and excludes dependency and build metadata', async t => {
    const files: Record<string, string> = { 'child.tex': '\\section{Child}' }
    for (const directory of ['.git', 'node_modules', 'build', 'dist']) files[`${directory}/root.tex`] = document + '\\input{../child}'
    const f = await fixture(t, files)
    const excluded = ['.git', 'node_modules', 'build', 'dist'].map(name => f.uri(`${name}/root.tex`))
    unresolved(await f.resolve('child.tex', { openUris: excluded }), /No TeX root/)
    const uri = f.uri('new/nested/root.tex')
    const read = sourceReader([{ uri, text: document + `\\input{${join(f.directory, 'child.tex')}}`, version: 2 }])
    assert.deepEqual(await f.resolve('child.tex', { read, openUris: [...excluded, uri] }), { kind: 'resolved', root: uri })
})

test('directory symlinks cannot lead automatic search or open candidates outside workspace', async t => {
    const f = await fixture(t, {
        'workspace/child.tex': '\\section{Child}',
        'external/root.tex': document + `\\input{../workspace/child}`,
    })
    await symlink(join(f.directory, 'external'), join(f.directory, 'workspace/link'), 'dir')
    unresolved(await f.resolve('workspace/child.tex', { workspaceFolder: f.uri('workspace'), openUris: [f.uri('workspace/link/root.tex')] }), /No TeX root/)
})

test('candidate limit is visible and never selects the first match from partial search', async t => {
    const files: Record<string, string> = {
        '000-root.tex': document + '\\input{child}',
        'child.tex': '\\section{Child}',
    }
    for (let index = 0; index < ROOT_SEARCH_LIMIT - 1; index++) files[`filler-${index}.tex`] = 'prose'
    const f = await fixture(t, files)
    unresolved(await f.resolve('child.tex'), new RegExp(`exceeded ${ROOT_SEARCH_LIMIT} TeX candidates`))
})

test('ordinary missing, malformed, and unreadable sources return errors instead of throwing', async t => {
    const f = await fixture(t, { 'child.tex': '\\section{Child}', 'broken.tex': document + '\\section{Unclosed' })
    unresolved(await f.resolve('absent.tex'), /active TeX document does not exist/)
    unresolved(await f.resolve('broken.tex'), /Cannot parse/)
    unresolved(await f.resolve('child.tex'), /Cannot inspect candidate/)
    const read: ReadSource = async () => { throw new Error('Permission denied') }
    unresolved(await f.resolve('child.tex', { read }), /Cannot read.*Permission denied/)
})

test('filesystem entry budget counts non-TeX files, directories, and skipped symlinks without partial roots', async t => {
    const f = await fixture(t, {
        'child.tex': '\\section{Child}',
        'main.tex': document + '\\input{child}',
        'metadata/note.txt': 'metadata',
    })
    await mkdir(join(f.directory, '.git'))
    await symlink(join(f.directory, 'main.tex'), join(f.directory, 'ignored-link.tex'))
    // Six entries above, including the excluded directory and the symlink.
    const fillerCount = MAX_DISCOVERY_ENTRIES - 6
    for (let start = 0; start < fillerCount; start += 128) {
        await Promise.all(Array.from({ length: Math.min(128, fillerCount - start) }, (_, offset) =>
            writeFile(join(f.directory, `filler-${start + offset}.txt`), '')))
    }
    assert.deepEqual(await f.resolve('child.tex'), { kind: 'resolved', root: f.uri('main.tex') })
    await writeFile(join(f.directory, 'one-too-many.txt'), '')
    await assert.rejects(f.resolve('child.tex'), error =>
        error instanceof ProcessingLimitError && error.limit === 'discovery-entries')

    // Explicit choices and magic comments bypass automatic discovery altogether.
    assert.deepEqual(await f.resolve('child.tex', {
        choices: [{ scope: f.uri('.'), root: f.uri('main.tex') }],
    }), { kind: 'resolved', root: f.uri('main.tex') })
    const read = sourceReader([{ uri: f.uri('child.tex'), text: '% !TEX root = main.tex\n', version: 2 }])
    assert.deepEqual(await f.resolve('child.tex', { read }), { kind: 'resolved', root: f.uri('main.tex') })
})

test('oversized injected snapshots escape active, magic, and candidate read fallbacks', async t => {
    const f = await fixture(t, {
        'self.tex': document,
        'magic.tex': '% !TEX root = main.tex\n' + document,
        'child.tex': '\\section{Child}',
        'main.tex': document + '\\input{child}',
    })
    const disk = sourceReader()
    const oversized = document + 'é'.repeat(MAX_SOURCE_BYTES / 2)
    for (const [active, target] of [['self.tex', 'self.tex'], ['magic.tex', 'main.tex'], ['child.tex', 'main.tex']]) {
        const read: ReadSource = async uri => uri === f.uri(target)
            ? { uri, text: oversized, version: 1 }
            : disk(uri)
        await assert.rejects(f.resolve(active, { read }), error =>
            error instanceof ProcessingLimitError && error.limit === 'source-bytes')
    }
})

test('aborted active and magic reads cannot become successful self roots', async t => {
    const f = await fixture(t, {
        'self.tex': document,
        'magic.tex': '% !TEX root = self.tex\n' + document,
    })
    for (const active of ['self.tex', 'magic.tex']) {
        const controller = new AbortController()
        const disk = sourceReader()
        const read: ReadSource = async uri => {
            const snapshot = await disk(uri)
            if (uri === f.uri('self.tex')) controller.abort()
            return snapshot
        }
        await assert.rejects(f.resolve(active, { read, signal: controller.signal }),
            error => error === controller.signal.reason)
    }
})

test('aborted remembered and discovered builds cannot return roots or self fallbacks', async t => {
    const f = await fixture(t, {
        'child.tex': '\\section{Child}',
        'self.tex': document,
        'main.tex': document + '\\input{child}\\input{self}',
    })
    for (const remembered of [true, false]) {
        const controller = new AbortController()
        const read = sourceReader()
        const build = async (root: string): Promise<Outline> => {
            const outline = await buildOutline(root, read)
            controller.abort()
            return outline
        }
        await assert.rejects(f.resolve(remembered ? 'self.tex' : 'child.tex', {
            signal: controller.signal, build,
            choices: remembered ? [{ scope: f.uri('.'), root: f.uri('main.tex') }] : [],
        }), error => error === controller.signal.reason)
    }
})

test('resource failures in remembered and discovered builds are never downgraded to root diagnostics', async t => {
    const f = await fixture(t, {
        'child.tex': '\\section{Child}',
        'self.tex': document,
        'main.tex': document + '\\input{child}\\input{self}\\input{build/huge}',
        'build/huge.tex': 'é'.repeat(MAX_SOURCE_BYTES / 2 + 1),
    })
    for (const remembered of [true, false]) {
        await assert.rejects(f.resolve(remembered ? 'self.tex' : 'child.tex', {
            choices: remembered ? [{ scope: f.uri('.'), root: f.uri('main.tex') }] : [],
        }), error => error instanceof ProcessingLimitError && error.limit === 'source-bytes')
    }
})

test('automatic search yields while filtering open URIs and propagates cancellation', async t => {
    const f = await fixture(t, { 'child.tex': '\\section{Child}' })
    const controller = new AbortController()
    const openUris: string[] = []
    Object.defineProperty(openUris, 0, {
        get() {
            // Abort on the next event-loop turn, not from a reader or builder.
            setImmediate(() => controller.abort())
            return f.uri('not-a-candidate.txt')
        },
    })
    for (let index = 1; index < 256; index++) openUris.push(f.uri(`ignored-${index}.txt`))
    await assert.rejects(f.resolve('child.tex', { openUris, signal: controller.signal }),
        error => error === controller.signal.reason)
})

test('an already aborted resolution cannot reuse a successful current graph', async t => {
    const f = await fixture(t, { 'main.tex': document })
    const current = await buildOutline(f.uri('main.tex'), sourceReader())
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(f.resolve('main.tex', { current, signal: controller.signal }),
        error => error === controller.signal.reason)
})
