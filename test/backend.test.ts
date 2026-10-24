import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileUri, sourceReader } from '../src/files.js'
import { buildOutline, findContaining } from '../src/project.js'
import type { ReadSource } from '../src/model.js'

const fixture = (files: Record<string, string>): ReadSource => async uri => {
    const name = new URL(uri).pathname.split('/').pop()!
    return files[name] === undefined ? undefined : { uri, text: files[name], version: 1 }
}
const root = 'file:///fixture/main.tex'

test('nested includes retain order and give heading-free child prose its cross-file parent', async () => {
    const child = 'child prose\n\\input{nested}\nmore child prose\n'
    const outline = await buildOutline(root, fixture({
        'main.tex': '\\documentclass{report}\n\\chapter{First}\n\\input{child}\n\\chapter{Last}\n',
        'child.tex': child,
        'nested.tex': 'nested prose\n\\section{Inside}\ninside prose\n',
    }))
    assert.deepEqual(outline.flat.map(node => [node.title, node.number]), [['First', '1'], ['Inside', '1.1'], ['Last', '2']])
    assert.deepEqual(outline.diagnostics, [])
    const childStart = findContaining(outline, 'file:///fixture/child.tex', 2)
    assert.equal(childStart.kind, 'match')
    if (childStart.kind === 'match') assert.equal(childStart.node.title, 'First')
    const childEnd = findContaining(outline, 'file:///fixture/child.tex', child.indexOf('more'))
    assert.equal(childEnd.kind, 'match')
    if (childEnd.kind === 'match') assert.equal(childEnd.node.title, 'Inside')
    const nestedStart = findContaining(outline, 'file:///fixture/nested.tex', 1)
    assert.equal(nestedStart.kind, 'match')
    if (nestedStart.kind === 'match') assert.equal(nestedStart.node.title, 'First')
})

test('repeated inclusion distinguishes duplicate titles and refuses ambiguous containment', async () => {
    const outline = await buildOutline(root, fixture({
        'main.tex': '\\chapter{First}\\input{same}\\chapter{Second}\\input{same}',
        'same.tex': '\\section{Repeated}\nbody\n',
    }))
    const repeated = outline.flat.filter(node => node.title === 'Repeated')
    assert.equal(repeated.length, 2)
    assert.notEqual(repeated[0].id, repeated[1].id)
    assert.notEqual(repeated[0].parentId, repeated[1].parentId)
    assert.equal(findContaining(outline, repeated[0].uri, 2).kind, 'ambiguous')
    assert.deepEqual(findContaining(outline, repeated[0].uri, 2, repeated[1].occurrence), { kind: 'match', node: repeated[1] })
})

test('stars, optional titles, counters and appendix state survive include boundaries', async () => {
    const outline = await buildOutline(root, fixture({
        'main.tex': '\\documentclass{report}\n\\setcounter{chapter}{-1}\n\\input{body}\n\\appendix\n\\input{appendix}',
        'body.tex': '\\chapter[Short]{Long title}\n\\chapter*{Unnumbered}\n\\begin{figure}\n\\caption[Brief]{Full caption}\n\\end{figure}\n\\chapter{Next}',
        'appendix.tex': '\\chapter{Ledger}\n\\section{Details}\n\\begin{table}\\caption{Data}\\end{table}',
    }))
    assert.deepEqual(outline.flat.map(node => [node.title, node.number]), [
        ['Short', '0'], ['Unnumbered', undefined], ['Brief', '1'], ['Next', '1'], ['Ledger', 'A'], ['Details', 'A.1'], ['Data', 'A.1'],
    ])
})

test('navigation targets full caption commands and prose inside floats follows the heading', async () => {
    const text = '\\chapter{One}\n\\begin{figure}\nplain float body\n\\caption[Short]{A long\ncaption}\n\\end{figure}\n'
    const outline = await buildOutline(root, fixture({ 'main.tex': text }))
    const caption = outline.flat[1]
    assert.equal(text.slice(caption.range.start.offset, caption.range.end.offset), '\\caption[Short]{A long\ncaption}')
    assert.equal(caption.range.start.line, 3)
    assert.deepEqual(findContaining(outline, root, text.indexOf('Short')), { kind: 'match', node: caption })
    assert.deepEqual(findContaining(outline, root, text.indexOf('plain')), { kind: 'match', node: outline.flat[0] })
    assert.deepEqual(findContaining(outline, root, text.length), { kind: 'match', node: outline.flat[0] })
})

test('same-line headings keep exact command ranges and distinct containing intervals', async () => {
    const text = '\\section{One} first \\section{Two} second'
    const outline = await buildOutline(root, fixture({ 'main.tex': text }))
    assert.equal(text.slice(outline.flat[0].range.start.offset, outline.flat[0].range.end.offset), '\\section{One}')
    assert.deepEqual(findContaining(outline, root, text.indexOf('first')), { kind: 'match', node: outline.flat[0] })
    assert.deepEqual(findContaining(outline, root, text.indexOf('second')), { kind: 'match', node: outline.flat[1] })
})

