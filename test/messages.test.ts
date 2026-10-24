import assert from 'node:assert/strict'
import test from 'node:test'
import { parseViewMessage, type ViewMessage } from '../src/host/messages.js'

const messages: readonly ViewMessage[] = [
    { type: 'ready' },
    { type: 'chooseRoot' },
    { type: 'toggleFollow' },
    { type: 'selectPalette' },
    { type: 'navigate', version: 1, id: 'node' },
    { type: 'focus', version: 1, id: 'node' },
    { type: 'expand', version: 1, id: 'node', expanded: false },
    { type: 'scroll', version: 1, top: 0 },
    { type: 'view', version: 1, contentMode: 'headings', chapterOnly: false },
    { type: 'bulkExpand', version: 1, expanded: true },
]

test('host accepts each supported action but rejects extra authority and missing fields', () => {
    for (const message of messages) {
        assert.deepEqual(parseViewMessage(message), message)
        assert.equal(parseViewMessage({ ...message, command: 'workbench.action.openSettings' }), undefined)
        for (const key of Object.keys(message)) {
            const incomplete = { ...message } as Record<string, unknown>
            delete incomplete[key]
            assert.equal(parseViewMessage(incomplete), undefined)
        }
    }
    for (const extra of [
        { path: '/outside/main.tex' },
        { uri: 'file:///outside/main.tex' },
        { range: { start: 0, end: 10 } },
        { settings: { followEditor: false } },
    ]) {
        assert.equal(parseViewMessage({ type: 'navigate', version: 1, id: 'node', ...extra }), undefined)
    }
})

test('host rejects malformed message shapes and unsupported actions', () => {
    for (const value of [undefined, null, false, 1, 'ready', [], [{ type: 'ready' }], {},
        { type: ['ready'] }, { type: 'executeCommand', command: 'vscode.open' },
        { type: 'unknown', version: 1, id: 'node' }]) {
        assert.equal(parseViewMessage(value), undefined)
    }
})

test('versioned actions require positive safe integer versions and bounded string node IDs', () => {
    for (const message of messages.filter(message => 'version' in message)) {
        for (const version of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1', null]) {
            assert.equal(parseViewMessage({ ...message, version }), undefined)
        }
    }
    for (const type of ['navigate', 'focus', 'expand']) {
        const base = type === 'expand' ? { type, version: 1, expanded: true } : { type, version: 1 }
        for (const id of ['', 'x'.repeat(4097), 1, null, ['node'], { id: 'node' }]) {
            assert.equal(parseViewMessage({ ...base, id }), undefined)
        }
    }
    const boundary = { type: 'navigate', version: Number.MAX_SAFE_INTEGER, id: 'x'.repeat(4096) }
    assert.deepEqual(parseViewMessage(boundary), boundary)
})

test('view state rejects coerced booleans, invalid modes and nonfinite or negative scroll positions', () => {
    for (const top of [-1, NaN, Infinity, -Infinity, '0', null]) {
        assert.equal(parseViewMessage({ type: 'scroll', version: 1, top }), undefined)
    }
    const scroll = { type: 'scroll', version: 1, top: 12.5 }
    assert.deepEqual(parseViewMessage(scroll), scroll)
    for (const value of [0, 1, 'false', null]) {
        assert.equal(parseViewMessage({ type: 'expand', version: 1, id: 'node', expanded: value }), undefined)
        assert.equal(parseViewMessage({ type: 'bulkExpand', version: 1, expanded: value }), undefined)
        assert.equal(parseViewMessage({ type: 'view', version: 1, contentMode: 'headings', chapterOnly: value }), undefined)
    }
    for (const contentMode of ['all', '', null, ['headings']]) {
        assert.equal(parseViewMessage({ type: 'view', version: 1, contentMode, chapterOnly: true }), undefined)
    }
    const floats = { type: 'view', version: 1, contentMode: 'floats', chapterOnly: true }
    assert.deepEqual(parseViewMessage(floats), floats)
})
