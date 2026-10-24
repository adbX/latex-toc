// Adapted from LaTeX Workshop src/utils/parser.ts, revision
// fb1d13108f1947028edb3d9881ed4843b983a3c8 (MIT, Copyright 2016 James Yu).
import type * as Ast from '@unified-latex/unified-latex-types'
import mathSymbols from './math-symbols.json' with { type: 'json' }

const symbols: Readonly<Record<string, string>> = mathSymbols
const formattingMacros = ['textbf', 'textit', 'text', 'emph', 'textrm', 'textsf', 'texttt', 'textsl', 'textsc', 'textup', 'textnormal']

export function argContentToStr(content: Ast.Node[]): string {
    return content.map(node => {
        switch (node.type) {
            case 'string':
            case 'verb':
                return node.content
            case 'whitespace':
            case 'parbreak':
            case 'comment':
                return ' '
            case 'macro':
                if (node.content === 'texorpdfstring') {
                    return (node.args?.[1]?.content[0] as Ast.String | undefined)?.content ?? ''
                }
                return `\\${node.content}` + (node.args?.map(arg => `${arg.openMark}${argContentToStr(arg.content)}${arg.closeMark}`).join('') ?? '')
            case 'environment':
            case 'verbatim':
            case 'mathenv':
                return `\\environment{${node.env}}`
            case 'inlinemath':
                return `$${argContentToStr(node.content)}$`
            case 'displaymath':
                return `\\[${argContentToStr(node.content)}\\]`
            case 'group':
                return argContentToStr(node.content)
            default:
                return ''
        }
    }).join('')
}

function labelContentToStr(content: Ast.Node[], inMath = false): string {
    return content.map(node => {
        switch (node.type) {
            case 'string':
            case 'verb':
                return node.content
            case 'whitespace':
            case 'parbreak':
            case 'comment':
                return ' '
            case 'macro': {
                if (node.content === 'texorpdfstring') {
                    return labelContentToStr(node.args?.[1]?.content ?? [], inMath)
                }
                if (formattingMacros.includes(node.content)) {
                    return labelContentToStr(node.args?.[0]?.content ?? [], inMath)
                }
                if (node.content.startsWith('cite') || (inMath && ['left', 'right', 'middle'].includes(node.content))) {
                    return ''
                }
                const symbol = inMath ? (symbols[node.content] ?? symbols[`up${node.content}`]) : undefined
                if (symbol !== undefined) {
                    return symbol
                }
                return `\\${node.content}` + (node.args?.map(arg => `${arg.openMark}${labelContentToStr(arg.content, inMath)}${arg.closeMark}`).join('') ?? '')
            }
            case 'inlinemath':
            case 'displaymath':
                return labelContentToStr(node.content, true)
            case 'group':
                return labelContentToStr(node.content, inMath)
            default:
                return argContentToStr([node])
        }
    }).join('')
}

export function sanitizeLabel(content: Ast.Node[]): string {
    return labelContentToStr(content).replace(/\s+/g, ' ').trim()
}
