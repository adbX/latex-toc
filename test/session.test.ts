import assert from 'node:assert/strict'
import test from 'node:test'
import type { Outline, OutlineNode, ReadSource } from '../src/model.js'
import { findContaining } from '../src/project.js'
import { OutlineSession } from '../src/session.js'

const root = 'file:///fixture/main.tex'

function reader(files: Record<string, string>, version = 1): ReadSource {
    const snapshots = new Map(Object.entries(files).map(([name, text]) => {
        const uri = new URL(name, root).href
        return [uri, { uri, text, version }]
    }))
    return async uri => snapshots.get(uri)
}

function named(outline: Outline, title: string): OutlineNode {
    const nodes = outline.flat.filter(node => node.title === title)
    assert.equal(nodes.length, 1, `Expected one node named ${title}`)
    return nodes[0]
}

function assertGraph(outline: Outline): void {
    const ids = new Map(outline.flat.map(node => [node.id, node]))
    assert.equal(ids.size, outline.flat.length)
    const visit = (node: OutlineNode, parentId?: string) => {
        assert.equal(node.parentId, parentId)
        assert.equal(ids.get(node.id), node)
        for (const child of node.children) visit(child, node.id)
    }
    for (const node of outline.nodes) visit(node)
    for (const span of outline.spans) {
        if (span.headingId !== undefined) assert.equal(ids.get(span.headingId)?.kind, 'heading')
    }
}

test('inserting unrelated prose and headings retains unique source identities and rebuilds numbering', async () => {
    const session = new OutlineSession()
    const original = '\\documentclass{report}\n\\chapter{Kept}\n\\section{Detail}\nbody\n'
    const first = await session.build(root, reader({ 'main.tex': original }))
    const published = JSON.stringify(first)
    const text = '% new comment\nnew prose\n\\chapter{Inserted}\n' + original
    const second = await session.build(root, reader({ 'main.tex': text }, 2))
    assert.equal(named(second, 'Kept').id, named(first, 'Kept').id)
    assert.equal(named(second, 'Detail').id, named(first, 'Detail').id)
    assert.equal(named(second, 'Detail').parentId, named(second, 'Kept').id)
    assert.equal(named(second, 'Kept').number, '2')
    assert.equal(named(second, 'Detail').number, '2.1')
    assert.equal(named(second, 'Kept').range.start.line, 4)
    assert.equal(JSON.stringify(first), published)
    assertGraph(second)
})

test('unrelated prose edits preserve duplicate identities when the complete command sequence is unchanged', async () => {
    const session = new OutlineSession()
    const original = '\\section{Twin}\n\\section{Twin}\n'
    const first = await session.build(root, reader({ 'main.tex': original }))
    const second = await session.build(root, reader({ 'main.tex': '% unrelated comment\n' + original }, 2))
    assert.deepEqual(second.flat.map(node => node.id), first.flat.map(node => node.id))
    assert.notEqual(second.flat[0].id, second.flat[1].id)
    assert.equal(second.flat[1].range.start.line, 2)
})

test('duplicate replacement follows surviving source evidence rather than reusing the old position', async () => {
    const session = new OutlineSession()
    const first = await session.build(root, reader({
        'main.tex': '\\section{Twin}\nalpha\n\\section{Twin}\nbeta\n\\section{Tail}',
    }))
    const second = await session.build(root, reader({
        'main.tex': '\\section{Twin}\nbeta\n\\section{Twin}\ngamma\n\\section{Tail}',
    }, 2))
    assert.equal(second.flat[0].id, first.flat[1].id)
    assert.ok(!second.flat.some(node => node.id === first.flat[0].id))
    assert.ok(!first.flat.some(node => node.id === second.flat[1].id))
    assert.equal(named(second, 'Tail').id, named(first, 'Tail').id)
    assertGraph(second)
})

