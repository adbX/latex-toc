import assert from 'node:assert/strict'
import test from 'node:test'
import {
    builtinPalette, defaultAppearance, isAppearanceState, isBuiltInName,
    paletteLimitBytes, paletteName, parsePalette, parsePaletteBytes, parseSectionCommands, putPalette, resolveAppearance,
    type AppearanceInput, type Palette,
} from '../src/appearance.js'
import { ranks } from '../src/model.js'
import { createSourceParser } from '../src/parse.js'

function candidate(name = 'Imported') {
    return {
        version: 1,
        name,
        light: { chapter: '#123', section: '#4567', subsection: '#89ABCD', subsubsection: '#Ef012345' },
    }
}

function frozenPalette(name: string): Palette {
    const palette = parsePalette(candidate(name))
    Object.freeze(palette.light)
    return Object.freeze(palette)
}

test('palette import normalizes each supported hex format without inventing a missing dark branch', () => {
    const input = candidate('  Research  ')
    const before = structuredClone(input)
    const palette = parsePalette(input)
    assert.equal(palette.name, 'Research')
    assert.deepEqual(palette.light, {
        chapter: '#112233ff', section: '#44556677', subsection: '#89abcdff', subsubsection: '#ef012345',
    })
    assert.equal(Object.hasOwn(palette, 'dark'), false)
    assert.deepEqual(input, before)
    input.light.chapter = '#fff'
    assert.equal(palette.light.chapter, '#112233ff')
})

test('imports validate the complete schema and both branches, never accepting CSS or workbench data', () => {
    const base = candidate()
    const invalid: unknown[] = [
        undefined, null, [], 'palette', new Date(), {}, { ...base, version: '1' }, { ...base, version: 2 },
        { name: base.name, light: base.light }, { version: 1, name: base.name, dark: base.light },
        { ...base, light: { chapter: '#123' } }, { ...base, dark: { chapter: '#123' } },
        { ...base, dark: undefined }, { ...base, dark: null },
        { ...base, colors: base.light }, { ...base, css: 'body{display:none}' },
        { ...base, 'workbench.colorCustomizations': {} },
        { ...base, light: { ...base.light, title: '#123' } },
        { ...base, dark: { ...base.light, section: 'url(https://example.invalid)' } },
        JSON.parse('{"version":1,"name":"unsafe","light":{},"__proto__":{"polluted":true}}'),
    ]
    for (const value of invalid) assert.throws(() => parsePalette(value), Error)
    for (const value of ['red', 'var(--color)', '#123; color:red', '#123\n', '#123\r', '#123 ', ' #123', '#12', '#12345', '#1234567', '#123456789', '#ggg', '', 123, null]) {
        assert.throws(() => parsePalette({ ...base, light: { ...base.light, chapter: value } }), Error)
    }
    assert.equal(({} as Record<string, unknown>).polluted, undefined)
})

test('palette names are bounded, control-free, trimmed, and built-in protection is case-insensitive', () => {
    assert.equal(paletteName('  Quiet palette  '), 'Quiet palette')
    assert.equal(paletteName('x'.repeat(80)), 'x'.repeat(80))
    for (const value of ['', '   ', 'x'.repeat(81), 'Bad\nname', '\tName', 'N\u0000ame', 'N\u007fame', 'N\u0085ame', null, 4]) {
        assert.throws(() => paletteName(value), Error)
    }
    assert.equal(isBuiltInName(` ${builtinPalette.name.toUpperCase()} `), true)
    const imported = parsePalette(candidate(builtinPalette.name.toUpperCase()))
    assert.equal(imported.name, builtinPalette.name.toUpperCase(), 'A protected-name import must remain available for the host rename prompt')
    assert.throws(() => putPalette([], imported), Error)
    assert.throws(() => putPalette([], imported, true), Error)
})

