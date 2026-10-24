import { readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { build } from 'esbuild'
import sveltePlugin from 'esbuild-svelte'

const host = await build({
    entryPoints: { extension: 'src/extension.ts' }, outdir: 'dist',
    outExtension: { '.js': '.cjs' }, platform: 'node', target: 'node18', format: 'cjs', bundle: true, external: ['vscode'], metafile: true,
})
await build({
    entryPoints: ['test/driver/extension.ts'], outfile: 'test/driver/out/extension.cjs',
    platform: 'node', target: 'node18', format: 'cjs', bundle: true, external: ['vscode'],
})
const webview = await build({
    // Production minification also removes plugin-generated CSS comments containing checkout paths.
    entryPoints: ['src/webview/index.ts'], outdir: 'dist/webview', platform: 'browser', target: 'chrome114', bundle: true, metafile: true, minify: true,
    conditions: ['svelte', 'browser'], mainFields: ['svelte', 'browser', 'module', 'main'],
    plugins: [sveltePlugin({ compilerOptions: { runes: true } })],
})
await rename('dist/webview/index.css', 'dist/webview/style.css')

// Derive notices from code actually included in the two runtime bundles, not dev dependencies.
const packageDirectories = new Set()
for (const result of [host, webview]) {
    for (const output of Object.values(result.metafile.outputs)) {
        for (const [input, contribution] of Object.entries(output.inputs)) {
            const directory = input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//)?.[1]
            if (directory && contribution.bytesInOutput > 0) packageDirectories.add(directory)
        }
    }
}
const notices = ['Third-party packages included in the LaTeX TOC runtime bundles.\nSee third-party/ for adapted LaTeX Workshop and Lucide notices.']
for (const directory of [...packageDirectories].sort()) {
    const manifest = JSON.parse(await readFile(`${directory}/package.json`, 'utf8'))
    const names = (await readdir(directory)).filter(name => /^(licen[sc]e|copying|notice)(\..*)?$/i.test(name)).sort()
    let license
    if (names.length) license = (await Promise.all(names.map(name => readFile(`${directory}/${name}`, 'utf8')))).join('\n\n')
    else if (manifest.name.startsWith('@unified-latex/') && manifest.version === '1.8.4' && manifest.license === 'MIT') {
        // npm omits the monorepo license; retained from npm gitHead 7a74e60c4fbaf2527b9cf79772c0c7266f3d2b2c.
        license = await readFile('third-party/unified-latex-LICENSE.txt', 'utf8')
    } else if (manifest.name === 'trie-prefix-tree' && manifest.version === '1.5.1' && manifest.license === 'MIT') {
        license = await readFile('third-party/trie-prefix-tree-NOTICE.txt', 'utf8')
    } else throw new Error(`Missing runtime license for ${manifest.name}@${manifest.version}`)
    notices.push(`${manifest.name}@${manifest.version} (${manifest.license})\n\n${license.trim()}`)
}
await writeFile('dist/THIRD-PARTY-LICENSES.txt', notices.join('\n\n' + '='.repeat(72) + '\n\n') + '\n')

await import('./experiment/build.mjs')