test('duplicate deletion is ambiguous, while exact source evidence distinguishes equal display titles', async () => {
    const session = new OutlineSession()
    const first = await session.build(root, reader({
        'main.tex': '\\section{Twin}\n\\section{Twin}\n\\section[Same]{Original source}\n\\section{Tail}',
    }))
    const second = await session.build(root, reader({
        'main.tex': '\\section{Twin}\n\\section[Same]{Replacement source}\n\\section{Tail}',
    }, 2))
    assert.ok(!first.flat.some(node => node.id === named(second, 'Twin').id))
    assert.notEqual(named(second, 'Same').id, named(first, 'Same').id)
    assert.equal(named(second, 'Tail').id, named(first, 'Tail').id)

    const third = await session.build(root, reader({
        'main.tex': '\\section[Same]{One source}\n\\section[Same]{Another source}',
    }, 3))
    const fourth = await session.build(root, reader({
        'main.tex': '\\section{Inserted}\n\\section[Same]{One source}\n\\section[Same]{Another source}',
    }, 4))
    assert.deepEqual(fourth.flat.slice(1).map(node => node.id), third.flat.map(node => node.id))
    assert.notEqual(third.flat[0].id, third.flat[1].id)
})

test('duplicate commands under distinct structural anchors survive insertion above their parents', async () => {
    const session = new OutlineSession()
    const original = '\\chapter{A}\\section{Repeated}\\chapter{B}\\section{Repeated}'
    const first = await session.build(root, reader({ 'main.tex': original }))
    const second = await session.build(root, reader({ 'main.tex': '\\chapter{New}\\section{Repeated}' + original }, 2))
    assert.deepEqual(second.flat.slice(2).map(node => node.id), first.flat.map(node => node.id))
    assertGraph(second)
})

test('repeated and nested includes reconcile their source occurrences rather than their ordinal positions', async () => {
    const session = new OutlineSession()
    const main = '\\chapter{A}\\input{shared}\\chapter{B}\\input{shared}'
    const shared = '\\section{First}\\input{leaf}\\section{Second}\\input{leaf}'
    const first = await session.build(root, reader({
        'main.tex': main,
        'shared.tex': shared,
        'leaf.tex': '\\subsection{Leaf}\nleaf body\n',
    }))
    const second = await session.build(root, reader({
        'main.tex': '\\chapter{New}\\input{shared}' + main,
        'shared.tex': '\\section{Inserted}\\input{leaf}' + shared,
        'leaf.tex': '\\subsection{Leaf}\nleaf body\n',
    }, 2))
    const oldIds = new Set(first.flat.map(node => node.id))
    assert.equal(second.flat.filter(node => oldIds.has(node.id)).length, first.flat.length)
    const leaves = second.flat.filter(node => node.title === 'Leaf')
    assert.equal(leaves.length, 9)
    assert.equal(new Set(leaves.map(node => node.occurrence)).size, 9)
    for (const previous of first.flat) {
        const current = second.flat.find(node => node.id === previous.id)!
        assert.equal(current.occurrence, previous.occurrence)
        assert.equal(current.parentId, previous.parentId)
    }
    assert.equal(findContaining(second, 'file:///fixture/leaf.tex', 2).kind, 'ambiguous')
    assert.deepEqual(findContaining(second, leaves[4].uri, 2, leaves[4].occurrence), { kind: 'match', node: leaves[4] })
    assertGraph(second)
})

test('source prose can distinguish repeated includes, but indistinguishable inserted occurrences get new identities', async () => {
    const session = new OutlineSession()
    const includes = '\\input{same}\nfirst occurrence body\n\\input{same}\nsecond occurrence body\n\\section{End}'
    const first = await session.build(root, reader({ 'main.tex': includes, 'same.tex': '\\section{Same}' }))
    const second = await session.build(root, reader({
        'main.tex': '\\input{same}\nnew occurrence body\n' + includes,
        'same.tex': '\\section{Same}',
    }, 2))
    assert.deepEqual(second.flat.slice(1).map(node => node.id), first.flat.map(node => node.id))

    const ambiguous = new OutlineSession()
    const before = await ambiguous.build(root, reader({ 'main.tex': '\\input{same}\n\\input{same}', 'same.tex': '\\section{Same}' }))
    const after = await ambiguous.build(root, reader({ 'main.tex': '\\input{same}\n\\input{same}\n\\input{same}', 'same.tex': '\\section{Same}' }, 2))
    assert.ok(after.flat.every(node => !before.flat.some(previous => previous.id === node.id)))
    assertGraph(after)
})

