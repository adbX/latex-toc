import assert from 'node:assert/strict'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import fs from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import * as vscode from 'vscode'
import { fileUri } from '../src/files.js'
import type { ProjectController } from '../src/host/controller.js'
import type { HostState } from '../src/host/messages.js'
import { parseViewMessage } from '../src/host/messages.js'
import { MAX_SOURCE_BYTES } from '../src/processing.js'

export async function run(): Promise<void> {
    if (!vscode.workspace.isTrusted) {
        console.log('HOST_AWAITING_WORKSPACE_TRUST')
        await new Promise<void>(resolveTrust => {
            const subscription = vscode.workspace.onDidGrantWorkspaceTrust(() => { subscription.dispose(); resolveTrust() })
        })
    }
    const directory = process.env.LATEX_TOC_FIXTURE!
    const extension = vscode.extensions.getExtension<ProjectController>('adbX.latex-toc')
    assert.ok(extension)
    const controller = await extension.activate()
    const checks: string[] = []
    assert.equal(controller.snapshot().contentMode, 'headings')
    assert.equal(controller.snapshot().chapterOnly, false)
    assert.equal(controller.snapshot().focusedNodeId, undefined, 'A fresh extension host does not restore session-only focus.')
    for (const invalid of [
        { type: 'focus', version: 1, id: '' },
        { type: 'focus', version: 1, id: 'node', preview: true },
        { type: 'view', version: 1, contentMode: 'unknown', chapterOnly: false },
        { type: 'view', version: 1, contentMode: 'headings', chapterOnly: 1 },
        { type: 'view', version: 1, contentMode: 'floats', chapterOnly: true, scrollTop: 0 },
        { type: 'bulkExpand', version: 1, expanded: 'false' },
        { type: 'bulkExpand', version: 1, expanded: false, id: 'node' },
        { type: 'bulkExpand', version: 0, expanded: false },
    ]) assert.equal(parseViewMessage(invalid), undefined)
    const wait = async (predicate: (state: HostState) => boolean, label: string) => {
        const deadline = Date.now() + 15_000
        while (Date.now() < deadline) {
            const state = controller.snapshot()
            if (predicate(state)) return state
            await delay(40)
        }
        assert.fail(`${label}: ${JSON.stringify(controller.snapshot())}`)
    }
    const ready = (root: string) => wait(state => state.status === 'ready' && state.project?.root === fileUri(root), `Ready root ${root}`)
    const open = async (path: string) => vscode.window.showTextDocument(vscode.Uri.file(path), { preview: false })
    const a = resolve(directory, 'project-a/main.tex')
    const b = resolve(directory, 'project-b/main.tex')
    const one = resolve(directory, 'project-a/chapters/one.tex')
    const two = resolve(directory, 'project-a/chapters/two.tex')
    const nested = resolve(directory, 'project-a/chapters/nested/detail.tex')
    if (process.env.LATEX_TOC_STAGE) {
        const outside = resolve(directory, 'outside/main.tex')
        const externalChild = resolve(directory, 'project-a/external-child.tex')
        if (process.env.LATEX_TOC_STAGE === 'remember') {
            await writeFile(externalChild, '\\section{Explicit external project member}\n')
            const rootEditor = await open(outside)
            await rootEditor.edit(edit => edit.replace(new vscode.Range(0, 0, rootEditor.document.lineCount, 0),
                '\\documentclass{article}\n\\section{Loose fictional document}\n\\input{nested/chapter}\n\\input{../project-a/external-child}\n'))
            await rootEditor.document.save()
            await controller.selectRoot(vscode.Uri.file(outside))
            await ready(outside)
        } else {
            await open(b)
            await ready(b)
            await open(externalChild)
            await ready(outside)
            await open(b)
            await ready(b)
            await open(resolve(directory, 'outside/nested/chapter.tex'))
            await ready(outside)
            assert.equal(controller.snapshot().nodes.filter(node => node.title === 'Explicit external project member').length, 1)
            const magic = resolve(directory, 'project-a/magic-only.tex')
            await writeFile(magic, '% !TEX root = ../outside/main.tex\n\\section{Not included by the supported graph}\n')
            await open(magic)
            const explicit = await ready(outside)
            await delay(250)
            assert.equal(controller.snapshot().version, explicit.version, 'A magic root without a graph edge must not loop through discovery.')
            assert.equal(controller.snapshot().currentNodeId, undefined)

            const mainEditor = await open(a)
            await ready(a)
            const original = mainEditor.document.getText()
            const slow = resolve(directory, 'project-a/slow.tex')
            await writeFile(slow, '\\section{Before filesystem race}\n')
            let release!: () => void
            let started = false
            const gate = new Promise<void>(resolveGate => { release = resolveGate })
            const actualOpen = fs.open
            fs.open = (async (...args: Parameters<typeof fs.open>) => {
                const handle = await actualOpen(...args)
                if (args[0] === slow && !started) {
                    const actualRead = handle.read.bind(handle)
                    handle.read = (async (...readArgs: unknown[]) => {
                        const result = await Reflect.apply(actualRead, handle, readArgs)
                        if (!started) { started = true; await gate }
                        return result
                    }) as typeof handle.read
                }
                return handle
            }) as typeof fs.open
            try {
                await mainEditor.edit(edit => edit.insert(new vscode.Position(0, 0), '\\input{slow}\n'))
                await wait(() => started, 'Delayed source read started')
                fs.open = actualOpen
                await writeFile(slow, '\\section{After filesystem race}\n')
                const latest = await wait(next => next.status === 'ready' && next.nodes.some(node => node.title === 'After filesystem race'), 'Latest filesystem source wins while the old read is pending')
                release()
                await delay(200)
                await mainEditor.edit(edit => edit.insert(new vscode.Position(0, 0), '% another source update\n'))
                await wait(next => next.status === 'ready' && next.version > latest.version, 'Subsequent source update')
                assert.ok(controller.snapshot().nodes.some(node => node.title === 'After filesystem race'), 'An obsolete read must not repopulate the disk cache.')
            } finally {
                release()
                fs.open = actualOpen
                await mainEditor.edit(edit => edit.replace(new vscode.Range(0, 0, mainEditor.document.lineCount, 0), original))
                await unlink(slow)
            }
        }
        const report = { vscode: vscode.version, stage: process.env.LATEX_TOC_STAGE,
            checks: process.env.LATEX_TOC_STAGE === 'remember' ? ['Explicit external root stored for its source workspace scopes']
                : ['A fresh host restores the chosen external root for both a workspace member and a loose nested chapter without magic comments or ancestor search',
                    'Magic roots without supported include edges stay stable and clear stale selections',
                    'Filesystem changes during pending reads cannot publish or cache obsolete source'] }
        await writeFile(process.env.LATEX_TOC_REPORT!, JSON.stringify(report, null, 2) + '\n')
        console.log(JSON.stringify(report, null, 2))
        return
    }
    await vscode.commands.executeCommand('latexToc.outline.focus')
    await wait(state => state.status === 'empty', 'No-document state')
    checks.push('No-document state is visible')
    await open(a)
    let state = await ready(a)
    assert.deepEqual(state.diagnostics, [])
    assert.ok(state.nodes.some(node => node.title === 'Supporting ledger'))
    assert.deepEqual(state.project?.texDirs, [resolve(directory, 'project-a/extras-a')])
    const stableIds = state.nodes.map(node => node.id)
    const firstVersion = state.version
    const analysis = state.nodes.find(node => node.title === 'Fictional analysis')!
    assert.ok(await controller.receive({ type: 'expand', version: state.version, id: analysis.id, expanded: false }))
    assert.equal(state.contentMode, 'headings')
    assert.equal(state.chapterOnly, false)
    assert.equal(state.focusedNodeId, undefined)
    assert.ok(state.nodes.every(node => node.source && !/[\\/]/.test(node.source)), 'Only source basenames reach the view.')
    const selectionBeforeFocus = controller.snapshot().currentNodeId
    assert.ok(await controller.receive({ type: 'focus', version: state.version, id: analysis.id }))
    assert.equal(controller.snapshot().currentNodeId, selectionBeforeFocus, 'Keyboard focus does not commit selection.')
    for (const path of [one, nested, one]) {
        await open(path)
        await delay(200)
        state = controller.snapshot()
        assert.equal(state.project?.root, fileUri(a))
        assert.equal(state.version, firstVersion, 'Changing editors must not rebuild a stable project model.')
        assert.deepEqual(state.nodes.map(node => node.id), stableIds)
        assert.ok(!state.expanded.includes(analysis.id), 'An unrelated collapsed branch stays collapsed.')
        assert.equal(state.focusedNodeId, analysis.id, 'Editor following never moves sidebar keyboard focus.')
    }
    await open(two)
    await delay(200)
    assert.deepEqual(controller.snapshot().nodes.map(node => node.id), stableIds)
    assert.equal(controller.snapshot().version, firstVersion)
    checks.push('Root, complete model, IDs and unrelated expansion survive two chapters and a nested include')

    for (const [kind, title, file, prose] of [
        ['figure', 'Imagined river stations', one, 'Layout prose.'],
        ['table', 'Invented estimates', two, 'Estimate prose.'],
    ] as const) {
        state = controller.snapshot()
        const node = state.nodes.find(item => item.kind === kind && item.title === title)!
        assert.ok(await controller.receive({ type: 'navigate', version: state.version, id: node.id }))
        await delay(200)
        assert.equal(controller.snapshot().currentNodeId, node.id, 'Own editor events must retain the selected float.')
        const editor = vscode.window.activeTextEditor!
        assert.equal(editor.document.uri.fsPath, file)
        assert.equal(editor.document.getText(editor.selection), `\\caption{${title}}`)
        const position = editor.document.positionAt(editor.document.getText().indexOf(prose) + 2)
        editor.selection = new vscode.Selection(position, position)
        await wait(next => next.currentNodeId !== node.id && Boolean(next.currentNodeId), 'Subsequent caret movement follows heading')
        const selected = controller.snapshot().nodes.find(item => item.id === controller.snapshot().currentNodeId)
        assert.equal(selected?.kind, 'heading')
    }
    checks.push('Figure and table clicks select exact captions, survive their own editor events and yield to later caret movement')

    const editor = await open(one)
    state = await ready(a)
    const original = editor.document.getText()
    const disk = await readFile(one, 'utf8')
    const beforeEditIds = state.nodes.filter(node => node.title !== 'Supporting ledger').map(node => node.id)
    await editor.edit(edit => edit.insert(new vscode.Position(0, 0), '\\section{Unsaved observation}\n'))
    const dirty = await wait(next => next.status === 'ready' && next.nodes.some(node => node.title === 'Unsaved observation'), 'Unsaved heading appears')
    assert.equal(await readFile(one, 'utf8'), disk)
    for (const id of beforeEditIds) assert.ok(dirty.nodes.some(node => node.id === id), 'Unrelated identities survive structural insertion above.')
    const activeBeforeStale = vscode.window.activeTextEditor
    assert.equal(await controller.receive({ type: 'navigate', version: state.version, id: state.nodes[0].id }), false)
    assert.ok(controller.snapshot().notice, 'Stale message feedback is visible even while the model is ready.')
    assert.equal(vscode.window.activeTextEditor, activeBeforeStale)
    assert.equal(await controller.receive({ type: 'navigate', version: dirty.version, id: dirty.nodes[0].id, uri: 'file:///forbidden.tex' }), false)
    assert.ok(controller.snapshot().notice)
    assert.equal(await controller.receive({ type: 'navigate', version: dirty.version, id: 'removed-node' }), false)
    assert.ok(controller.snapshot().notice)
    for (const message of [
        { type: 'focus', version: state.version, id: analysis.id },
        { type: 'view', version: state.version, contentMode: 'floats', chapterOnly: true },
        { type: 'bulkExpand', version: state.version, expanded: false },
        { type: 'focus', version: dirty.version, id: 'removed-node' },
    ]) assert.equal(await controller.receive(message), false)
    assert.equal(controller.snapshot().focusedNodeId, analysis.id)
    assert.equal(controller.snapshot().contentMode, 'headings')
    const inserted = dirty.nodes.find(node => node.title === 'Unsaved observation')!
    assert.ok(await controller.receive({ type: 'focus', version: dirty.version, id: inserted.id }))
    assert.equal(controller.snapshot().notice, undefined, 'A successful current-model interaction clears the notice.')
    await editor.edit(edit => edit.replace(new vscode.Range(0, 0, editor.document.lineCount, 0), original))
    await wait(next => next.status === 'ready' && !next.nodes.some(node => node.title === 'Unsaved observation'), 'Restore unsaved buffer')
    assert.equal(controller.snapshot().focusedNodeId, undefined, 'Removed model IDs clear focus rather than matching a title.')
    state = controller.snapshot()
    assert.ok(await controller.receive({ type: 'focus', version: state.version, id: analysis.id }))
    assert.ok(await controller.receive({ type: 'view', version: state.version, contentMode: 'floats', chapterOnly: true }))
    const expansionBeforeFloats = controller.snapshot().expanded
    assert.equal(await controller.receive({ type: 'bulkExpand', version: state.version, expanded: false }), false)
    assert.deepEqual(controller.snapshot().expanded, expansionBeforeFloats)
    checks.push('Unsaved structural edits update without compilation; stale, removed and path-bearing messages cannot navigate')

    await open(b)
    state = await ready(b)
    assert.deepEqual(state.project?.texDirs, [resolve(directory, 'project-b/extras-b')])
    assert.ok(state.nodes.some(node => node.title === 'Separate support'))
    assert.equal(state.contentMode, 'headings')
    assert.equal(state.chapterOnly, false)
    assert.equal(state.focusedNodeId, undefined)
    const pinnedSelection = state.currentNodeId
    await open(resolve(directory, 'notes.txt'))
    await delay(200)
    assert.equal(controller.snapshot().project?.root, fileUri(b))
    await vscode.workspace.getConfiguration('latexToc').update('followEditor', false, vscode.ConfigurationTarget.Workspace)
    await wait(next => !next.followEditor, 'Following disabled')
    await open(one)
    await delay(200)
    assert.equal(controller.snapshot().project?.root, fileUri(b))
    assert.equal(controller.snapshot().currentNodeId, pinnedSelection)
    state = controller.snapshot()
    const pinnedTarget = state.nodes.find(node => node.title === 'Separate support')!
    assert.ok(await controller.receive({ type: 'navigate', version: state.version, id: pinnedTarget.id }))
    assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, resolve(directory, 'project-b/extras-b/support.tex'))
    await open(one)
    await vscode.workspace.getConfiguration('latexToc').update('followEditor', true, vscode.ConfigurationTarget.Workspace)
    await ready(a)
    state = controller.snapshot()
    assert.equal(state.contentMode, 'floats')
    assert.equal(state.chapterOnly, true)
    assert.equal(state.focusedNodeId, analysis.id)
    assert.ok(await controller.receive({ type: 'view', version: state.version, contentMode: 'headings', chapterOnly: false }))
    checks.push('Focus is independent from caret following; stale view messages are rejected; view and focus restore per root only within the session')
    checks.push('Multi-root resource settings switch with projects; non-TeX tabs retain; pinning preserves selection and permits navigation; re-enable reconciles')

    let mainEditor = await open(a)
    const mainOriginal = mainEditor.document.getText()
    await vscode.workspace.getConfiguration('latexToc').update('followEditor', false, vscode.ConfigurationTarget.Workspace)
    await wait(next => !next.followEditor, 'Pin scoped-action fixture')
    try {
        await mainEditor.edit(edit => edit.replace(new vscode.Range(0, 0, mainEditor.document.lineCount, 0),
            '\\documentclass{report}\n\\begin{document}\n\\part{Scope part}\n\\section{Scope front matter}\n'
            + '\\subsection{Scope front child}\n\\chapter{Scope chapter A}\n\\section{Scope section A}\n'
            + '\\subsection{Scope child A}\n\\chapter{Scope chapter B}\n\\section{Scope section B}\n'
            + '\\subsection{Scope child B}\n\\end{document}\n'))
        state = await wait(next => next.status === 'ready' && next.nodes.some(node => node.title === 'Scope child B'), 'Scoped-action model')
        const node = (title: string) => state.nodes.find(item => item.title === title)!
        const chapterA = node('Scope chapter A')
        const chapterB = node('Scope chapter B')
        const sectionA = node('Scope section A')
        const sectionB = node('Scope section B')
        const part = node('Scope part')
        assert.ok(await controller.receive({ type: 'navigate', version: state.version, id: sectionA.id }))
        assert.ok(await controller.receive({ type: 'focus', version: state.version, id: sectionB.id }))
        assert.ok(await controller.receive({ type: 'view', version: state.version, contentMode: 'headings', chapterOnly: true }))
        const selectedRange = vscode.window.activeTextEditor!.selection
        assert.ok(await controller.receive({ type: 'bulkExpand', version: state.version, expanded: false }))
        let collapsed = controller.snapshot()
        assert.ok(!collapsed.expanded.includes(chapterA.id))
        assert.ok(!collapsed.expanded.includes(sectionA.id))
        assert.ok(collapsed.expanded.includes(chapterB.id), 'The semantic chapter, not its part, bounds collapse.')
        assert.ok(collapsed.expanded.includes(sectionB.id), 'Hidden chapter expansion survives.')
        assert.ok(collapsed.expanded.includes(part.id))
        assert.equal(collapsed.currentNodeId, sectionA.id, 'Collapse preserves a now-hidden committed selection.')
        assert.equal(collapsed.focusedNodeId, sectionB.id, 'Bulk scope does not follow keyboard focus.')
        assert.ok(vscode.window.activeTextEditor!.selection.isEqual(selectedRange), 'Collapse never navigates.')
        assert.ok(await controller.receive({ type: 'bulkExpand', version: state.version, expanded: true }))
        assert.ok(controller.snapshot().expanded.includes(sectionA.id))
        assert.ok(await controller.receive({ type: 'navigate', version: state.version, id: node('Scope front matter').id }))
        assert.ok(await controller.receive({ type: 'bulkExpand', version: state.version, expanded: false }))
        collapsed = controller.snapshot()
        assert.deepEqual(collapsed.expanded, [], 'Front matter under a part has whole-document fallback, not part scope.')
        assert.equal(collapsed.currentNodeId, node('Scope front matter').id)
        assert.ok(await controller.receive({ type: 'bulkExpand', version: state.version, expanded: true }))
        assert.ok(await controller.receive({ type: 'view', version: state.version, contentMode: 'headings', chapterOnly: false }))
        checks.push('Scoped bulk actions use the committed semantic chapter beneath parts; preserve hidden chapters, focus, selection and editor range; front matter falls back to the full document')
    } finally {
        await mainEditor.edit(edit => edit.replace(new vscode.Range(0, 0, mainEditor.document.lineCount, 0), mainOriginal))
        await wait(next => next.status === 'ready' && !next.nodes.some(node => node.title === 'Scope part'), 'Restore scoped-action fixture')
        assert.equal(controller.snapshot().focusedNodeId, undefined)
        assert.equal(controller.snapshot().currentNodeId, undefined, 'Removed committed IDs are not reassigned while pinned.')
        await vscode.workspace.getConfiguration('latexToc').update('followEditor', true, vscode.ConfigurationTarget.Workspace)
        await wait(next => next.status === 'ready' && next.followEditor, 'Resume following after scoped actions')
    }

    const appearanceConfig = vscode.workspace.getConfiguration('latexToc', vscode.Uri.file(a))
    const appearanceKeys = ['indentPx', 'palette', 'visibleRanks', 'colors.light.chapter', 'colors.light.part', 'colors.dark.section', 'sectionCommands']
    const previousAppearance = appearanceKeys.map(key => [key, appearanceConfig.inspect(key)?.workspaceFolderValue] as const)
    await vscode.workspace.getConfiguration('latexToc').update('followEditor', false, vscode.ConfigurationTarget.Workspace)
    await wait(next => !next.followEditor, 'Pin appearance scenario')
    state = controller.snapshot()
    const appearanceTarget = state.nodes.find(node => node.kind === 'figure')!
    await controller.receive({ type: 'navigate', version: state.version, id: appearanceTarget.id })
    await controller.receive({ type: 'focus', version: state.version, id: analysis.id })
    await controller.receive({ type: 'expand', version: state.version, id: analysis.id, expanded: false })
    await controller.receive({ type: 'scroll', version: state.version, top: 42 })
    const appearanceBefore = controller.snapshot()
    try {
        await appearanceConfig.update('indentPx', 32, vscode.ConfigurationTarget.WorkspaceFolder)
        await appearanceConfig.update('colors.light.chapter', '#123456', vscode.ConfigurationTarget.WorkspaceFolder)
        await appearanceConfig.update('colors.light.part', '#abcdef', vscode.ConfigurationTarget.WorkspaceFolder)
        await appearanceConfig.update('colors.dark.section', '#fedcba', vscode.ConfigurationTarget.WorkspaceFolder)
        await appearanceConfig.update('visibleRanks', ['subparagraph', 'section', 'paragraph'], vscode.ConfigurationTarget.WorkspaceFolder)
        const changed = await wait(next => next.appearance.indentPx === 32
            && next.appearance.colors.dark.section === '#fedcbaff' && next.appearance.visibleRanks.length === 3, 'Live appearance settings')
        assert.equal(changed.version, appearanceBefore.version, 'Appearance updates do not reparse or replace the source model.')
        assert.equal(changed.currentNodeId, appearanceBefore.currentNodeId)
        assert.equal(changed.focusedNodeId, appearanceBefore.focusedNodeId)
        assert.deepEqual(changed.expanded, appearanceBefore.expanded)
        assert.equal(changed.scrollTop, appearanceBefore.scrollTop)
        assert.equal(vscode.window.activeTextEditor!.document.getText(vscode.window.activeTextEditor!.selection), '\\caption{Imagined river stations}')
        assert.equal(changed.appearance.colors.light.part, '#abcdefff')
        await appearanceConfig.update('colors.light.part', undefined, vscode.ConfigurationTarget.WorkspaceFolder)
        await wait(next => next.appearance.colors.light.part === '#123456ff', 'Reset one rank reveals inherited effective color')
        assert.equal(controller.snapshot().appearance.colors.dark.section, '#fedcbaff', 'Resetting one override leaves other overrides intact.')
        await appearanceConfig.update('palette', 'not-in-this-profile', vscode.ConfigurationTarget.WorkspaceFolder)
        const missingPalette = await wait(next => next.appearance.requestedPalette === 'not-in-this-profile', 'Missing palette feedback')
        assert.equal(missingPalette.appearance.resolvedPalette, 'purple-red-green-muted')
        assert.ok(missingPalette.appearance.notice, 'The requested palette must not be silently presented as available.')
        assert.equal(missingPalette.appearance.colors.light.chapter, '#123456ff', 'Fallback does not erase explicit overrides.')

        await controller.selectRoot(vscode.Uri.file(b))
        const otherAppearance = await ready(b)
        assert.notEqual(otherAppearance.appearance.indentPx, 32, 'Folder-specific appearance does not leak to a second project.')
        assert.notEqual(otherAppearance.appearance.requestedPalette, 'not-in-this-profile')
        await controller.selectRoot(vscode.Uri.file(a))
        const restoredAppearance = await ready(a)
        assert.equal(restoredAppearance.appearance.indentPx, 32)
        assert.equal(restoredAppearance.currentNodeId, appearanceTarget.id, 'Explicit project switching restores its pinned selection.')
        checks.push('Live resource-scoped appearance preserves model version, caption selection, focus, expansion and scroll; one-rank reset exposes inheritance; missing palettes are explicit')

        const aliasEditor = await open(a)
        await aliasEditor.edit(edit => edit.replace(new vscode.Range(0, 0, aliasEditor.document.lineCount, 0),
            '\\documentclass{report}\n\\begin{document}\n\\part{Appearance part}\n\\chapter{Appearance chapter}\n'
            + '\\section{Appearance section}\n\\subsection{Appearance subsection}\n\\subsubsection{Appearance detail}\n'
            + '\\paragraph{Appearance paragraph}\n\\subparagraph{Appearance subparagraph}\n'
            + '\\prefacesection*[Short preface]{Long custom preface title}\n\\end{document}\n'))
        await wait(next => next.status === 'ready' && next.nodes.some(node => node.title === 'Appearance subparagraph'), 'Additional-rank stress source')
        await appearanceConfig.update('sectionCommands', { prefacesection: 'chapter' }, vscode.ConfigurationTarget.WorkspaceFolder)
        const aliased = await wait(next => next.status === 'ready' && next.nodes.some(node => node.title === 'Short preface'), 'Live parser alias')
        const alias = aliased.nodes.find(node => node.title === 'Short preface')!
        assert.equal(alias.rank, 'chapter')
        assert.equal(alias.number, undefined, 'The parsed alias star remains unnumbered.')
        assert.deepEqual(aliased.nodes.filter(node => node.kind === 'heading').slice(0, 7).map(node => node.rank),
            ['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph'])
        assert.ok(await controller.receive({ type: 'navigate', version: aliased.version, id: alias.id }))
        assert.equal(vscode.window.activeTextEditor!.document.getText(vscode.window.activeTextEditor!.selection),
            '\\prefacesection*[Short preface]{Long custom preface title}')
        await appearanceConfig.update('sectionCommands', {}, vscode.ConfigurationTarget.WorkspaceFolder)
        await wait(next => next.status === 'ready' && !next.nodes.some(node => node.title === 'Short preface'), 'Removing an alias updates the model')
        assert.equal(controller.snapshot().currentNodeId, undefined, 'Removing the selected alias clears stale navigation identity.')
        checks.push('All seven semantic ranks survive visibility settings; custom aliases update live and preserve star/short-title parsing and exact source targets')
    } finally {
        for (const [key, value] of previousAppearance) await appearanceConfig.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder)
        mainEditor = await open(a)
        await mainEditor.edit(edit => edit.replace(new vscode.Range(0, 0, mainEditor.document.lineCount, 0), mainOriginal))
        await wait(next => next.status === 'ready' && next.nodes.some(node => node.title === 'Fictional river observations'), 'Restore appearance scenario')
        await vscode.workspace.getConfiguration('latexToc').update('followEditor', true, vscode.ConfigurationTarget.Workspace)
        await wait(next => next.status === 'ready' && next.followEditor, 'Resume after appearance scenario')
    }
    const missing = resolve(directory, 'project-a/late.tex')
    await mainEditor.edit(edit => edit.insert(new vscode.Position(0, 0), '\\input{late}\n'))
    await wait(next => next.status === 'ready' && next.diagnostics.some(message => message.startsWith('missing-include:')), 'Missing include diagnostic')
    await writeFile(missing, '\\section{Late filesystem arrival}\n')
    await wait(next => next.status === 'ready' && next.nodes.some(node => node.title === 'Late filesystem arrival'), 'Missing include creation watcher')
    await writeFile(missing, '\\section{Unclosed')
    await wait(next => next.status === 'ready' && next.diagnostics.some(message => message.startsWith('parse-error:')), 'Malformed source diagnostic')
    await unlink(missing)
    await wait(next => next.status === 'ready' && next.diagnostics.some(message => message.startsWith('missing-include:')), 'Deleted source diagnostic')
    await mainEditor.edit(edit => edit.replace(new vscode.Range(0, 0, mainEditor.document.lineCount, 0), mainOriginal))
    await wait(next => next.status === 'ready' && next.diagnostics.length === 0, 'Restored include graph')
    checks.push('Filesystem creation, malformed input and deletion invalidate the project and display diagnostics')

    const beforeLimit = controller.snapshot()
    await controller.receive({ type: 'navigate', version: beforeLimit.version, id: 'removed-node' })
    await mainEditor.edit(edit => edit.replace(new vscode.Range(0, 0, mainEditor.document.lineCount, 0), '%'.repeat(MAX_SOURCE_BYTES + 1)))
    const limited = await wait(next => next.status === 'error', 'Oversized unsaved source is visibly rejected')
    assert.equal(limited.notice, undefined, 'An earlier navigation notice cannot hide the processing error.')
    assert.equal(limited.version, beforeLimit.version, 'A failed build cannot publish a partial model.')
    assert.deepEqual(limited.nodes, beforeLimit.nodes)
    assert.equal(await controller.receive({ type: 'navigate', version: limited.version, id: limited.nodes[0].id }), false)
    await mainEditor.edit(edit => edit.replace(new vscode.Range(0, 0, mainEditor.document.lineCount, 0), mainOriginal))
    await wait(next => next.status === 'ready' && next.version > beforeLimit.version && next.diagnostics.length === 0, 'Recover after the source limit')
    assert.equal(await readFile(a, 'utf8'), mainOriginal, 'The oversized-buffer check never writes source.')
    checks.push('Oversized unsaved sources show an error without publishing partial models or permitting stale navigation; correction recovers without disk writes')

    await open(resolve(directory, 'orphan/lonely.tex'))
    await wait(next => next.status === 'unresolved' && !next.project, 'Unresolved root cannot masquerade as previous project')
    const outside = resolve(directory, 'outside/main.tex')
    await open(outside)
    state = await ready(outside)
    assert.equal(vscode.workspace.getWorkspaceFolder(vscode.Uri.file(outside)), undefined)
    await controller.selectRoot(vscode.Uri.file(outside))
    await ready(outside)
    assert.ok(extension.isActive)
    await open(resolve(directory, 'outside/nested/chapter.tex'))
    await delay(200)
    assert.equal(controller.snapshot().project?.root, fileUri(outside))
    checks.push('Unresolved roots are visible; loose-file roots and nested includes work outside workspace folders')

    const synthetic = process.env.LATEX_TOC_SYNTHETIC
    if (synthetic) {
        await open(synthetic)
        state = await ready(synthetic)
        assert.equal(state.nodes.filter(node => node.kind === 'heading').length, 54)
        assert.equal(state.nodes.filter(node => node.kind !== 'heading').length, 12)
        checks.push('Canonical synthetic thesis loads all 54 headings and 12 floats')
    } else {
        await open(a)
        state = await ready(a)
    }
    await vscode.commands.executeCommand('latexToc.outline.focus')
    const report = { vscode: vscode.version, platform: process.platform, checks, finalRoot: state.project?.root,
        headings: state.nodes.filter(node => node.kind === 'heading').length, floats: state.nodes.filter(node => node.kind !== 'heading').length }
    await writeFile(process.env.LATEX_TOC_REPORT!, JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(report, null, 2))
    console.log('NAVIGATION_HOST_SMOKE_READY')
    if (process.env.LATEX_TOC_HOLD === '1') await vscode.window.showInformationMessage('Navigation host checks passed. Inspect the synthetic outline, then finish.', 'Finish')
}
