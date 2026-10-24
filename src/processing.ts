import { basename } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { SourceSnapshot } from './model.js'

export const MAX_SOURCE_BYTES = 4 * 1024 * 1024
export const MAX_PROJECT_BYTES = 32 * 1024 * 1024
export const MAX_FILE_OCCURRENCES = 10_000
export const MAX_STRUCTURAL_EVENTS = 100_000
export const MAX_DISCOVERY_ENTRIES = 20_000

export class ProcessingLimitError extends Error {
    constructor(readonly limit: 'source-bytes' | 'project-bytes' | 'file-occurrences' | 'structural-events' | 'discovery-entries', message: string) {
        super(message)
        this.name = 'ProcessingLimitError'
    }
}

/** Apply the same UTF-8 text limit to open buffers and injected source readers. */
export function sourceBytes(source: SourceSnapshot): number {
    const bytes = Buffer.byteLength(source.text, 'utf8')
    if (bytes > MAX_SOURCE_BYTES) throw new ProcessingLimitError('source-bytes', `Source ${basename(fileURLToPath(source.uri))} exceeds 4 MiB of UTF-8 text.`)
    return bytes
}

/** Let editor events cancel cached graph work between bounded batches. */
export async function yieldProcessing(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    await setImmediate()
    signal?.throwIfAborted()
}