test('byte imports enforce the inclusive byte limit and reject malformed UTF-8 instead of replacing it', () => {
    const input = new TextEncoder().encode(JSON.stringify(candidate('École')))
    const atLimit = new Uint8Array(paletteLimitBytes).fill(0x20)
    atLimit.set(input)
    assert.equal(parsePaletteBytes(atLimit).name, 'École')
    const overLimit = new Uint8Array(paletteLimitBytes + 1).fill(0x20)
    overLimit.set(input)
    assert.throws(() => parsePaletteBytes(overLimit), Error)
    const malformed = input.slice()
    malformed[malformed.indexOf(0xc3)] = 0xff
    assert.throws(() => parsePaletteBytes(malformed), Error)
    for (const bytes of [new Uint8Array(), new TextEncoder().encode('{'), Uint8Array.of(0xef, 0xbb, 0xbf)]) {
        assert.throws(() => parsePaletteBytes(bytes), Error)
    }
})

test('named insertion and explicit replacement return detached libraries without mutating saved entries', () => {
    const library = Object.freeze([frozenPalette('First'), frozenPalette('Second')])
    const before = structuredClone(library)
    const incoming = parsePalette({ ...candidate(' FIRST '), light: { ...candidate().light, chapter: '#abc' } })
    assert.throws(() => putPalette(library, incoming), Error)
    assert.deepEqual(library, before)
    const replaced = putPalette(library, incoming, true)
    assert.deepEqual(replaced.map(palette => palette.name), ['FIRST', 'Second'])
    assert.equal(replaced[0].light.chapter, '#aabbccff')
    assert.deepEqual(library, before)
    const inserted = putPalette(library, parsePalette(candidate('Third')))
    assert.deepEqual(inserted.map(palette => palette.name), ['First', 'Second', 'Third'])
    assert.deepEqual(library, before)
})


test('invalid stored libraries cannot acquire duplicates or protected entries through insertion', () => {
    const duplicate = [frozenPalette('Same'), frozenPalette('SAME')]
    assert.throws(() => putPalette(duplicate, frozenPalette('Other')), Error)
    assert.throws(() => putPalette([builtinPalette], frozenPalette('Other')), Error)
    const unsafeName = parsePalette(candidate('__proto__'))
    const library = putPalette([], unsafeName)
    assert.equal(resolveAppearance({ palette: '__proto__' }, library).resolvedPalette, '__proto__')
})

test('optional ranks inherit effective documented parents, not neighboring overridden ranks', () => {
    const library = [parsePalette(candidate())]
    const state = resolveAppearance({
        palette: 'Imported',
        lightOverrides: { chapter: '#abc', subsubsection: '#def', paragraph: '#1234' },
        darkOverrides: { chapter: '#345', subsubsection: '#678', paragraph: '#abcd' },
    }, library)
    for (const branch of [state.colors.light, state.colors.dark]) {
        assert.equal(branch.part, branch.chapter)
        assert.equal(branch.subparagraph, branch.subsubsection)
        assert.notEqual(branch.paragraph, branch.subparagraph, 'Subparagraph inherits subsubsection, not paragraph')
    }
    assert.equal(state.colors.light.part, '#aabbccff')
    assert.equal(state.colors.dark.part, '#334455ff')
    assert.equal(state.colors.light.subparagraph, '#ddeeffff')
    const reset = resolveAppearance({ palette: 'Imported', lightOverrides: { subsubsection: '#def' } }, library)
    assert.equal(reset.colors.light.paragraph, reset.colors.light.subsubsection)
})

test('direct optional palette colors beat inheritance while explicit rank overrides beat direct colors', () => {
    const branch = { ...candidate().light, part: '#a01', paragraph: '#b02', subparagraph: '#c03' }
    const library = [parsePalette({ ...candidate(), light: branch, dark: branch })]
    const direct = resolveAppearance({ palette: 'Imported', lightOverrides: { chapter: '#fff', subsubsection: '#eee' } }, library)
    assert.equal(direct.colors.light.part, '#aa0011ff')
    assert.equal(direct.colors.light.paragraph, '#bb0022ff')
    assert.equal(direct.colors.light.subparagraph, '#cc0033ff')
    const overridden = resolveAppearance({ palette: 'Imported', lightOverrides: { part: '#123', paragraph: '#234', subparagraph: '#345' } }, library)
    assert.equal(overridden.colors.light.part, '#112233ff')
    assert.equal(overridden.colors.light.paragraph, '#223344ff')
    assert.equal(overridden.colors.light.subparagraph, '#334455ff')
    assert.equal(overridden.colors.dark.part, '#aa0011ff', 'Light overrides must not leak into dark colors')
})

