import { writeFile } from 'node:fs/promises'
import * as vscode from 'vscode'
import { run } from '../host-smoke.js'

export function activate(): void {
    const resultPath = process.env.LATEX_TOC_RESULT
    if (!resultPath) throw new Error('Run this development-only driver through scripts/launch.mjs --smoke.')
    void (async () => {
        try {
            await run()
            await writeFile(resultPath, JSON.stringify({ passed: true }) + '\n')
        } catch (error) {
            console.error(error)
            await writeFile(resultPath, JSON.stringify({ passed: false, error: error instanceof Error ? error.stack : String(error) }) + '\n')
        }
        await vscode.commands.executeCommand('workbench.action.quit')
    })()
}
