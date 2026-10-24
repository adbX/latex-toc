import * as vscode from 'vscode'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fileUri, sourceReader } from '../files.js'
import { defaultAppearance, parseSectionCommands, type AppearanceState } from '../appearance.js'
import type { Outline, OutlineConfig, OutlineNode, ReadSource, SourceSnapshot } from '../model.js'
import { findContaining } from '../project.js'
import { resolveRoot, type RootChoice } from '../roots.js'
import { OutlineSession } from '../session.js'
import { parseViewMessage, type HostState } from './messages.js'
import { AppearanceManager } from './appearance.js'

interface Project {
    key: string
    scope: string
    root: string
    session: OutlineSession
    config: OutlineConfig
    appearance: AppearanceState
    outline?: Outline
    version: number
    expanded: Set<string>
    currentNodeId?: string
    focusedNodeId?: string
    contentMode: 'headings' | 'floats'
    chapterOnly: boolean
    scrollTop: number
}

interface Navigation {
    project: Project
    node: OutlineNode
    version: number
    range: vscode.Range
    opening: boolean
}

const choicesKey = 'projectRootChoices'
const uriOf = (uri: vscode.Uri) => fileUri(uri.fsPath)
const member = (outline: Outline | undefined, uri: string) => outline?.root === uri || Boolean(outline?.includes.some(item => item.to === uri))
const isLatex = (editor: vscode.TextEditor | undefined): editor is vscode.TextEditor => Boolean(editor && editor.document.uri.scheme === 'file'
    && (editor.document.languageId === 'latex' || editor.document.languageId === 'tex' || /\.tex$/i.test(editor.document.fileName)))

export class ProjectController implements vscode.Disposable {
    private readonly subscriptions: vscode.Disposable[] = []
    private readonly changes = new vscode.EventEmitter<HostState>()
    readonly onDidChange = this.changes.event
    private readonly projects = new Map<string, Project>()
    private readonly disk = new Map<string, SourceSnapshot | undefined>()
    private readonly watchers = new Map<string, vscode.FileSystemWatcher>()
    private current?: Project
    private navigation?: Navigation
    private timer?: NodeJS.Timeout
    private processing?: AbortController
    private generation = 0
    private diskRevision = 0
    private modelVersion = 0
    private status: HostState['status'] = 'empty'
    private message = 'Open a local LaTeX document or choose a project root.'
    private notice?: string
    private candidates: readonly string[] = []
    private prompted = ''
    private disposed = false
    private follow = vscode.workspace.getConfiguration('latexToc').get<boolean>('followEditor', true)
    private choices: RootChoice[]
    private readonly appearanceManager: AppearanceManager
    private idleAppearance = defaultAppearance

