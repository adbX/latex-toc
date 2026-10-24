import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import * as vscode from 'vscode'
import { fileUri } from '../src/files.js'
import { findContaining } from '../src/project.js'
import type { Outline, OutlineNode } from '../src/model.js'

interface CorpusResult {
    corpus: string
    files: number
    headings: number
    floats: number
    stockNodes: number
    matchingLabels: number
    appendixCorrections: number
    captionTargetCorrections: number
    sourceRangesChecked: number
    unsupported: string[]
}

function stockLabel(node: OutlineNode): string {
    if (node.kind === 'heading') return `${node.number ?? '*'} ${node.title}`
    return `${node.kind === 'figure' ? 'Figure' : 'Table'} ${node.number}${node.title ? `: ${node.title}` : ''}`
}

async function inspect(root: string): Promise<Outline> {
    return await vscode.commands.executeCommand<Outline>('latexTocExperiment.inspect', root)
}

async function compare(corpus: string, path: string): Promise<{ result: CorpusResult; outline: Outline }> {
    const root = fileUri(path)
    await vscode.window.showTextDocument(vscode.Uri.file(path), { preview: false })
    const stock = vscode.extensions.getExtension('James-Yu.latex-workshop')
    assert.ok(stock, 'Load the separately built, pinned stock Workshop as a development extension.')
    await stock.activate()
    const outline = await inspect(root)
    assert.deepEqual(outline.diagnostics, [])
    const sourceUris = new Set(outline.files.map(file => file.uri))
    let symbols: vscode.SymbolInformation[] = []
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
        symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', '') ?? []
        if (symbols.length === outline.flat.length && symbols.every(symbol => sourceUris.has(fileUri(symbol.location.uri.fsPath)))) break
        await delay(150)
    }
    assert.equal(symbols.length, outline.flat.length, 'Stock public project symbols must be ready and complete.')
    const result: CorpusResult = {
        corpus, files: outline.files.length, headings: outline.flat.filter(node => node.kind === 'heading').length,
        floats: outline.flat.filter(node => node.kind !== 'heading').length, stockNodes: symbols.length,
        matchingLabels: 0, appendixCorrections: 0, captionTargetCorrections: 0, sourceRangesChecked: 0, unsupported: [],
    }
    const used = new Set<vscode.SymbolInformation>()
    for (const node of outline.flat) {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(node.uri))
        const start = new vscode.Position(node.range.start.line, node.range.start.character)
        const end = new vscode.Position(node.range.end.line, node.range.end.character)
        assert.equal(document.offsetAt(start), node.range.start.offset)
        assert.equal(document.offsetAt(end), node.range.end.offset)
        const source = document.getText(new vscode.Range(start, end))
        assert.ok(source.startsWith(node.kind === 'heading' ? `\\${node.command}` : '\\caption'), 'Every corpus node must target its actual command.')
        assert.ok(source.endsWith('}'), 'Corpus command ranges must include their complete argument.')
        result.sourceRangesChecked++
        let stockLine = start.line
        if (node.kind !== 'heading') {
            const begin = document.getText().lastIndexOf(`\\begin{${node.command}}`, node.range.start.offset)
            assert.ok(begin >= 0)
            stockLine = document.positionAt(begin).line
        }
        const candidate = symbols.find(symbol => !used.has(symbol) && fileUri(symbol.location.uri.fsPath) === node.uri
            && symbol.location.range.start.line === stockLine)
        assert.ok(candidate, `Missing stock source target: ${node.uri}:${stockLine + 1}`)
        used.add(candidate)
        const expected = stockLabel(node)
        if (candidate.name === expected) result.matchingLabels++
        else if (corpus === 'synthetic' && basename(fileURLToPath(node.uri)) === 'appendix.tex'
            && candidate.name === expected.replace(/^(Table |Figure )?A/, (_, prefix: string | undefined) => `${prefix ?? ''}7`)) {
            result.appendixCorrections++
        } else {
            assert.fail(`Unclassified stock difference: ${JSON.stringify({ expected, actual: candidate.name, uri: node.uri })}`)
        }
        if (stockLine !== start.line) result.captionTargetCorrections++
    }
    if (corpus === 'USCthesis') {
        assert.ok(outline.flat.some(node => node.title === 'A Long Proof' && node.number === '3.1'))
        assert.ok(!outline.flat.some(node => node.command === 'prefacesection'))
        result.unsupported = [
            'Macro-generated prefacesection, contents/list pages, and bibliography do not create nodes without a configured alias or macro expansion.',
            'Manual thesection/thesubsection redefinitions are not executed: appendix sections retain the inherited source numbers 3.1, 3.1.1, 3.1.2.',
        ]
    }
    return { result, outline }
}