test('a trailing source body or document boundary cannot disambiguate duplicate deletion', async () => {
    for (const suffix of ['\n\\end{document}', '\nclosing prose\n\\section{Tail}\n\\end{document}']) {
        const session = new OutlineSession()
        const first = await session.build(root, reader({ 'main.tex': '\\begin{document}\n\\section{Twin}\n\\section{Twin}' + suffix }))
        const second = await session.build(root, reader({ 'main.tex': '\\begin{document}\n\\section{Twin}' + suffix }, 2))
        assert.ok(!first.flat.some(node => node.id === named(second, 'Twin').id))
    }
})

test('unsaved edits propagate caption ranges, source versions, cross-file containment and fresh graph state', async () => {
    const session = new OutlineSession()
    const main = '\\documentclass{report}\n\\chapter{Root}\n\\input{child}\nafter include\n\\chapter{After}'
    const child = 'opening prose\n\\section{Inside}\n\\begin{figure}\nfloat body\n\\caption[Short]{Long\ncaption}\n\\end{figure}\n'
    const first = await session.build(root, reader({ 'main.tex': main, 'child.tex': child }, 7))
    const published = JSON.stringify(first)
    const editedMain = '\\chapter{Before}\n' + main
    const editedChild = '% unsaved preface\nnew prose\n' + child
    const second = await session.build(root, reader({ 'main.tex': editedMain, 'child.tex': editedChild }, 22))
    const caption = named(second, 'Short')
    assert.equal(caption.id, named(first, 'Short').id)
    assert.equal(caption.range.start.line, 6)
    assert.equal(editedChild.slice(caption.range.start.offset, caption.range.end.offset), '\\caption[Short]{Long\ncaption}')
    assert.equal(caption.number, '2.1')
    assert.equal(second.files.find(file => file.uri === caption.uri)?.version, 22)
    assert.deepEqual(findContaining(second, caption.uri, editedChild.indexOf('Short')), { kind: 'match', node: caption })
    assert.deepEqual(findContaining(second, caption.uri, editedChild.indexOf('float body')), { kind: 'match', node: named(second, 'Inside') })
    assert.deepEqual(findContaining(second, caption.uri, editedChild.indexOf('opening')), { kind: 'match', node: named(second, 'Root') })
    assert.deepEqual(findContaining(second, root, editedMain.indexOf('after include')), { kind: 'match', node: named(second, 'Inside') })
    assert.deepEqual(findContaining(second, caption.uri, editedChild.length), { kind: 'match', node: named(second, 'Inside') })
    assert.equal(JSON.stringify(first), published)
    assertGraph(second)

    const replacement = editedChild.replace('Long\ncaption', 'Unsaved long\nreplacement caption')
    const third = await session.build(root, reader({ 'main.tex': editedMain, 'child.tex': replacement }, 23))
    const changedCaption = named(third, 'Short')
    assert.notEqual(changedCaption.id, caption.id)
    assert.equal(replacement.slice(changedCaption.range.start.offset, changedCaption.range.end.offset), '\\caption[Short]{Unsaved long\nreplacement caption}')
    assert.equal(named(third, 'Inside').id, named(second, 'Inside').id)
    assert.equal(JSON.stringify(first), published)
    assertGraph(third)
})

