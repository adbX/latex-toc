import assert from 'node:assert/strict'
import test from 'node:test'
import type { ViewNode } from '../src/host/messages.js'
import { defaultAppearance, defaultVisibleRanks } from '../src/appearance.js'
import { ranks } from '../src/model.js'
import { ancestry, chapterFor, headingTree, indexOutline, isHostState, scopedTree, visibleRows } from '../src/webview/outline.js'
import { fitBreadcrumb } from '../src/webview/breadcrumb.js'

const nodes: ViewNode[] = [
    { id: 'part', kind: 'heading', rank: 'part', title: 'Part', number: 'I', source: 'main.tex' },
    { id: 'front', parentId: 'part', kind: 'heading', rank: 'section', title: 'Front matter', source: 'front.tex' },
    { id: 'one', parentId: 'part', kind: 'heading', rank: 'chapter', title: 'One', number: '1', source: 'one.tex' },
    { id: 'section', parentId: 'one', kind: 'heading', rank: 'section', title: 'Detail', number: '1.1', source: 'one.tex' },
    { id: 'paragraph', parentId: 'section', kind: 'heading', rank: 'paragraph', title: 'Hidden', source: 'one.tex' },
    { id: 'figure', parentId: 'paragraph', kind: 'figure', title: 'Caption', number: '1.1', source: 'one.tex' },
    { id: 'two', parentId: 'part', kind: 'heading', rank: 'chapter', title: 'Two', number: '2', source: 'two.tex' },
    { id: 'other', parentId: 'two', kind: 'heading', rank: 'section', title: 'Other', number: '2.1', source: 'two.tex' },
]

test('displayed hierarchy promotes hidden ranks without losing semantic ancestry or chapter scope', () => {
    const byId = indexOutline(nodes)
    const tree = headingTree(nodes, byId, defaultVisibleRanks)
    assert.deepEqual(tree.map(item => item.node.id), ['front', 'one', 'two'])
    assert.deepEqual(ancestry(byId, 'figure').map(node => node.id), ['part', 'one', 'section', 'paragraph', 'figure'])
    assert.equal(chapterFor(byId, 'figure')?.id, 'one')
    assert.equal(chapterFor(byId, 'front'), undefined)
    assert.equal(tree[1].children[0].node.number, '1.1')
    assert.equal(tree[1].children[0].node.source, 'one.tex')
    assert.deepEqual(scopedTree(tree, byId, chapterFor(byId, 'figure')?.id).map(item => item.node.id), ['one'])
    assert.equal(scopedTree(tree, byId, chapterFor(byId, 'front')?.id), tree)
})

test('visible keyboard traversal excludes collapsed descendants and preserves unrelated branches', () => {
    const byId = indexOutline(nodes)
    const tree = headingTree(nodes, byId, defaultVisibleRanks)
    const expanded = new Set(['one', 'two'])
    assert.deepEqual(visibleRows(tree, expanded).map(item => item.node.id), ['front', 'one', 'section', 'two', 'other'])
    expanded.delete('one')
    assert.deepEqual(visibleRows(tree, expanded).map(item => item.node.id), ['front', 'one', 'two', 'other'])
    assert.equal(tree[1].children[0].parentId, 'one')
    assert.deepEqual(visibleRows(scopedTree(tree, byId, 'two'), expanded).map(item => item.node.id), ['two', 'other'])
})

test('hidden chapters scope promoted descendants beneath visible parts without leaking other chapters', () => {
    const byId = indexOutline(nodes)
    const tree = headingTree(nodes, byId, ['paragraph', 'section', 'part'])
    assert.deepEqual(tree.map(item => item.node.id), ['part'])
    assert.deepEqual(tree[0].children.map(item => item.node.id), ['front', 'section', 'other'])
    const scoped = scopedTree(tree, byId, chapterFor(byId, 'figure')?.id)
    assert.deepEqual(scoped.map(item => item.node.id), ['section'])
    assert.equal(scoped[0].parentId, undefined)
    assert.equal(scoped[0].node.parentId, 'one')
    assert.equal(scoped[0].children[0].node, byId.get('paragraph'))
    assert.deepEqual(ancestry(byId, scoped[0].children[0].node.id).map(node => node.id), ['part', 'one', 'section', 'paragraph'])
    assert.deepEqual(scopedTree(tree, byId, 'two').map(item => item.node.id), ['other'])
    assert.deepEqual(scopedTree(tree, byId, 'missing'), [])
    assert.equal(scopedTree(tree, byId, chapterFor(byId, 'front')?.id), tree)
})

