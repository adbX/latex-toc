import * as vscode from 'vscode'
import { ranks, type Rank } from '../model.js'
import {
    builtinPalette, defaultAppearance, isBuiltInName, paletteLimitBytes, paletteName, parsePalette,
    parsePaletteBytes, putPalette, resolveAppearance, type AppearanceState, type Palette,
} from '../appearance.js'

const libraryKey = 'paletteLibrary'
const themes = ['light', 'dark'] as const
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
type Target = { label: string; target: vscode.ConfigurationTarget }

/** Palette values are profile-local; appearance settings remain VS Code resource settings. */
export class AppearanceManager {
    private library: Palette[] = []
    private libraryProblem?: string

    constructor(private readonly context: vscode.ExtensionContext, private readonly root: () => vscode.Uri | undefined,
        private readonly changed: () => void) {
        try {
            const stored: unknown = context.globalState.get(libraryKey, [])
            if (!Array.isArray(stored)) throw new Error('Expected an array of saved palettes.')
            for (const value of stored) this.library = putPalette(this.library, parsePalette(value))
        } catch (error) {
            this.libraryProblem = `Cannot read the saved palette library: ${errorText(error)}`
        }
    }

    read(root?: vscode.Uri, previous = defaultAppearance): AppearanceState {
        const config = vscode.workspace.getConfiguration('latexToc', root)
        const overrides = (theme: typeof themes[number]) => Object.fromEntries(ranks.flatMap(rank => {
            const value = config.get<unknown>(`colors.${theme}.${rank}`)
            return value === undefined || value === null ? [] : [[rank, value]]
        }))
        try {
            const appearance = resolveAppearance({
                indentPx: config.get('indentPx'), palette: config.get('palette'), visibleRanks: config.get('visibleRanks'),
                lightOverrides: overrides('light'), darkOverrides: overrides('dark'),
            }, this.library)
            return this.libraryProblem ? { ...appearance, notice: [this.libraryProblem, appearance.notice].filter(Boolean).join(' ') } : appearance
        } catch (error) {
            return { ...previous, notice: `Invalid LaTeX TOC appearance setting: ${errorText(error)} Keeping the last valid appearance.` }
        }
    }

    private targets(root?: vscode.Uri): Target[] {
        const targets: Target[] = [{ label: 'User', target: vscode.ConfigurationTarget.Global }]
        if (vscode.workspace.workspaceFolders?.length || vscode.workspace.workspaceFile) {
            targets.push({ label: 'Workspace', target: vscode.ConfigurationTarget.Workspace })
        }
        const folder = root && vscode.workspace.getWorkspaceFolder(root)
        if (folder) targets.push({ label: `Workspace Folder: ${folder.name}`, target: vscode.ConfigurationTarget.WorkspaceFolder })
        return targets
    }

    private target(root: vscode.Uri | undefined, title: string): Thenable<Target | undefined> {
        return vscode.window.showQuickPick(this.targets(root), { title,
            placeHolder: 'Choose an explicit settings target. Unavailable workspace/folder targets are omitted.' })
    }

    private checkTarget(root: vscode.Uri | undefined, target: Target): void {
        if (!this.targets(root).some(item => item.target === target.target)) throw new Error('The selected settings target is no longer available.')
    }

    async selectPalette(): Promise<void> {
        const root = this.root()
        try {
            const selected = await vscode.window.showQuickPick([builtinPalette, ...this.library].map(palette => ({
                label: palette.name, palette,
                description: palette === builtinPalette ? 'Built-in' : palette.dark ? 'Imported · light and dark' : 'Imported · built-in dark fallback',
            })), { title: 'Select LaTeX TOC palette', placeHolder: 'Individual rank-color overrides are preserved.' })
            if (!selected) return
            const target = await this.target(root, `Save palette: ${selected.palette.name}`)
            if (!target) return
            this.checkTarget(root, target)
            await vscode.workspace.getConfiguration('latexToc', root).update('palette', selected.palette.name, target.target)
            this.changed()
            this.reportSelection(root, selected.palette.name, target)
        } catch (error) { void vscode.window.showErrorMessage(`Cannot select palette: ${errorText(error)}`) }
    }

    private reportSelection(root: vscode.Uri | undefined, name: string, target: Target): void {
        const active = vscode.workspace.getConfiguration('latexToc', root).get<string>('palette', builtinPalette.name)
        if (active !== name) void vscode.window.showInformationMessage(`Saved “${name}” at ${target.label}. Higher-precedence settings still select “${active}” for this project.`)
    }

