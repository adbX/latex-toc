import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: {
    code: { type: 'string' }, synthetic: { type: 'string' }, usc: { type: 'string' }, workshop: { type: 'string' }, hold: { type: 'boolean', default: false },
} })
for (const name of ['code', 'synthetic', 'usc', 'workshop']) {
    if (!values[name]) throw new Error(`Missing --${name}; see README.md for the isolated host invocation.`)
}
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
await mkdir(resolve(project, '.host'), { recursive: true })
const run = await mkdtemp(resolve(project, '.host/run-'))
const userData = resolve(run, 'user-data')
const extensions = resolve(run, 'extensions')
await mkdir(resolve(userData, 'User'), { recursive: true })
await mkdir(extensions)
const settings = {
    'latex-workshop.latex.autoBuild.run': 'never',
    'latex-workshop.latex.autoClean.run': 'never',
    'latex-workshop.linting.chktex.enabled': false,
    'latex-workshop.linting.lacheck.enabled': false,
    'latex-workshop.intellisense.package.enabled': false,
    'latex-workshop.view.outline.sections': ['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph'],
    'latex-workshop.view.outline.commands': [],
    'latex-workshop.view.outline.floats.enabled': true,
    'latex-workshop.view.outline.floats.number.enabled': true,
    'latex-workshop.view.outline.floats.caption.enabled': true,
    'latex-workshop.view.outline.numbers.enabled': true,
    'workbench.startupEditor': 'none',
    'window.title': 'LaTeX TOC isolated backend experiment',
    'telemetry.telemetryLevel': 'off',
}
await writeFile(resolve(userData, 'User/settings.json'), JSON.stringify(settings, null, 2))
const workspace = resolve(run, 'experiment.code-workspace')
await writeFile(workspace, JSON.stringify({ folders: [
    { path: dirname(resolve(values.synthetic)), name: 'Synthetic thesis' },
    { path: dirname(resolve(values.usc)), name: 'Public USC compatibility fixture' },
] }, null, 2))
console.log(`Isolated development host: ${run}`)
const child = spawn(resolve(values.code), [
    workspace, '--new-window', '--skip-welcome', '--skip-release-notes',
    `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`,
    `--extensionDevelopmentPath=${resolve(project, 'experiment')}`,
    `--extensionDevelopmentPath=${resolve(values.workshop)}`,
    `--extensionTestsPath=${resolve(project, 'experiment/out/host-smoke.cjs')}`,
], { stdio: 'inherit', env: {
    ...process.env,
    LATEX_TOC_SYNTHETIC: resolve(values.synthetic),
    LATEX_TOC_USC: resolve(values.usc),
    LATEX_TOC_REPORT: resolve(run, 'report.json'),
    LATEX_TOC_HOLD: values.hold ? '1' : '',
} })
child.on('error', error => { console.error(error); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
process.on('SIGINT', () => child.kill('SIGINT'))