test('palette selection preserves explicit overrides and removing one exposes the newly selected base', () => {
    const library = [
        parsePalette({ ...candidate('First'), dark: candidate().light }),
        parsePalette({ ...candidate('Second'), light: { ...candidate().light, section: '#bad', chapter: '#fed' }, dark: { ...candidate().light, section: '#cab' } }),
    ]
    const overrides = Object.freeze({ section: '#1234' })
    const before = resolveAppearance({ palette: 'First', lightOverrides: overrides, darkOverrides: overrides }, library)
    const after = resolveAppearance({ palette: 'Second', lightOverrides: overrides, darkOverrides: overrides }, library)
    assert.equal(after.colors.light.section, before.colors.light.section)
    assert.equal(after.colors.dark.section, before.colors.dark.section)
    assert.notEqual(after.colors.light.chapter, before.colors.light.chapter)
    const reset = resolveAppearance({ palette: 'Second', lightOverrides: {}, darkOverrides: overrides }, library)
    assert.equal(reset.colors.light.section, '#bbaaddff')
    assert.equal(reset.colors.dark.section, before.colors.dark.section)
    assert.deepEqual(overrides, { section: '#1234' })
})

test('light-only palettes report dark fallback and still honor dark overrides', () => {
    const palette = parsePalette(candidate('Light only'))
    const state = resolveAppearance({ palette: 'light ONLY', darkOverrides: { section: '#abc' } }, [palette])
    assert.equal(state.requestedPalette, 'light ONLY')
    assert.equal(state.resolvedPalette, 'Light only')
    assert.equal(state.colors.light.chapter, palette.light.chapter)
    assert.equal(state.colors.dark.chapter, defaultAppearance.colors.dark.chapter)
    assert.equal(state.colors.dark.section, '#aabbccff')
    const both = resolveAppearance({ palette: 'Both' }, [parsePalette({ ...candidate('Both'), dark: candidate().light })])
    assert.equal(both.notice, undefined)
    assert.equal(both.colors.dark.chapter, both.colors.light.chapter)
})

test('missing palette reports requested and actual names without dropping valid settings', () => {
    const state = resolveAppearance({ palette: 'Removed', indentPx: 24, visibleRanks: [], lightOverrides: { chapter: '#abc' } }, [])
    assert.equal(state.requestedPalette, 'Removed')
    assert.equal(state.resolvedPalette, builtinPalette.name)
    assert.equal(state.indentPx, 24)
    assert.deepEqual(state.visibleRanks, [])
    assert.equal(state.colors.light.chapter, '#aabbccff')
    assert.equal(state.colors.light.section, defaultAppearance.colors.light.section)
})

test('appearance settings reject invalid bounds and values while null rank overrides inherit', () => {
    assert.deepEqual(resolveAppearance({ lightOverrides: { chapter: null }, darkOverrides: { paragraph: null } }, []), defaultAppearance)
    for (const value of [8, 32]) assert.equal(resolveAppearance({ indentPx: value }, []).indentPx, value)
    const invalid: AppearanceInput[] = [
        ...[7, 33, 8.5, NaN, Infinity, '16', null].map(indentPx => ({ indentPx })),
        ...['', null, 4].map(palette => ({ palette })),
        ...[null, {}, ['section', 'section'], ['Section'], ['caption'], [undefined], new Array(1)].map(visibleRanks => ({ visibleRanks })),
        ...[null, [], '#123', { section: undefined }, { section: '' }, { section: 'red' }, { caption: '#abc' }].map(lightOverrides => ({ lightOverrides })),
        { darkOverrides: { chapter: 'url(https://example.invalid)' } }, { darkOverrides: null },
    ]
    for (const input of invalid) assert.throws(() => resolveAppearance(input, []), Error)
})

test('rank visibility supports all ranks and empty selection without mutating caller order or defaults', () => {
    const requested = Object.freeze(['subparagraph', 'part', 'section'])
    const state = resolveAppearance({ visibleRanks: requested }, [])
    assert.deepEqual(state.visibleRanks, requested)
    assert.deepEqual(resolveAppearance({ visibleRanks: ranks }, []).visibleRanks, ranks)
    assert.deepEqual(resolveAppearance({ visibleRanks: [] }, []).visibleRanks, [])
    const separate = resolveAppearance({}, [])
    separate.colors.light.chapter = '#000000ff'
    assert.notEqual(defaultAppearance.colors.light.chapter, separate.colors.light.chapter)
    assert.deepEqual(resolveAppearance({}, []).colors, defaultAppearance.colors)
})