test('missing files, include cycles and malformed sources are explicit diagnostics, not fallback parses', async () => {
    const outline = await buildOutline(root, fixture({
        'main.tex': '\\chapter{Root}\\input{absent}\\input{cycle}\\input{broken}\\section{Survives}',
        'cycle.tex': '\\input{main}',
        'broken.tex': '\\section{Unclosed',
    }))
    assert.deepEqual(outline.diagnostics.map(item => item.code).sort(), ['include-cycle', 'missing-include', 'parse-error'])
    assert.deepEqual(outline.flat.map(node => node.title), ['Root', 'Survives'])
    assert.equal((await buildOutline(root, fixture({}))).diagnostics[0].code, 'missing-root')
})

test('custom section aliases use parsed arguments, not text matches or macro-definition bodies', async () => {
    const outline = await buildOutline(root, fixture({
        'main.tex': '\\newcommand{\\hidden}{\\section{Not executed}}\n% \\section{Comment}\n\\topic[Brief]{Full}\n\\section*{Visible}',
    }), { sectionCommands: { topic: 'chapter' } })
    assert.deepEqual(outline.flat.map(node => [node.rank, node.title, node.number]), [['chapter', 'Brief', '1'], ['section', 'Visible', undefined]])
})

test('dirty snapshots win over disk, retain versions, and unrelated preceding prose preserves identities', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'latex-toc-buffer-'))
    try {
        const main = join(directory, 'main.tex')
        const child = join(directory, "chapter's space.tex")
        await writeFile(main, "\\chapter{Root}\\input{chapter's space.tex}")
        await writeFile(child, '\\section{Saved}')
        const bufferUri = fileUri(child).replaceAll("'", '%27')
        const first = await buildOutline(fileUri(main), sourceReader([{ uri: bufferUri, text: '\\section{Unsaved}', version: 8 }]))
        const second = await buildOutline(fileUri(main), sourceReader([{ uri: bufferUri, text: 'new prose\n\\section{Unsaved}', version: 9 }]))
        assert.equal(first.flat[1].title, 'Unsaved')
        assert.equal(first.files.find(file => file.uri === fileUri(child))?.version, 8)
        assert.equal(second.flat[1].id, first.flat[1].id)
        assert.equal(await readFile(child, 'utf8'), '\\section{Saved}')
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test('masked comments and verbatim preserve exact raw offsets and inherited plain labels', async () => {
    const text = String.raw`% \section{Comment}
\begin{minted}{tex}
\section{Not executed}
\end{minted} \section{\textbf{Visible} $\alpha$ \texorpdfstring{TeX}{PDF}}
body`
    const outline = await buildOutline(root, fixture({ 'main.tex': text }))
    assert.deepEqual(outline.flat.map(node => node.title), ['Visible α PDF'])
    const node = outline.flat[0]
    assert.equal(text.slice(node.range.start.offset, node.range.end.offset), String.raw`\section{\textbf{Visible} $\alpha$ \texorpdfstring{TeX}{PDF}}`)
    assert.equal(node.range.start.line, 3)
    assert.equal(node.range.start.character, 13)
    assert.deepEqual(findContaining(outline, root, text.indexOf('body')), { kind: 'match', node })
})

test('CRLF source navigation counts UTF-16 units through masked text and multiline captions', async () => {
    const headingCommand = '\\section{Heading}'
    const captionCommand = '\\caption{Long \u{1D49C}\r\ncaption}'
    const text = [
        '% \u{1D49C} \\section{Comment}',
        '\\begin{verbatim}',
        '\u{1D49C} \\section{Not executed}',
        '\\end{verbatim}',
        `\u{1D49C} ${headingCommand}`,
        '\\begin{figure}',
        `\u{1D49C} ${captionCommand}`,
        '\\end{figure}',
        'prose',
    ].join('\r\n')
    const outline = await buildOutline(root, fixture({ 'main.tex': text }))
    assert.equal(outline.flat.length, 2)
    const [heading, caption] = outline.flat
    const headingOffset = text.indexOf(headingCommand)
    const captionOffset = text.indexOf(captionCommand)
    assert.deepEqual(heading.range, {
        start: { offset: headingOffset, line: 4, character: 3 },
        end: { offset: headingOffset + headingCommand.length, line: 4, character: 3 + headingCommand.length },
    })
    assert.deepEqual(caption.range, {
        start: { offset: captionOffset, line: 6, character: 3 },
        end: { offset: captionOffset + captionCommand.length, line: 7, character: 8 },
    })
    assert.equal(text.slice(caption.range.start.offset, caption.range.end.offset), captionCommand)
    assert.deepEqual(findContaining(outline, root, text.indexOf('caption}')), { kind: 'match', node: caption })
    assert.deepEqual(findContaining(outline, root, caption.range.end.offset), { kind: 'match', node: heading })
    assert.deepEqual(findContaining(outline, root, text.indexOf('prose')), { kind: 'match', node: heading })
})