test('missing candidates stay watchable and deleted or unreachable files never restore stale node targets', async () => {
    const session = new OutlineSession()
    const main = '\\chapter{Root}\\input{child}\\section{Tail}'
    const absent = await session.build(root, reader({ 'main.tex': main }))
    assert.deepEqual(absent.dependencies, [root, 'file:///fixture/child.tex', 'file:///fixture/child.tex.tex'])
    assert.equal(absent.diagnostics[0].code, 'missing-include')
    const created = await session.build(root, reader({ 'main.tex': main, 'child.tex': '\\section{Child}' }, 2))
    assert.equal(created.diagnostics.length, 0)
    assert.ok(created.dependencies.includes('file:///fixture/child.tex'))
    const deleted = await session.build(root, reader({ 'main.tex': main }, 3))
    assert.ok(!deleted.flat.some(node => node.id === named(created, 'Child').id))
    assert.ok(deleted.dependencies.includes('file:///fixture/child.tex'))
    const restored = await session.build(root, reader({ 'main.tex': main, 'child.tex': '\\section{Child}' }, 4))
    assert.notEqual(named(restored, 'Child').id, named(created, 'Child').id)
    assert.equal(named(restored, 'Root').id, named(created, 'Root').id)
    assertGraph(restored)

    await session.build(root, reader({ 'main.tex': '\\chapter{Root}\\section{Tail}', 'child.tex': '\\section{Child}' }, 5))
    const reachableAgain = await session.build(root, reader({ 'main.tex': main, 'child.tex': '\\section{Child}' }, 6))
    assert.notEqual(named(reachableAgain, 'Child').id, named(restored, 'Child').id)
    const missingRoot = await session.build(root, reader({}))
    assert.deepEqual(missingRoot.dependencies, [root])
    assert.equal(missingRoot.diagnostics[0].code, 'missing-root')
    const restoredRoot = await session.build(root, reader({ 'main.tex': main, 'child.tex': '\\section{Child}' }, 7))
    assert.ok(restoredRoot.flat.every(node => !reachableAgain.flat.some(previous => previous.id === node.id)))
})

test('parse failure removes stale targets and recovery starts fresh identities for the failed file', async () => {
    const session = new OutlineSession()
    const main = '\\chapter{Root}\\input{child}\\section{Tail}'
    const first = await session.build(root, reader({ 'main.tex': main, 'child.tex': '\\section{Child}' }))
    const broken = await session.build(root, reader({ 'main.tex': main, 'child.tex': '\\section{Unclosed' }, 2))
    assert.equal(broken.diagnostics[0].code, 'parse-error')
    assert.deepEqual(broken.flat.map(node => node.title), ['Root', 'Tail'])
    assert.ok(broken.dependencies.includes('file:///fixture/child.tex'))
    const brokenAgain = await session.build(root, reader({ 'main.tex': main, 'child.tex': '\\section{Unclosed' }, 3))
    assert.equal(brokenAgain.files.find(file => file.uri.endsWith('/child.tex'))?.version, 3)
    assert.equal(brokenAgain.diagnostics[0].code, 'parse-error')
    const recovered = await session.build(root, reader({ 'main.tex': main, 'child.tex': '\\section{Child}' }, 4))
    assert.notEqual(named(recovered, 'Child').id, named(first, 'Child').id)
    assert.equal(named(recovered, 'Root').id, named(first, 'Root').id)
    assertGraph(recovered)
})

test('live include directories preserve unaffected identities and watch earlier missing resolution candidates', async () => {
    const session = new OutlineSession({ texDirs: ['/one'] })
    const main = '\\chapter{Root}\\input{child}'
    const files = { 'main.tex': main, 'file:///one/child.tex': '\\section{Child}', 'file:///two/child.tex': '\\section{Child}' }
    const first = await session.build(root, reader(files))
    assert.ok(first.dependencies.includes('file:///fixture/child.tex'))
    assert.equal(named(first, 'Child').uri, 'file:///one/child.tex')
    session.configure({ texDirs: ['/two'] })
    const second = await session.build(root, reader(files, 2))
    assert.equal(named(second, 'Root').id, named(first, 'Root').id)
    assert.equal(named(second, 'Child').uri, 'file:///two/child.tex')
    assert.notEqual(named(second, 'Child').id, named(first, 'Child').id)
    const local = await session.build(root, reader({ ...files, 'child.tex': '\\section{Child}' }, 3))
    assert.equal(named(local, 'Child').uri, 'file:///fixture/child.tex')
    assert.notEqual(named(local, 'Child').id, named(second, 'Child').id)
    assert.ok(!local.dependencies.includes('file:///two/child.tex'))
    assertGraph(local)
})

