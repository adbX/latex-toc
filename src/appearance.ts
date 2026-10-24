import { ranks, type Rank } from './model.js'

const coreRanks = ['chapter', 'section', 'subsection', 'subsubsection'] as const
type CoreRank = typeof coreRanks[number]
export type PaletteColors = Readonly<Record<CoreRank, string> & Partial<Record<Rank, string>>>

export interface Palette {
    readonly version: 1
    readonly name: string
    readonly light: PaletteColors
    readonly dark?: PaletteColors
}

export interface AppearanceInput {
    readonly indentPx?: unknown
    readonly palette?: unknown
    readonly visibleRanks?: unknown
    readonly lightOverrides?: unknown
    readonly darkOverrides?: unknown
}

export interface AppearanceState {
    readonly indentPx: number
    readonly requestedPalette: string
    readonly resolvedPalette: string
    readonly colors: { readonly light: Record<Rank, string>; readonly dark: Record<Rank, string> }
    readonly visibleRanks: readonly Rank[]
    readonly notice?: string
}

export const paletteLimitBytes = 65_536
export const defaultVisibleRanks: readonly Rank[] = Object.freeze([...coreRanks])
export const builtinPalette: Palette = Object.freeze({
    version: 1,
    name: 'purple-red-green-muted',
    light: Object.freeze({ chapter: '#3c2a62ff', section: '#984620ff', subsection: '#135043ff', subsubsection: '#131313ff' }),
    dark: Object.freeze({ chapter: '#c5b4e3ff', section: '#e3b09aff', subsection: '#9dcbbbff', subsubsection: '#cececeff' }),
})

function object(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)
        || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
        throw new Error(`${label} must be an object`)
    }
    return value as Record<string, unknown>
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) throw new Error(`${label} contains an unsupported field: ${key}`)
    }
}

function isRank(value: unknown): value is Rank {
    return typeof value === 'string' && (ranks as readonly string[]).includes(value)
}

function color(value: unknown): string {
    if (typeof value !== 'string' || !/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})(?![\s\S])/i.test(value)) {
        throw new Error('Colors must be hex values with 3, 4, 6, or 8 digits')
    }
    let hex = value.slice(1).toLowerCase()
    if (hex.length <= 4) hex = [...hex].map(digit => digit + digit).join('')
    return `#${hex.length === 6 ? hex + 'ff' : hex}`
}

function colorMap(value: unknown, required: boolean): Partial<Record<Rank, string>> {
    const source = object(value, 'Rank colors')
    onlyKeys(source, ranks, 'Rank colors')
    if (required && coreRanks.some(rank => !Object.hasOwn(source, rank))) {
        throw new Error('Each palette branch requires chapter, section, subsection, and subsubsection colors')
    }
    const result: Partial<Record<Rank, string>> = {}
    for (const rank of ranks) {
        if (Object.hasOwn(source, rank) && (required || source[rank] !== null)) result[rank] = color(source[rank])
    }
    return result
}

export function paletteName(value: unknown): string {
    if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
        throw new Error('Palette names must be text without control characters')
    }
    const name = value.trim()
    if (!name || name.length > 80) throw new Error('Palette names must contain 1–80 characters')
    return name
}

export function isBuiltInName(name: string): boolean {
    return name.trim().toLowerCase() === builtinPalette.name.toLowerCase()
}

export function parsePalette(value: unknown): Palette {
    const source = object(value, 'Palette')
    onlyKeys(source, ['version', 'name', 'light', 'dark'], 'Palette')
    if (source.version !== 1) throw new Error('Palette version must be 1')
    const name = paletteName(source.name)
    const light = colorMap(source.light, true) as PaletteColors
    if (Object.hasOwn(source, 'dark')) {
        return { version: 1, name, light, dark: colorMap(source.dark, true) as PaletteColors }
    }
    return { version: 1, name, light }
}

export function parsePaletteBytes(bytes: Uint8Array): Palette {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > paletteLimitBytes) {
        throw new Error(`Palette imports must not exceed ${paletteLimitBytes} bytes`)
    }
    let value: unknown
    try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch {
        throw new Error('Palette import must contain valid UTF-8 JSON')
    }
    return parsePalette(value)
}

function validatedLibrary(library: readonly Palette[]): Palette[] {
    const names = new Set<string>()
    return library.map(value => {
        const palette = parsePalette(value)
        const key = palette.name.toLowerCase()
        if (isBuiltInName(key)) throw new Error('The built-in palette cannot be overwritten')
        if (names.has(key)) throw new Error(`Duplicate palette name: ${palette.name}`)
        names.add(key)
        return palette
    })
}

/** Returns a new, fully validated library; failures never modify the original. */
export function putPalette(library: readonly Palette[], value: Palette, replace = false): Palette[] {
    const palette = parsePalette(value)
    if (isBuiltInName(palette.name)) throw new Error('The built-in palette cannot be overwritten; choose another name')
    const result = validatedLibrary(library)
    const index = result.findIndex(item => item.name.toLowerCase() === palette.name.toLowerCase())
    if (index !== -1 && !replace) throw new Error(`A palette named “${palette.name}” already exists`)
    if (index === -1) result.push(palette)
    else result[index] = palette
    return result
}

