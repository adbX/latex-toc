import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open as openFile, stat } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import type { ReadSource, SourceSnapshot } from './model.js'
import { MAX_SOURCE_BYTES, ProcessingLimitError, sourceBytes } from './processing.js'

export function fileUri(path: string): string {
    return pathToFileURL(resolve(path)).href
}

/** Snapshot open buffers before starting a build; never read their stale disk copies. */
export function sourceReader(buffers: readonly SourceSnapshot[] = [], signal?: AbortSignal): ReadSource {
    const open = new Map(buffers.map(snapshot => {
        const uri = fileUri(fileURLToPath(snapshot.uri))
        return [uri, uri === snapshot.uri ? snapshot : { ...snapshot, uri }]
    }))
    return async uri => {
        signal?.throwIfAborted()
        const buffer = open.get(uri)
        if (buffer !== undefined) {
            sourceBytes(buffer)
            return buffer
        }
        let text: string
        try {
            const path = fileURLToPath(uri)
            const rejectSpecial = () => { throw new Error(`Source is not a regular file: ${path}`) }
            // Check before opening devices, then verify the opened target against replacement races.
            if (!(await stat(path)).isFile()) rejectSpecial()
            signal?.throwIfAborted()
            const handle = await openFile(path, constants.O_RDONLY | constants.O_NONBLOCK)
            try {
                signal?.throwIfAborted()
                const metadata = await handle.stat()
                if (!metadata.isFile()) rejectSpecial()
                const tooLarge = () => { throw new ProcessingLimitError('source-bytes', `Source ${path} exceeds 4 MiB of UTF-8 text.`) }
                if (metadata.size > MAX_SOURCE_BYTES) tooLarge()
                let chunkSize = Math.max(1, Math.min(64 * 1024, metadata.size + 1))
                const chunks: Buffer[] = []
                let bytes = 0
                while (true) {
                    signal?.throwIfAborted()
                    // Read one sentinel byte beyond the limit, even if the file grows after stat.
                    const chunk = Buffer.allocUnsafe(Math.min(chunkSize, MAX_SOURCE_BYTES + 1 - bytes))
                    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
                    signal?.throwIfAborted()
                    if (bytesRead === 0) break
                    bytes += bytesRead
                    if (bytes > MAX_SOURCE_BYTES) tooLarge()
                    chunks.push(chunk.subarray(0, bytesRead))
                    if (bytesRead === chunk.length) chunkSize = 64 * 1024
                }
                text = (chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, bytes)).toString('utf8')
            } finally {
                await handle.close()
            }
        } catch (error) {
            signal?.throwIfAborted()
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return undefined
            }
            throw error
        }
        signal?.throwIfAborted()
        const source = { uri, text, version: createHash('sha256').update(text).digest('hex') }
        sourceBytes(source)
        return source
    }
}