    constructor(private readonly context: vscode.ExtensionContext) {
        this.appearanceManager = new AppearanceManager(context, () => this.current ? vscode.Uri.parse(this.current.root) : undefined,
            () => this.appearancesChanged())
        this.idleAppearance = this.appearanceManager.read()
        const stored: unknown = context.globalState.get(choicesKey, [])
        this.choices = Array.isArray(stored) ? stored.filter((item): item is RootChoice => Boolean(item && typeof item === 'object'
            && typeof item.root === 'string' && typeof item.scope === 'string' && item.root.startsWith('file:') && item.scope.startsWith('file:'))) : []
        this.subscriptions.push(this.changes,
            vscode.window.onDidChangeActiveTextEditor(editor => this.activeChanged(editor)),
            vscode.window.onDidChangeTextEditorSelection(event => this.selectionChanged(event)),
            vscode.workspace.onDidChangeTextDocument(event => {
                if (event.contentChanges.length && event.document.uri.scheme === 'file') this.sourceChanged(uriOf(event.document.uri))
            }),
            vscode.workspace.onDidOpenTextDocument(document => {
                if (document.uri.scheme === 'file' && this.disk.get(uriOf(document.uri))?.text !== document.getText()) this.sourceChanged(uriOf(document.uri))
            }),
            vscode.workspace.onDidCloseTextDocument(document => {
                if (document.uri.scheme === 'file') this.sourceChanged(uriOf(document.uri))
            }),
            vscode.workspace.onDidChangeWorkspaceFolders(() => { this.watchCandidates(); this.schedule(true) }),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration('latexToc.followEditor')) {
                    this.follow = vscode.workspace.getConfiguration('latexToc').get<boolean>('followEditor', true)
                    this.navigation = undefined
                    // Cancel in-flight project following when the user pins the current context.
                    this.generation++
                    this.processing?.abort()
                    clearTimeout(this.timer)
                    if (this.follow) this.schedule(true)
                    else { this.status = this.current?.outline ? 'ready' : 'empty'; this.message = 'Editor following is off; project and selection are pinned.'; this.emit() }
                }
                if (['indentPx', 'palette', 'colors', 'visibleRanks'].some(key => event.affectsConfiguration(`latexToc.${key}`))) {
                    this.appearancesChanged()
                }
                const resource = this.current ? vscode.Uri.parse(this.current.root) : undefined
                if (['texDirs', 'sectionCommands'].some(key => event.affectsConfiguration(`latexToc.${key}`, resource))) this.schedule(false)
            }),
        )
        this.watchCandidates()
    }

    start(): void {
        if (vscode.env.remoteName || vscode.env.uiKind !== vscode.UIKind.Desktop || vscode.workspace.workspaceFolders?.some(folder => folder.uri.scheme !== 'file')) {
            this.status = 'unsupported'
            this.message = 'LaTeX TOC currently supports local desktop files only.'
            this.emit()
        } else if (!vscode.workspace.isTrusted) {
            this.status = 'unsupported'
            this.message = 'LaTeX TOC is disabled in Restricted Mode.'
            this.emit()
        } else this.schedule(true)
    }

    snapshot(): HostState {
        const project = this.current
        const outline = project?.outline
        return {
            type: 'state', status: this.status, message: this.message, notice: this.notice,
            project: project ? { key: project.key, root: project.root, scope: project.scope, texDirs: project.config.texDirs ?? [] } : undefined,
            version: project?.version ?? 0,
            nodes: outline?.flat.map(({ id, parentId, title, number, kind, rank, uri }) =>
                ({ id, parentId, title, number, kind, rank, source: basename(fileURLToPath(uri)) })) ?? [],
            currentNodeId: project?.currentNodeId, focusedNodeId: project?.focusedNodeId,
            contentMode: project?.contentMode ?? 'headings', chapterOnly: project?.chapterOnly ?? false,
            expanded: [...project?.expanded ?? []], scrollTop: project?.scrollTop ?? 0,
            followEditor: this.follow,
            appearance: project?.appearance ?? this.idleAppearance,
            diagnostics: outline?.diagnostics.map(item => `${item.code}: ${basename(fileURLToPath(item.uri))}${item.range ? `:${item.range.start.line + 1}` : ''}: ${item.message}`) ?? [],
        }
    }

    private emit(): void { if (!this.disposed) this.changes.fire(this.snapshot()) }

    private appearancesChanged(): void {
        this.idleAppearance = this.appearanceManager.read(undefined, this.idleAppearance)
        for (const project of this.projects.values()) {
            project.appearance = this.appearanceManager.read(vscode.Uri.parse(project.root), project.appearance)
        }
        this.emit()
    }

    private project(root: string): Project {
        root = fileUri(fileURLToPath(root))
        const scope = vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(root))?.uri
        const scopeUri = scope ? uriOf(scope) : fileUri(dirname(fileURLToPath(root)))
        const key = JSON.stringify([scopeUri, root])
        let project = this.projects.get(key)
        if (!project) {
            project = { key, scope: scopeUri, root, session: new OutlineSession(), config: {}, version: 0,
                expanded: new Set(), scrollTop: 0, contentMode: 'headings', chapterOnly: false, appearance: defaultAppearance }
            this.projects.set(key, project)
        }
        const resource = vscode.Uri.parse(root)
        const config = vscode.workspace.getConfiguration('latexToc', resource)
        project.appearance = this.appearanceManager.read(resource, project.appearance)
        const values = config.get<unknown>('texDirs', [])
        if (!Array.isArray(values) || !values.every(value => typeof value === 'string')) throw new Error('latexToc.texDirs must be an array of directory paths.')
        project.config = {
            texDirs: values.map(value => resolve(dirname(fileURLToPath(root)), value)),
            sectionCommands: parseSectionCommands(config.get('sectionCommands')),
        }
        project.session.configure(project.config)
        return project
    }

    private reader(signal: AbortSignal): ReadSource {
        const buffers = new Map(vscode.workspace.textDocuments.filter(document => document.uri.scheme === 'file')
            .map(document => { const uri = uriOf(document.uri); return [uri, { uri, text: document.getText(), version: document.version }] as const }))
        const readDisk = sourceReader([], signal)
        return async uri => {
            signal.throwIfAborted()
            if (buffers.has(uri)) return buffers.get(uri)
            if (this.disk.has(uri)) return this.disk.get(uri)
            const revision = this.diskRevision
            const source = await readDisk(uri)
            signal.throwIfAborted()
            if (revision === this.diskRevision) this.disk.set(uri, source)
            return source
        }
    }

    private beginProcessing(): AbortSignal {
        this.processing?.abort()
        this.processing = new AbortController()
        return this.processing.signal
    }

    private schedule(discover: boolean): void {
        if (this.disposed || this.status === 'unsupported') return
        const generation = ++this.generation
        const signal = this.beginProcessing()
        this.navigation = undefined
        clearTimeout(this.timer)
        this.status = 'loading'
        this.notice = undefined
        this.message = discover ? 'Resolving the active LaTeX project…' : 'Updating the project from source…'
        this.emit()
        this.timer = setTimeout(() => {
            this.timer = undefined
            void this.refresh(generation, discover, signal).catch(error => {
                if (generation !== this.generation || this.disposed) return
                this.status = 'error'
                this.notice = undefined
                this.message = error instanceof Error ? error.message : String(error)
                this.emit()
            })
        }, 100)
    }

    private async refresh(generation: number, discover: boolean, signal: AbortSignal): Promise<void> {
        signal.throwIfAborted()
        const read = this.reader(signal)
        const built = new Map<string, Outline>()
        const build = async (root: string) => {
            const project = this.project(root)
            const outline = await project.session.build(root, read, signal)
            built.set(root, outline)
            return outline
        }
        let project = this.current
        const editor = vscode.window.activeTextEditor
        if ((discover && this.follow) || !project) {
            if (!isLatex(editor)) {
                this.status = project?.outline ? 'ready' : 'empty'
                this.message = project ? 'Retaining the current project for a non-LaTeX tab.' : 'Open a local LaTeX document or choose a project root.'
                this.emit()
                return
            }
            const active = uriOf(editor.document.uri)
            const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri)
            for (const [key, watcher] of this.watchers) if (key.startsWith('local:')) { watcher.dispose(); this.watchers.delete(key) }
            if (!folder) {
                const directory = dirname(editor.document.fileName)
                this.watch(`local:${directory}`, new vscode.RelativePattern(vscode.Uri.file(directory), '*.tex'), true)
            }
            const result = await resolveRoot({ active, current: project?.outline, choices: this.choices, signal,
                workspaceFolder: folder ? uriOf(folder.uri) : undefined,
                openUris: vscode.workspace.textDocuments.filter(document => document.uri.scheme === 'file').map(document => uriOf(document.uri)), read, build })
            if (generation !== this.generation || this.disposed) return
            if (result.kind !== 'resolved') {
                this.current = undefined
                this.candidates = result.candidates ?? []
                this.status = 'unresolved'
                this.message = result.kind === 'ambiguous' ? 'Several roots include this document. Choose the intended project root.' : result.message
                this.emit()
                const promptKey = JSON.stringify([active, this.candidates])
                if (result.kind === 'ambiguous' && this.prompted !== promptKey) {
                    this.prompted = promptKey
                    await this.pickRoot(result.candidates, generation)
                }
                return
            }
            project = this.project(result.root)
        }
        const outline = built.get(project.root) ?? await build(project.root)
        if (generation !== this.generation || this.disposed) return
        this.publish(project, outline)
        if (!discover && this.follow && isLatex(vscode.window.activeTextEditor) && !member(outline, uriOf(vscode.window.activeTextEditor.document.uri))) {
            this.schedule(true)
            return
        }
        if (this.follow) this.followCaret(vscode.window.activeTextEditor)
        this.emit()
    }

    private publish(project: Project, outline: Outline): void {
        const previous = project.outline
        const ids = new Set(outline.flat.map(node => node.id))
        const priorIds = new Set(previous?.flat.map(node => node.id))
        project.expanded = new Set([...project.expanded].filter(id => ids.has(id)))
        for (const node of outline.flat) if (node.children.length && !priorIds.has(node.id)) project.expanded.add(node.id)
        if (project.currentNodeId && !ids.has(project.currentNodeId)) project.currentNodeId = undefined
        if (project.focusedNodeId && !ids.has(project.focusedNodeId)) project.focusedNodeId = undefined
        project.outline = outline
        project.version = ++this.modelVersion
        this.current = project
        this.status = 'ready'
        this.notice = undefined
        this.message = outline.diagnostics.length ? 'Project loaded with source diagnostics.' : this.follow ? 'Following the editor. Full project outline.' : 'Project and selection pinned. Full project outline.'
        this.candidates = []
        this.watchDependencies(outline)
    }

    private activeChanged(editor: vscode.TextEditor | undefined): void {
        if (!this.follow || !isLatex(editor) || this.status === 'unsupported') return
        const uri = uriOf(editor.document.uri)
        if (this.navigation && uri === this.navigation.node.uri) return
        this.navigation = undefined
        if (this.status === 'ready' && member(this.current?.outline, uri)) { this.followCaret(editor); this.emit() }
        else this.schedule(true)
    }

    private selectionChanged(event: vscode.TextEditorSelectionChangeEvent): void {
        if (!this.follow || event.textEditor !== vscode.window.activeTextEditor || !isLatex(event.textEditor)) return
        const navigation = this.navigation
        if (navigation && navigation.project === this.current && navigation.version === this.current.version
            && uriOf(event.textEditor.document.uri) === navigation.node.uri) {
            if (event.selections.length === 1 && event.selections[0].isEqual(navigation.range)) return
            // Opening an editor can restore its old selection before our exact target is applied.
            if (navigation.opening && event.kind !== vscode.TextEditorSelectionChangeKind.Keyboard && event.kind !== vscode.TextEditorSelectionChangeKind.Mouse) return
        }
        this.navigation = undefined
        if (this.status !== 'ready') return
        this.followCaret(event.textEditor)
        this.emit()
    }

    private followCaret(editor: vscode.TextEditor | undefined): void {
        const project = this.current
        if (!this.follow || !project?.outline || !isLatex(editor)) return
        const uri = uriOf(editor.document.uri)
        if (!member(project.outline, uri)) {
            project.currentNodeId = undefined
            this.message = 'The active source is not in the selected root’s supported include graph.'
            this.notice = this.message
            return
        }
        const currentNode = project.outline.flat.find(node => node.id === project.currentNodeId)
        const occurrence = currentNode?.uri === uri ? currentNode.occurrence : undefined
        const result = findContaining(project.outline, uri, editor.document.offsetAt(editor.selection.active), occurrence)
        project.currentNodeId = result.kind === 'match' ? result.node.id : undefined
        this.notice = undefined
        if (result.kind === 'ambiguous') {
            this.message = 'This source is included more than once. Select an outline occurrence to disambiguate.'
            this.notice = this.message
        }
        if (result.kind === 'match') this.revealBranch(project, result.node)
    }

    private revealBranch(project: Project, node: OutlineNode): void {
        let parent = node.parentId
        const byId = new Map(project.outline?.flat.map(item => [item.id, item]))
        while (parent) { project.expanded.add(parent); parent = byId.get(parent)?.parentId }
    }

    private sourceChanged(uri: string): void {
        this.disk.delete(uri)
        this.diskRevision++
        const relevant = this.current?.outline?.dependencies.includes(uri)
        if (relevant || this.status === 'loading') this.schedule(false)
        else if (this.follow && this.status !== 'ready' && /\.tex$/i.test(fileURLToPath(uri))) this.schedule(true)
    }

    private watch(key: string, pattern: vscode.RelativePattern, candidate: boolean): void {
        if (this.watchers.has(key)) return
        const watcher = vscode.workspace.createFileSystemWatcher(pattern)
        const changed = (uri: vscode.Uri) => {
            const normalized = uriOf(uri)
            this.disk.delete(normalized)
            this.diskRevision++
            if (this.current?.outline?.dependencies.includes(normalized) || this.status === 'loading') this.schedule(false)
            else if (candidate && this.follow && this.status === 'unresolved') this.schedule(true)
        }
        watcher.onDidCreate(changed)
        watcher.onDidChange(changed)
        watcher.onDidDelete(changed)
        this.watchers.set(key, watcher)
    }

    private watchCandidates(): void {
        for (const [key, watcher] of this.watchers) if (key.startsWith('workspace:')) { watcher.dispose(); this.watchers.delete(key) }
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            if (folder.uri.scheme === 'file') this.watch(`workspace:${uriOf(folder.uri)}`, new vscode.RelativePattern(folder, '**/*.tex'), true)
        }
    }

    private watchDependencies(outline: Outline): void {
        const directories = new Set(outline.dependencies.map(uri => dirname(fileURLToPath(uri))))
        for (const [key, watcher] of this.watchers) if (key.startsWith('source:') && !directories.has(key.slice(7))) { watcher.dispose(); this.watchers.delete(key) }
        for (const directory of directories) this.watch(`source:${directory}`, new vscode.RelativePattern(vscode.Uri.file(directory), '*'), true)
    }

    async receive(value: unknown): Promise<boolean> {
        const message = parseViewMessage(value)
        if (!message) { this.notice = this.message = 'Rejected an invalid sidebar message.'; this.emit(); return false }
        if (message.type === 'ready') { this.emit(); return true }
        if (message.type === 'chooseRoot') { await this.chooseRoot(); return true }
        if (message.type === 'toggleFollow') { await this.toggleFollow(); return true }
        if (message.type === 'selectPalette') { await this.selectPalette(); return true }
        const project = this.current
        if (!project?.outline || this.status !== 'ready' || message.version !== project.version) {
            this.notice = this.message = 'The outline changed. Select an item from the current model.'; this.emit(); return false
        }
        if (message.type === 'scroll') { project.scrollTop = message.top; return true }
        if (message.type === 'view') {
            project.contentMode = message.contentMode
            project.chapterOnly = message.chapterOnly
            this.notice = undefined
            this.emit()
            return true
        }
        if (message.type === 'bulkExpand') {
            if (project.contentMode === 'floats') return false
            const byId = new Map(project.outline.flat.map(node => [node.id, node]))
            let chapter = project.chapterOnly && project.currentNodeId ? byId.get(project.currentNodeId) : undefined
            while (chapter && (chapter.kind !== 'heading' || chapter.rank !== 'chapter')) {
                chapter = chapter.parentId ? byId.get(chapter.parentId) : undefined
            }
            // No semantic chapter (including front matter) means whole-document scope.
            const visit = (node: OutlineNode): void => {
                if (node.children.length) {
                    if (message.expanded) project.expanded.add(node.id)
                    else project.expanded.delete(node.id)
                    for (const child of node.children) visit(child)
                }
            }
            if (chapter) visit(chapter)
            else for (const node of project.outline.flat) {
                if (!node.children.length) continue
                if (message.expanded) project.expanded.add(node.id)
                else project.expanded.delete(node.id)
            }
            this.notice = undefined
            this.emit()
            return true
        }
        const node = project.outline.flat.find(item => item.id === message.id)
        if (!node) { this.notice = this.message = 'That outline item no longer exists.'; this.emit(); return false }
        if (message.type === 'focus') {
            project.focusedNodeId = node.id
            this.notice = undefined
            this.emit()
            return true
        }
        if (message.type === 'expand') {
            if (message.expanded) project.expanded.add(node.id)
            else project.expanded.delete(node.id)
            this.notice = undefined
            this.emit()
            return true
        }
        const range = new vscode.Range(node.range.start.line, node.range.start.character, node.range.end.line, node.range.end.character)
        const navigation: Navigation = { project, node, version: project.version, range, opening: true }
        this.navigation = navigation
        try {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(node.uri))
            if (this.navigation !== navigation || this.current !== project || project.version !== message.version || this.status !== 'ready') return false
            const sourceVersion = project.outline.files.find(file => file.uri === node.uri)?.version
            // Opening a disk source does not change its text, but may race an external edit.
            const diskSource = this.disk.get(node.uri)
            if ((typeof sourceVersion === 'number' && sourceVersion !== document.version)
                || (typeof sourceVersion === 'string' && diskSource?.text !== document.getText())) {
                this.sourceChanged(node.uri)
                return false
            }
            const editor = await vscode.window.showTextDocument(document, { preview: false, selection: range })
            if (this.navigation !== navigation || project.version !== message.version) return false
            editor.selection = new vscode.Selection(range.start, range.end)
            editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
            project.currentNodeId = node.id
            this.revealBranch(project, node)
            navigation.opening = false
            this.message = `Selected ${node.kind === 'heading' ? node.rank : node.kind}: ${node.title}`
            this.notice = undefined
            this.emit()
            return true
        } catch (error) {
            this.navigation = undefined
            this.message = `Cannot navigate to this source: ${error instanceof Error ? error.message : String(error)}`
            this.notice = this.message
            this.emit()
            return false
        }
    }

    async selectRoot(root: vscode.Uri): Promise<void> {
        if (root.scheme !== 'file' || this.status === 'unsupported') return
        const generation = ++this.generation
        const signal = this.beginProcessing()
        clearTimeout(this.timer)
        this.navigation = undefined
        this.status = 'loading'
        this.notice = undefined
        this.message = 'Loading the selected root…'
        this.emit()
        try {
            const project = this.project(uriOf(root))
            const outline = await project.session.build(project.root, this.reader(signal), signal)
            if (generation !== this.generation || this.disposed) return
            this.publish(project, outline)
            const scopes = new Set([project.scope])
            for (const file of outline.files) {
                const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(file.uri))
                if (folder) scopes.add(uriOf(folder.uri))
            }
            this.choices = [...this.choices.filter(choice => choice.root !== project.root),
                ...[...scopes].map(scope => ({ scope, root: project.root }))]
            await this.context.globalState.update(choicesKey, this.choices)
            if (this.follow) this.followCaret(vscode.window.activeTextEditor)
            this.emit()
        } catch (error) {
            if (generation !== this.generation) return
            this.status = 'error'
            this.notice = undefined
            this.message = error instanceof Error ? error.message : String(error)
            this.emit()
        }
    }

    private async pickRoot(candidates: readonly string[], generation: number): Promise<void> {
        const selected = await vscode.window.showQuickPick(candidates.map(root => ({ label: basename(fileURLToPath(root)), description: fileURLToPath(root), root })),
            { title: 'Choose the LaTeX project root', placeHolder: 'Several roots include the active document. No root has been selected automatically.' })
        if (selected && generation === this.generation) await this.selectRoot(vscode.Uri.parse(selected.root))
    }

    async chooseRoot(): Promise<void> {
        if (this.status === 'unsupported') return
        const roots = [...new Set([...this.candidates, ...this.choices.map(choice => choice.root), ...this.current ? [this.current.root] : []])]
        const items = [...roots.map(root => ({ label: basename(fileURLToPath(root)), description: fileURLToPath(root), root })),
            { label: 'Browse for a root…', description: 'Choose a local .tex file', root: '' }]
        const selected = await vscode.window.showQuickPick(items, { title: 'Choose the LaTeX project root' })
        if (!selected) return
        if (selected.root) await this.selectRoot(vscode.Uri.parse(selected.root))
        else {
            const files = await vscode.window.showOpenDialog({ title: 'Choose the LaTeX project root', filters: { LaTeX: ['tex'] }, canSelectMany: false })
            if (files?.[0]) await this.selectRoot(files[0])
        }
    }

    async toggleFollow(): Promise<void> {
        const targets = [{ label: 'User', target: vscode.ConfigurationTarget.Global }]
        if (vscode.workspace.workspaceFolders?.length || vscode.workspace.workspaceFile) targets.push({ label: 'Workspace', target: vscode.ConfigurationTarget.Workspace })
        const selected = await vscode.window.showQuickPick(targets, { title: `${this.follow ? 'Disable' : 'Enable'} editor following`, placeHolder: 'Choose where to save latexToc.followEditor' })
        if (selected) await vscode.workspace.getConfiguration('latexToc').update('followEditor', !this.follow, selected.target)
    }

    async selectPalette(): Promise<void> {
        if (this.status !== 'unsupported') await this.appearanceManager.selectPalette()
    }

    async importPalette(): Promise<void> {
        if (this.status !== 'unsupported') await this.appearanceManager.importPalette()
    }

    async resetColorOverrides(): Promise<void> {
        if (this.status !== 'unsupported') await this.appearanceManager.resetColorOverrides()
    }

    dispose(): void {
        this.disposed = true
        this.generation++
        this.processing?.abort()
        clearTimeout(this.timer)
        for (const watcher of this.watchers.values()) watcher.dispose()
        for (const item of this.subscriptions) item.dispose()
    }
}
