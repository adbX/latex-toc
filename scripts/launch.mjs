import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: {
    code: { type: 'string' }, synthetic: { type: 'string' }, smoke: { type: 'boolean', default: false },
    hold: { type: 'boolean', default: false }, port: { type: 'string' }, reuse: { type: 'string' }, stage: { type: 'string' },
    installed: { type: 'boolean', default: false },
} })
if (!values.code) throw new Error('Supply --code with the VS Code executable, not its CLI shim.')
if (values.stage && !['remember', 'restore'].includes(values.stage)) throw new Error('--stage must be remember or restore.')
if (values.stage && !values.reuse) throw new Error('Persistence stages require --reuse with an existing isolated run directory.')
if (values.installed && (!values.reuse || values.smoke || values.stage)) {
    throw new Error('--installed requires --reuse and cannot load the development-only smoke driver.')
}
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
await mkdir(resolve(project, '.host'), { recursive: true })
const run = values.reuse ? resolve(values.reuse) : await mkdtemp(resolve(project, '.host/navigation-'))
const userData = resolve(run, 'user-data')
const extensions = resolve(run, 'extensions')
await mkdir(resolve(userData, 'User'), { recursive: true })
await mkdir(extensions, { recursive: true })
const files = {
    'project-a/main.tex': '\\documentclass{report}\n\\begin{document}\n\\input{chapters/one}\n\\input{chapters/two}\n\\input{support}\n\\end{document}\n',
    'project-a/chapters/one.tex': '\\chapter{Fictional river observations}\nIntroductory prose.\n\\section{Sensor layout}\nLayout prose.\n\\begin{figure}\nDrawing body.\n\\caption{Imagined river stations}\n\\end{figure}\n\\input{nested/detail}\n',
    'project-a/chapters/nested/detail.tex': '\\subsection{Nested sampling detail}\nNested prose.\n',
    'project-a/chapters/two.tex': '\\chapter{Fictional analysis}\nAnalysis prose.\n\\section{Estimates}\nEstimate prose.\n\\begin{table}\n\\caption{Invented estimates}\n\\end{table}\n',
    'project-a/extras-a/support.tex': '\\chapter{Supporting ledger}\nLedger prose.\n',
    'project-a/.vscode/settings.json': JSON.stringify({ 'latexToc.texDirs': ['extras-a'] }, null, 2),
    'project-b/main.tex': '\\documentclass{report}\n\\chapter{Independent fictional project}\n\\input{support}\n',
    'project-b/extras-b/support.tex': '\\section{Separate support}\nOther project prose.\n',
    'project-b/.vscode/settings.json': JSON.stringify({ 'latexToc.texDirs': ['extras-b'] }, null, 2),
    'outside/main.tex': '\\documentclass{article}\n\\section{Loose fictional document}\n\\input{nested/chapter}\n',
    'outside/nested/chapter.tex': '\\subsection{Loose nested chapter}\nLoose prose.\n',
    'orphan/lonely.tex': '\\section{No build root}\n',
    'notes.txt': 'Synthetic navigation-host fixtures only. No private manuscript is used.\n',
}
if (!values.reuse) for (const [name, text] of Object.entries(files)) {
    const path = resolve(run, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text)
}
if (!values.reuse) await writeFile(resolve(userData, 'User/settings.json'), JSON.stringify({
    'workbench.startupEditor': 'none', 'window.title': 'LaTeX TOC isolated navigation host',
    'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false,
}, null, 2))
const folders = [{ path: resolve(run, 'project-a'), name: 'Synthetic project A' }, { path: resolve(run, 'project-b'), name: 'Synthetic project B' }]
if (values.synthetic) folders.push({ path: dirname(resolve(values.synthetic)), name: 'Canonical synthetic thesis' })
const workspace = resolve(run, 'navigation.code-workspace')
if (!values.reuse) await writeFile(workspace, JSON.stringify({ folders }, null, 2))
console.log(`Isolated navigation host: ${run}`)
const args = [workspace, '--new-window', '--skip-welcome', '--skip-release-notes',
    `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`]
if (!values.installed) args.push(`--extensionDevelopmentPath=${project}`)
if (values.smoke) args.push(`--extensionDevelopmentPath=${resolve(project, 'test/driver')}`)
if (values.port) args.push(`--remote-debugging-port=${values.port}`)
const resultPath = resolve(run, `${values.stage ?? 'navigation'}-result-${Date.now()}.json`)
const child = spawn(resolve(values.code), args, { stdio: 'inherit', env: {
    ...process.env, LATEX_TOC_FIXTURE: run, LATEX_TOC_SYNTHETIC: values.synthetic ? resolve(values.synthetic) : '',
    LATEX_TOC_REPORT: resolve(run, values.stage ? `${values.stage}-report.json` : 'report.json'),
    LATEX_TOC_HOLD: values.hold ? '1' : '', LATEX_TOC_STAGE: values.stage ?? '',
    LATEX_TOC_RESULT: resultPath,
} })
child.on('error', error => { console.error(error); process.exitCode = 1 })
child.on('exit', async code => {
    process.exitCode = code ?? 1
    if (values.smoke) {
        try {
            const result = JSON.parse(await readFile(resultPath, 'utf8'))
            if (!result.passed) { console.error(result.error); process.exitCode = 1 }
        } catch (error) { console.error('Host did not complete its checks:', error); process.exitCode = 1 }
    }
})
process.on('SIGINT', () => child.kill('SIGINT'))
