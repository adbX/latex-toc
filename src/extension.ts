import * as vscode from 'vscode'
import { ProjectController } from './host/controller.js'
import { OutlineView } from './host/view.js'

export function activate(context: vscode.ExtensionContext): ProjectController | undefined {
    const controller = new ProjectController(context)
    context.subscriptions.push(controller,
        vscode.window.registerWebviewViewProvider('latexToc.outline', new OutlineView(context.extensionUri, controller)),
        vscode.commands.registerCommand('latexToc.chooseRoot', () => controller.chooseRoot()),
        vscode.commands.registerCommand('latexToc.toggleFollowEditor', () => controller.toggleFollow()),
        vscode.commands.registerCommand('latexToc.selectPalette', () => controller.selectPalette()),
        vscode.commands.registerCommand('latexToc.importPalette', () => controller.importPalette()),
        vscode.commands.registerCommand('latexToc.resetColorOverrides', () => controller.resetColorOverrides()),
    )
    controller.start()
    // Development host scenarios exercise the same validated message path as the webview.
    return context.extensionMode === vscode.ExtensionMode.Production ? undefined : controller
}
