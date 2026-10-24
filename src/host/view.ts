import { randomBytes } from 'node:crypto'
import * as vscode from 'vscode'
import type { ProjectController } from './controller.js'

/** Each webview lifetime subscribes afresh; project view state lives only in the controller. */
export class OutlineView implements vscode.WebviewViewProvider {
    private release?: () => void
    constructor(private readonly extensionUri: vscode.Uri, private readonly controller: ProjectController) {}

    resolveWebviewView(view: vscode.WebviewView): void {
        this.release?.()
        const assets = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')
        view.webview.options = { enableScripts: true, localResourceRoots: [assets] }
        const nonce = randomBytes(18).toString('base64')
        const script = view.webview.asWebviewUri(vscode.Uri.joinPath(assets, 'index.js'))
        const style = view.webview.asWebviewUri(vscode.Uri.joinPath(assets, 'style.css'))
        const changed = this.controller.onDidChange(state => { void view.webview.postMessage(state) })
        const received = view.webview.onDidReceiveMessage((message: unknown) => { void this.controller.receive(message) })
        const visible = view.onDidChangeVisibility(() => { if (view.visible) void view.webview.postMessage(this.controller.snapshot()) })
        const release = () => {
            changed.dispose()
            received.dispose()
            visible.dispose()
            disposed.dispose()
            if (this.release === release) this.release = undefined
        }
        const disposed = view.onDidDispose(release)
        this.release = release
        view.webview.html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${view.webview.cspSource}; style-src-attr 'unsafe-inline';">
<link rel="stylesheet" href="${style}"><title>LaTeX TOC</title></head>
<body><div id="app"></div>
<script nonce="${nonce}" src="${script}"></script></body></html>`
    }
}
