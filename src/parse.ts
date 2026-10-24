// Adapted from LaTeX Workshop's unified-defs.ts, utils.ts, inputfilepath.ts,
// and outline/structure/latex.ts at fb1d13108f1947028edb3d9881ed4843b983a3c8.
// MIT, Copyright 2016 James Yu; see third-party/LaTeX-Workshop-LICENSE.txt.
import type * as Ast from '@unified-latex/unified-latex-types'
import { getParser } from '@unified-latex/unified-latex-util-parse'
import { argContentToStr, sanitizeLabel } from './labels.js'
import { ranks, type OutlineConfig, type Position, type Rank, type SourceRange, type SourceSnapshot } from './model.js'

type SourceEvent = {
    range: SourceRange
    ordinal: number
    /** Assigned by a session after conservative source-event reconciliation. */
    identity?: string
} & (
    | { type: 'heading'; command: string; rank: Rank; title: string; starred: boolean }
    | { type: 'float'; command: string; kind: 'figure' | 'table'; title: string }
    | { type: 'include'; command: string; path: string }
    | { type: 'appendix' }
    | { type: 'counter'; name: string; value: number }
)

export interface ParsedFile {
    readonly source: SourceSnapshot
    readonly documentClass?: string
    readonly events: readonly SourceEvent[]
}

/** Workshop filters, but padded rather than deleted so raw UTF-16 offsets stay exact. */
function maskNonSource(text: string): string {
    const comments = /(^|[^\\]|(?:(?<!\\)(?:\\\\)+))%(?![2-9A-F][0-9A-F]).*$/gm
    return text.replace(comments, (match: string, prefix: string) => prefix + ' '.repeat(match.length - prefix.length))
        .replace(/\\verb\*?([^a-zA-Z0-9]).*?\1/g, match => ' '.repeat(match.length))
        .replace(/\\begin{(verbatim\*?|lstlisting\*?|minted\*?|filecontents\*?)}.*?\\end{\1}/gmsi,
            match => match.replace(/[^\r\n]/g, ' '))
}

/** Freeze macro signatures for this parser; parsed events are reused without mutation. */
export function createSourceParser(config: OutlineConfig): (source: SourceSnapshot) => ParsedFile {
    const sectionCommands: Record<string, Rank> = Object.assign(Object.fromEntries(ranks.map(rank => [rank, rank])), config.sectionCommands)
    const macros: Ast.MacroInfoRecord = Object.fromEntries(Object.keys(sectionCommands).map(command => [command, { signature: 's o m' }]))
    const parser = getParser({ macros, flags: { autodetectExpl3AndAtLetter: true } })

    return source => {
        const text = maskNonSource(source.text)
        const ast = parser.parse(text)
        const lineStarts = [0]
        for (let index = 0; index < source.text.length; index++) {
            if (source.text.charCodeAt(index) === 10) lineStarts.push(index + 1)
        }
        const position = (offset: number): Position => {
            let low = 0
            let high = lineStarts.length
            while (low + 1 < high) {
                const middle = (low + high) >>> 1
                if (lineStarts[middle] <= offset) low = middle
                else high = middle
            }
            return { offset, line: low, character: offset - lineStarts[low] }
        }
        // unified-latex keeps macro-token positions, but drops argument delimiters' positions.
        // Recover only the already-parsed argument endpoints, not a second structure parser.
        const endOffset = (node: Ast.Node): number => {
            let end = node.position?.end.offset ?? 0
            if (node.type !== 'macro') return end
            for (const argument of node.args ?? []) {
                let contentEnd = end
                for (const child of argument.content) contentEnd = Math.max(contentEnd, endOffset(child))
                if (argument.openMark && argument.closeMark) {
                    let opening = end
                    while (/\s/.test(text[opening] ?? '') && opening < text.length) opening++
                    contentEnd = Math.max(contentEnd, opening + argument.openMark.length)
                    const closing = text.indexOf(argument.closeMark, contentEnd)
                    if (closing < 0) throw new Error(`Missing parsed argument delimiter at offset ${opening}`)
                    end = closing + argument.closeMark.length
                } else {
                    end = contentEnd
                }
            }
            return end
        }
        const range = (node: Ast.Node): SourceRange => ({
            start: position(node.position?.start.offset ?? 0),
            end: position(endOffset(node)),
        })
        const caption = (...args: (Ast.Argument | undefined)[]): string => {
            for (const argument of args) {
                if (argument?.content.length) return sanitizeLabel(argument.content)
            }
            return ''
        }
        const events: SourceEvent[] = []
        let documentClass: string | undefined
        const visit = (node: Ast.Node): void => {
            if (node.type === 'macro') {
                const command = node.content
                if (command === 'documentclass') {
                    documentClass = argContentToStr(node.args?.[1]?.content ?? []).trim().toLowerCase() || undefined
                } else if (sectionCommands[command] !== undefined && node.args?.[2]?.openMark === '{') {
                    events.push({ type: 'heading', ordinal: events.length, command, rank: sectionCommands[command],
                        title: caption(node.args[1], node.args[2]), starred: Boolean(node.args[0]?.content[0]), range: range(node) })
                } else if (command === 'setcounter') {
                    const name = argContentToStr(node.args?.[0]?.content ?? []).trim()
                    const raw = argContentToStr(node.args?.[1]?.content ?? []).trim()
                    const value = Number(raw)
                    if ((ranks as readonly string[]).includes(name) && /^[+-]?\d+$/.test(raw) && Number.isSafeInteger(value)) {
                        events.push({ type: 'counter', ordinal: events.length, name, value, range: range(node) })
                    }
                } else if (command === 'appendix') {
                    events.push({ type: 'appendix', ordinal: events.length, range: range(node) })
                } else if (command === 'input' || command === 'include') {
                    const path = argContentToStr(node.args?.[0]?.content ?? []).trim().replaceAll('"', '')
                    events.push({ type: 'include', ordinal: events.length, command, path, range: range(node) })
                }
            } else if (node.type === 'environment' && ['figure', 'figure*', 'table', 'table*'].includes(node.env)) {
                const captionNode = node.content.find((child): child is Ast.Macro => child.type === 'macro' && child.content === 'caption')
                const kind = node.env.startsWith('figure') ? 'figure' : 'table'
                events.push({ type: 'float', ordinal: events.length, command: node.env, kind,
                    title: caption(captionNode?.args?.[0], captionNode?.args?.[1]), range: range(captionNode ?? node) })
            }
            // Deliberately do not execute macro arguments (including macro definitions).
            if ('content' in node && Array.isArray(node.content)) {
                for (const child of node.content) visit(child)
            }
        }
        for (const node of ast.content) visit(node)
        return { source, documentClass, events }
    }
}