test('every rank subset preserves source order, identity, numbers and full ancestry', () => {
    const complete: ViewNode[] = ranks.map((rank, index) => ({
        id: rank, parentId: ranks[index - 1], kind: 'heading', rank,
        title: rank, number: `original-${index}`, source: `${rank}.tex`,
    }))
    complete.push(
        { id: 'next-chapter', parentId: 'part', kind: 'heading', rank: 'chapter', title: 'Next', number: '2', source: 'next.tex' },
        { id: 'next-section', parentId: 'next-chapter', kind: 'heading', rank: 'section', title: 'Next detail', number: '2.1', source: 'next.tex' },
    )
    const byId = indexOutline(complete)
    const expanded = new Set(complete.map(node => node.id))
    for (let mask = 0; mask < 2 ** ranks.length; mask++) {
        // Settings order is deliberately reversed; it must not reorder source rows.
        const visible = ranks.filter((_, index) => mask & (1 << index)).reverse()
        const tree = headingTree(complete, byId, visible)
        const rows = visibleRows(tree, expanded)
        const expected = complete.filter(node => visible.includes(node.rank!))
        assert.deepEqual(rows.map(item => item.node.id), expected.map(node => node.id))
        for (const item of rows) {
            const canonical = byId.get(item.node.id)!
            assert.equal(item.node, canonical)
            assert.equal(item.node.number, canonical.number)
            assert.equal(item.node.source, canonical.source)
            const parents = ancestry(byId, item.node.id).slice(0, -1)
            assert.equal(item.parentId, parents.filter(node => visible.includes(node.rank!)).at(-1)?.id)
        }
        const scope = scopedTree(tree, byId, 'chapter')
        assert.deepEqual(visibleRows(scope, expanded).map(item => item.node.id),
            expected.filter(node => chapterFor(byId, node.id)?.id === 'chapter').map(node => node.id))
        for (const root of scope) assert.equal(root.parentId, undefined)
        assert.deepEqual(ancestry(byId, 'subparagraph').map(node => node.id), [...ranks])
    }
})

test('host snapshots require a complete validated appearance before reaching CSS', () => {
    const state = {
        type: 'state', status: 'ready', version: 1, message: '', nodes, expanded: [],
        scrollTop: 0, contentMode: 'headings', chapterOnly: false, followEditor: true,
        diagnostics: [], appearance: defaultAppearance,
    }
    assert.equal(isHostState(state), true)
    assert.equal(isHostState({ ...state, appearance: undefined }), false)
    assert.equal(isHostState({ ...state, appearance: { ...defaultAppearance, indentPx: 7 } }), false)
    assert.equal(isHostState({ ...state, appearance: { ...defaultAppearance, visibleRanks: ['unknown'] } }), false)
    assert.equal(isHostState({ ...state, appearance: { ...defaultAppearance,
        colors: { ...defaultAppearance.colors, light: { ...defaultAppearance.colors.light, chapter: 'url(untrusted)' } },
    } }), false)
})

test('breadcrumb fitting retains every ancestor and reference while clipping only title space', () => {
    const ancestors = nodes.slice(0, 5)
    const widths = [90, 240, 310, 150, 190]
    const minimums = [25, 70, 40, 32, 75]
    const lines = fitBreadcrumb(ancestors, widths, minimums, 220)
    assert.equal(lines.length, 2)
    assert.deepEqual(lines.flatMap(line => line.items.map(item => item.node)), ancestors)
    for (const line of lines) {
        assert.ok(line.items.reduce((sum, item) => sum + item.width!, 0) + 4 * (line.items.length - 1) <= 220.1)
        for (const item of line.items) assert.ok(item.width! >= minimums[ancestors.indexOf(item.node)])
    }
    const cramped = fitBreadcrumb(ancestors, widths, minimums, 80)
    assert.deepEqual(cramped.flatMap(line => line.items.map(item => item.node)), ancestors)
    for (const line of cramped) {
        for (const item of line.items) assert.ok(item.width! >= minimums[ancestors.indexOf(item.node)], 'Narrow widths must not clip references')
    }
})
