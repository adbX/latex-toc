import { build } from 'esbuild'

await build({
    entryPoints: ['experiment/extension.ts', 'experiment/host-smoke.ts'],
    outdir: 'experiment/out',
    outExtension: { '.js': '.cjs' },
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    bundle: true,
    external: ['vscode'],
})
