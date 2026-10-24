import { fileURLToPath } from 'node:url'
import { fileUri, sourceReader } from '../src/files.js'
import { buildOutline } from '../src/project.js'

const path = process.argv[2]
if (!path) {
    console.error('Usage: npm run inspect -- /path/to/main.tex')
    process.exitCode = 2
} else {
    const outline = await buildOutline(fileUri(path), sourceReader())
    console.log(JSON.stringify({
        root: fileURLToPath(outline.root),
        files: outline.files.length,
        headings: outline.flat.filter(node => node.kind === 'heading').length,
        floats: outline.flat.filter(node => node.kind !== 'heading').length,
        diagnostics: outline.diagnostics,
        nodes: outline.flat.map(node => ({
            kind: node.kind, rank: node.rank, number: node.number, title: node.title,
            file: fileURLToPath(node.uri), line: node.range.start.line + 1,
            character: node.range.start.character + 1, parentId: node.parentId,
        })),
    }, null, 2))
    if (outline.diagnostics.length > 0) {
        process.exitCode = 1
    }
}
