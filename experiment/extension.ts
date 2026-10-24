import * as vscode from 'vscode'
import { sourceReader } from '../src/files.js'
import { buildOutline } from '../src/project.js'

export function activate(context: vscode.ExtensionContext): void {
    const output = vscode.window.createOutputChannel('LaTeX TOC Backend Experiment')
    context.subscriptions.push(output, vscode.commands.registerCommand('latexTocExperiment.inspect', async (root?: string) => {
        root ??= vscode.window.activeTextEditor?.document.uri.toString()
        if (root === undefined || vscode.Uri.parse(root).scheme !== 'file') {
            throw new Error('Open a local root document or pass its file URI to the experiment command.')
        }
        const buffers = vscode.workspace.textDocuments.filter(document => document.uri.scheme === 'file')
            .map(document => ({ uri: document.uri.toString(), text: document.getText(), version: document.version }))
        const outline = await buildOutline(root, sourceReader(buffers))
        output.clear()
        output.appendLine(`Root: ${root}`)
        output.appendLine(`${outline.files.length} sources; ${outline.flat.filter(node => node.kind === 'heading').length} headings; ${outline.flat.filter(node => node.kind !== 'heading').length} floats`)
        for (const node of outline.flat) {
            output.appendLine(`${node.number ?? '*'} ${node.title} -> ${vscode.Uri.parse(node.uri).fsPath}:${node.range.start.line + 1}:${node.range.start.character + 1}`)
        }
        for (const diagnostic of outline.diagnostics) {
            output.appendLine(`${diagnostic.code}: ${diagnostic.uri}: ${diagnostic.message}`)
        }
        output.show(true)
        return outline
    }))
}