test('parser configuration changes reparse unchanged text without losing safely matched nodes', async () => {
    const commands = { topic: 'chapter' as const }
    const session = new OutlineSession({ sectionCommands: commands })
    const files = { 'main.tex': '\\topic{Topic}\\section{Stable}' }
    const first = await session.build(root, reader(files))
    const published = JSON.stringify(first)
    session.configure({ sectionCommands: { topic: 'section' } })
    const second = await session.build(root, reader(files, 2))
    assert.equal(named(second, 'Topic').rank, 'section')
    assert.notEqual(named(second, 'Topic').id, named(first, 'Topic').id)
    assert.equal(named(second, 'Stable').id, named(first, 'Stable').id)
    assert.equal(named(second, 'Stable').parentId, undefined)
    assert.equal(JSON.stringify(first), published)
    const third = await session.build(root, reader(files, 3))
    assert.deepEqual(third.flat.map(node => node.id), second.flat.map(node => node.id))
    assert.equal(third.files[0].version, 3)
    assertGraph(third)
})

test('older concurrent completions cannot replace the latest reconciliation history', async () => {
    const session = new OutlineSession()
    const first = await session.build(root, reader({ 'main.tex': '\\section{Retained}' }))
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const oldReader = reader({ 'main.tex': '\\section{Outdated}' }, 2)
    const older = session.build(root, async uri => {
        entered()
        await gate
        return oldReader(uri)
    })
    await started
    const files = { 'main.tex': '\\section{New}\\section{Retained}' }
    const latest = await session.build(root, reader(files, 3))
    assert.equal(named(latest, 'Retained').id, named(first, 'Retained').id)
    release()
    await older
    const next = await session.build(root, reader(files, 4))
    assert.deepEqual(next.flat.map(node => node.id), latest.flat.map(node => node.id))
    assert.equal(next.files[0].version, 4)
    assertGraph(next)
})

test('a build captures its configuration and cannot commit after reconfiguration', async () => {
    const session = new OutlineSession({ sectionCommands: { topic: 'chapter' } })
    const files = { 'main.tex': '\\topic{Topic}\\section{Stable}' }
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const snapshots = reader(files)
    const older = session.build(root, async uri => {
        entered()
        await gate
        return snapshots(uri)
    })
    await started
    session.configure({ sectionCommands: { topic: 'section' } })
    const latest = await session.build(root, reader(files, 2))
    release()
    const obsolete = await older
    assert.equal(named(obsolete, 'Topic').rank, 'chapter')
    assert.equal(named(latest, 'Topic').rank, 'section')
    const next = await session.build(root, reader(files, 3))
    assert.deepEqual(next.flat.map(node => node.id), latest.flat.map(node => node.id))
})

test('each root has isolated history even when the same source appears in both graphs', async () => {
    const session = new OutlineSession()
    const other = 'file:///fixture/other.tex'
    const files = {
        'main.tex': '\\chapter{Main}\\input{shared}',
        'other.tex': '\\chapter{Other}\\input{shared}',
        'shared.tex': '\\section{Shared}',
    }
    const first = await session.build(root, reader(files))
    const second = await session.build(other, reader(files))
    assert.notEqual(named(first, 'Shared').id, named(second, 'Shared').id)
    const returned = await session.build(root, reader(files, 2))
    assert.deepEqual(returned.flat.map(node => node.id), first.flat.map(node => node.id))
})