export async function run(): Promise<void> {
    if (!vscode.workspace.isTrusted) {
        console.log('HOST_AWAITING_WORKSPACE_TRUST')
        const { promise, resolve } = Promise.withResolvers<void>()
        const subscription = vscode.workspace.onDidGrantWorkspaceTrust(() => { subscription.dispose(); resolve() })
        await promise
    }
    const synthetic = process.env.LATEX_TOC_SYNTHETIC!
    const usc = process.env.LATEX_TOC_USC!
    const first = await compare('synthetic', synthetic)
    assert.equal(first.result.headings, 54)
    assert.equal(first.result.floats, 12)
    assert.equal(first.result.appendixCorrections, 6)
    const second = await compare('USCthesis', usc)
    assert.equal(second.result.headings, 9)
    assert.equal(second.result.floats, 1)

    const float = first.outline.flat.find(node => node.kind === 'figure')!
    const selection = new vscode.Range(float.range.start.line, float.range.start.character, float.range.end.line, float.range.end.character)
    const editor = await vscode.window.showTextDocument(vscode.Uri.parse(float.uri), { preview: false, selection })
    assert.equal(fileUri(editor.document.uri.fsPath), float.uri)
    assert.equal(editor.selection.start.line, float.range.start.line)
    assert.ok(editor.document.getText(editor.selection).startsWith('\\caption'))
    const captionMatch = findContaining(first.outline, float.uri, editor.document.offsetAt(editor.selection.start) + 1)
    assert.equal(captionMatch.kind, 'match')
    if (captionMatch.kind === 'match') assert.equal(captionMatch.node.id, float.id)
    const heading = first.outline.flat.find(node => node.kind === 'heading' && node.uri === float.uri)!
    const proseMatch = findContaining(first.outline, float.uri, heading.range.end.offset + 1)
    assert.equal(proseMatch.kind, 'match')
    if (proseMatch.kind === 'match') assert.equal(proseMatch.node.id, heading.id)

    const originalDisk = await readFile(editor.document.uri.fsPath, 'utf8')
    const originalBuffer = editor.document.getText()
    assert.equal(originalBuffer, originalDisk)
    let dirtyVersion: number
    try {
        await editor.edit(edit => edit.insert(new vscode.Position(0, 0), '\\section{Unsaved buffer probe}\n'))
        assert.ok(editor.document.isDirty)
        dirtyVersion = editor.document.version
        const dirty = await inspect(first.outline.root)
        assert.equal(dirty.flat.filter(node => node.title === 'Unsaved buffer probe').length, 1)
        assert.equal(dirty.files.find(file => file.uri === float.uri)?.version, dirtyVersion)
        assert.equal(dirty.flat.length, first.outline.flat.length + 1)
        assert.equal(await readFile(editor.document.uri.fsPath, 'utf8'), originalDisk)
    } finally {
        await vscode.window.showTextDocument(editor.document)
        await vscode.commands.executeCommand('workbench.action.files.revert')
    }
    assert.equal(editor.document.getText(), originalBuffer)
    const restored = await inspect(first.outline.root)
    assert.deepEqual(restored.flat.map(node => node.id), first.outline.flat.map(node => node.id))

    const report = {
        vscode: vscode.version,
        corpora: [first.result, second.result],
        hostChecks: { exactCaptionNavigation: true, captionContainment: true, proseContainment: true,
            unsavedBufferVersion: dirtyVersion!, diskUnchanged: true, explicitRootRetainedAcrossEditorSwitches: true },
    }
    await writeFile(process.env.LATEX_TOC_REPORT!, JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(report, null, 2))
    const document = await vscode.workspace.openTextDocument({ content: JSON.stringify(report, null, 2), language: 'json' })
    await vscode.window.showTextDocument(document, { preview: false })
    console.log('HOST_SMOKE_READY')
    if (process.env.LATEX_TOC_HOLD === '1') {
        await vscode.window.showInformationMessage('Backend experiment passed. Inspect the report, then finish the isolated run.', { modal: false }, 'Finish')
    }
}