function visibleRanks(value: unknown): readonly Rank[] {
    if (value === undefined) return [...defaultVisibleRanks]
    if (!Array.isArray(value)) throw new Error('Visible ranks must be a unique list of supported ranks')
    const result: Rank[] = []
    for (const rank of value) {
        if (!isRank(rank) || result.includes(rank)) throw new Error('Visible ranks must be a unique list of supported ranks')
        result.push(rank)
    }
    return result
}

function indent(value: unknown): number {
    if (value === undefined) return 16
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 8 || value > 32) {
        throw new Error('Indentation must be an integer from 8 to 32 pixels')
    }
    return value
}

function effectiveColors(branch: PaletteColors, overrides: Partial<Record<Rank, string>>): Record<Rank, string> {
    const chapter = overrides.chapter ?? branch.chapter
    const subsubsection = overrides.subsubsection ?? branch.subsubsection
    return {
        part: overrides.part ?? branch.part ?? chapter,
        chapter,
        section: overrides.section ?? branch.section,
        subsection: overrides.subsection ?? branch.subsection,
        subsubsection,
        paragraph: overrides.paragraph ?? branch.paragraph ?? subsubsection,
        subparagraph: overrides.subparagraph ?? branch.subparagraph ?? subsubsection,
    }
}

export function resolveAppearance(input: AppearanceInput, library: readonly Palette[]): AppearanceState {
    const indentPx = indent(input.indentPx)
    const requestedPalette = input.palette === undefined ? builtinPalette.name : paletteName(input.palette)
    const selected = isBuiltInName(requestedPalette) ? builtinPalette
        : validatedLibrary(library).find(palette => palette.name.toLowerCase() === requestedPalette.toLowerCase())
    const palette = selected ?? builtinPalette
    const notices: string[] = []
    if (!selected) notices.push(`Palette “${requestedPalette}” is unavailable; using “${builtinPalette.name}”.`)
    if (!palette.dark) notices.push(`Palette “${palette.name}” has no dark branch; using the built-in dark colors.`)
    return {
        indentPx,
        requestedPalette,
        resolvedPalette: palette.name,
        colors: {
            light: effectiveColors(palette.light, colorMap(input.lightOverrides === undefined ? {} : input.lightOverrides, false)),
            dark: effectiveColors(palette.dark ?? builtinPalette.dark!, colorMap(input.darkOverrides === undefined ? {} : input.darkOverrides, false)),
        },
        visibleRanks: visibleRanks(input.visibleRanks),
        ...(notices.length ? { notice: notices.join(' ') } : {}),
    }
}

export const defaultAppearance: AppearanceState = resolveAppearance({}, [])

/** Validate the host/webview boundary, including colors before they reach CSS. */
export function isAppearanceState(value: unknown): value is AppearanceState {
    try {
        const state = object(value, 'Appearance')
        onlyKeys(state, ['indentPx', 'requestedPalette', 'resolvedPalette', 'colors', 'visibleRanks', 'notice'], 'Appearance')
        if (state.indentPx === undefined || indent(state.indentPx) !== state.indentPx) return false
        if (paletteName(state.requestedPalette) !== state.requestedPalette || paletteName(state.resolvedPalette) !== state.resolvedPalette) return false
        if (state.visibleRanks === undefined) return false
        visibleRanks(state.visibleRanks)
        if (Object.hasOwn(state, 'notice') && typeof state.notice !== 'string') return false
        const colors = object(state.colors, 'Appearance colors')
        onlyKeys(colors, ['light', 'dark'], 'Appearance colors')
        for (const theme of ['light', 'dark']) {
            const branch = object(colors[theme], 'Appearance branch')
            onlyKeys(branch, ranks, 'Appearance branch')
            for (const rank of ranks) {
                if (!Object.hasOwn(branch, rank) || color(branch[rank]) !== branch[rank]) return false
            }
        }
        return true
    } catch {
        return false
    }
}

/** Aliases use the parser's existing star, optional short title, mandatory title signature. */
export function parseSectionCommands(value: unknown): Record<string, Rank> {
    if (value === undefined) return {}
    const source = object(value, 'Section commands')
    const protectedCommands = [
        ...ranks, 'documentclass', 'setcounter', 'appendix', 'input', 'include', 'caption',
        'begin', 'end', 'verb', 'newcommand', 'renewcommand', 'providecommand', 'def', 'gdef', 'edef', 'xdef', 'let',
    ]
    const result: Record<string, Rank> = {}
    for (const [command, rank] of Object.entries(source)) {
        if (!/^[A-Za-z]+(?![\s\S])/.test(command)) {
            throw new Error('Section aliases must contain only ASCII letters, without a leading backslash')
        }
        if (protectedCommands.includes(command)) throw new Error(`Section aliases cannot replace the built-in command: ${command}`)
        if (!isRank(rank)) throw new Error(`Section alias “${command}” must map to a supported rank`)
        result[command] = rank
    }
    return result
}