test('appearance message guard requires complete normalized safe colors and validates all settings', () => {
    assert.equal(isAppearanceState(defaultAppearance), true)
    assert.equal(isAppearanceState(resolveAppearance({ palette: 'Missing' }, [])), true)
    const { paragraph: _paragraph, ...incomplete } = defaultAppearance.colors.light
    const { indentPx: _indentPx, ...noIndent } = defaultAppearance
    const invalid: unknown[] = [
        undefined, null, [], {}, noIndent,
        { ...defaultAppearance, indentPx: 100 },
        { ...defaultAppearance, requestedPalette: ' Bad ' },
        { ...defaultAppearance, resolvedPalette: '' },
        { ...defaultAppearance, visibleRanks: ['section', 'section'] },
        { ...defaultAppearance, visibleRanks: undefined },
        { ...defaultAppearance, notice: {} },
        { ...defaultAppearance, colors: { light: defaultAppearance.colors.light } },
        { ...defaultAppearance, colors: { ...defaultAppearance.colors, light: incomplete } },
        { ...defaultAppearance, colors: { ...defaultAppearance.colors, light: { ...defaultAppearance.colors.light, chapter: '#abc' } } },
        { ...defaultAppearance, colors: { ...defaultAppearance.colors, dark: { ...defaultAppearance.colors.dark, part: 'url(https://example.invalid)' } } },
        { ...defaultAppearance, colors: { ...defaultAppearance.colors, style: 'display:none' } },
    ]
    for (const value of invalid) assert.equal(isAppearanceState(value), false)
})

test('alias settings admit only custom ASCII control words mapped to supported ranks', () => {
    assert.deepEqual(parseSectionCommands(undefined), {})
    assert.deepEqual(parseSectionCommands({}), {})
    const input = Object.freeze({ Topic: 'chapter', topic: 'section', detail: 'subparagraph' })
    assert.deepEqual(parseSectionCommands(input), input)
    for (const command of ['', '\\topic', 'topic*', 'topic2', 'topic name', 'topic\n', 'épisode', 'topic@internal', 'topic_name', 'topic:name']) {
        assert.throws(() => parseSectionCommands({ [command]: 'section' }), Error)
    }
    for (const command of [...ranks, 'documentclass', 'setcounter', 'appendix', 'input', 'include', 'caption', 'begin', 'end', 'verb', 'newcommand', 'renewcommand', 'providecommand', 'def', 'gdef', 'edef', 'xdef', 'let']) {
        assert.throws(() => parseSectionCommands({ [command]: 'section' }), Error)
    }
    for (const value of [null, [], 'topic', { topic: 'caption' }, { topic: 'Section' }, { topic: null }, { topic: { rank: 'section' } }]) {
        assert.throws(() => parseSectionCommands(value), Error)
    }
    assert.throws(() => parseSectionCommands(JSON.parse('{"__proto__":"chapter"}')), Error)
})

test('validated aliases retain the production parser star, short-title, and no-expansion behavior', () => {
    const parser = createSourceParser({ sectionCommands: parseSectionCommands({ topic: 'chapter', detail: 'paragraph' }) })
    const text = '\\newcommand{\\unused}{\\topic{Not executed}}\n% \\topic{Comment}\n\\topic*[Short]{Long}\n\\detail{Detail}\n\\section{Standard}\n'
    const parsed = parser({ uri: 'file:///fixture/aliases.tex', text, version: 1 })
    const headings = parsed.events.filter(event => event.type === 'heading')
    assert.deepEqual(headings.map(event => [event.command, event.rank, event.title, event.starred]), [
        ['topic', 'chapter', 'Short', true], ['detail', 'paragraph', 'Detail', false], ['section', 'section', 'Standard', false],
    ])
    assert.equal(text.slice(headings[0].range.start.offset, headings[0].range.end.offset), '\\topic*[Short]{Long}')
})