    async importPalette(): Promise<void> {
        const root = this.root()
        try {
            if (this.libraryProblem) throw new Error(this.libraryProblem)
            const files = await vscode.window.showOpenDialog({ title: 'Import LaTeX TOC palette', filters: { 'LaTeX TOC palette JSON': ['json'] }, canSelectMany: false })
            const file = files?.[0]
            if (!file) return
            if (file.scheme !== 'file') throw new Error('Choose a local JSON file.')
            const stat = await vscode.workspace.fs.stat(file)
            if (stat.size > paletteLimitBytes) throw new Error('Palette files must be no larger than 64 KiB.')
            let palette = parsePaletteBytes(await vscode.workspace.fs.readFile(file))
            let replace = false
            while (isBuiltInName(palette.name) || this.library.some(item => item.name.toLowerCase() === palette.name.toLowerCase())) {
                if (!isBuiltInName(palette.name)) {
                    const collision = await vscode.window.showQuickPick([
                        { label: 'Rename imported palette', replace: false },
                        { label: `Replace “${palette.name}”`, description: 'Replace this saved imported palette, not individual color overrides.', replace: true },
                    ], { title: 'A palette with this name already exists' })
                    if (!collision) return
                    if (collision.replace) { replace = true; break }
                }
                const name = await vscode.window.showInputBox({ title: 'Rename imported palette', value: `${palette.name}-copy`,
                    prompt: 'Built-in palette names are protected. Choose a name for the imported values.',
                    validateInput: value => {
                        try { if (isBuiltInName(paletteName(value))) return 'This name is reserved for a built-in palette.' }
                        catch (error) { return errorText(error) }
                        return undefined
                    },
                })
                if (name === undefined) return
                palette = { ...palette, name: paletteName(name) }
            }
            const action = await vscode.window.showQuickPick([
                { label: 'Import and select', select: true },
                { label: 'Import only', description: 'Save in this profile without changing the selected palette.', select: false },
            ], { title: `Import “${palette.name}”`, placeHolder: palette.dark ? 'Light and dark colors supplied.' : 'Light-only palette: dark themes will use the built-in dark colors.' })
            if (!action) return
            const target = action.select ? await this.target(root, `Save palette selection: ${palette.name}`) : undefined
            if (action.select && !target) return
            if (target) this.checkTarget(root, target)
            // Every cancellation point precedes either storage or configuration mutation.
            const previous = this.library
            const next = putPalette(previous, palette, replace)
            await this.context.globalState.update(libraryKey, next)
            this.library = next
            try {
                if (target) await vscode.workspace.getConfiguration('latexToc', root).update('palette', palette.name, target.target)
            } catch (error) {
                this.library = previous
                await this.context.globalState.update(libraryKey, previous)
                this.changed()
                throw error
            }
            this.changed()
            void vscode.window.showInformationMessage(`Imported “${palette.name}” into this profile.${palette.dark ? '' : ' Dark themes use the built-in dark palette.'}${target ? '' : ' The selected palette was not changed.'}`)
            if (target) this.reportSelection(root, palette.name, target)
        } catch (error) { void vscode.window.showErrorMessage(`Cannot import palette: ${errorText(error)}`) }
    }

    async resetColorOverrides(): Promise<void> {
        const root = this.root()
        try {
            const target = await this.target(root, 'Reset LaTeX TOC color overrides')
            if (!target) return
            this.checkTarget(root, target)
            const config = vscode.workspace.getConfiguration('latexToc', root)
            const valueKey = target.target === vscode.ConfigurationTarget.Global ? 'globalValue'
                : target.target === vscode.ConfigurationTarget.Workspace ? 'workspaceValue' : 'workspaceFolderValue'
            const items = themes.flatMap(theme => ranks.flatMap((rank: Rank) => {
                const key = `colors.${theme}.${rank}`
                const value = config.inspect<unknown>(key)?.[valueKey]
                return value === undefined ? [] : [{ label: `${theme === 'light' ? 'Light' : 'Dark'} · ${rank}`, description: String(value), key }]
            }))
            if (!items.length) { void vscode.window.showInformationMessage(`No explicit hierarchy-color overrides at ${target.label}.`); return }
            const selected = await vscode.window.showQuickPick(items, { title: `Reset overrides at ${target.label}`, canPickMany: true,
                placeHolder: 'Choose one or more overrides to remove. Palette selection and other settings are unchanged.' })
            if (!selected?.length) return
            this.checkTarget(root, target)
            for (const item of selected) await config.update(item.key, undefined, target.target)
            this.changed()
        } catch (error) { void vscode.window.showErrorMessage(`Cannot reset color overrides: ${errorText(error)}`) }
    }
}
