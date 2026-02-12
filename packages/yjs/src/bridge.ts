import type { Node } from 'prosemirror-model'
import type { Transaction } from 'prosemirror-state'
import { prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorRootNode, ySyncPluginKey } from 'y-prosemirror'
import type { Doc, Text as YText, XmlFragment as YXmlFragment } from 'yjs'
import type { Normalize, OnError } from '@pm-cm/core'
import type { BootstrapResult, YjsBridgeConfig, YjsBridgeHandle } from './types.js'
import { ORIGIN_INIT, ORIGIN_TEXT_TO_PM, ORIGIN_PM_TO_TEXT } from './types.js'

const defaultNormalize: Normalize = (s) => s.replace(/\r\n?/g, '\n')
const defaultOnError: OnError = (event) => console.error(`[bridge] ${event.code}: ${event.message}`, event.cause)

/** Result of {@link replaceSharedText}. */
export type ReplaceTextResult =
  | { ok: true }
  | { ok: false; reason: 'unchanged' }
  | { ok: false; reason: 'detached' }

/** Result of {@link replaceSharedProseMirror}. */
export type ReplaceProseMirrorResult =
  | { ok: true }
  | { ok: false; reason: 'parse-error' }
  | { ok: false; reason: 'detached' }

/**
 * Union of all replace-result types. Kept for backward compatibility.
 * Prefer the narrower {@link ReplaceTextResult} / {@link ReplaceProseMirrorResult}.
 */
export type ReplaceResult = ReplaceTextResult | ReplaceProseMirrorResult

/**
 * Replace `Y.Text` content using a minimal diff (common prefix/suffix trimming).
 * Returns a {@link ReplaceResult} indicating success or failure reason.
 */
export function replaceSharedText(
  sharedText: YText,
  next: string,
  origin: unknown,
  normalize: Normalize = defaultNormalize,
): ReplaceTextResult {
  if (!sharedText.doc) {
    return { ok: false, reason: 'detached' }
  }

  const normalized = normalize(next)
  const current = sharedText.toString()
  if (current === normalized) {
    return { ok: false, reason: 'unchanged' }
  }

  // Minimal diff: find common prefix and suffix, replace only the changed middle.
  let start = 0
  const minLen = Math.min(current.length, normalized.length)
  while (start < minLen && current.charCodeAt(start) === normalized.charCodeAt(start)) {
    start++
  }

  let endCurrent = current.length
  let endNext = normalized.length
  while (endCurrent > start && endNext > start && current.charCodeAt(endCurrent - 1) === normalized.charCodeAt(endNext - 1)) {
    endCurrent--
    endNext--
  }

  sharedText.doc.transact(() => {
    const deleteCount = endCurrent - start
    if (deleteCount > 0) {
      sharedText.delete(start, deleteCount)
    }
    const insertStr = normalized.slice(start, endNext)
    if (insertStr.length > 0) {
      sharedText.insert(start, insertStr)
    }
  }, origin)

  return { ok: true }
}

/**
 * Replace `Y.XmlFragment` by parsing serialized text into a ProseMirror document.
 * Returns a {@link ReplaceResult} indicating success or failure reason.
 */
export function replaceSharedProseMirror(
  doc: Doc,
  fragment: YXmlFragment,
  text: string,
  origin: unknown,
  config: Pick<YjsBridgeConfig, 'schema' | 'parse' | 'normalize' | 'onError'>,
): ReplaceProseMirrorResult {
  if (!fragment.doc) {
    return { ok: false, reason: 'detached' }
  }
  if (fragment.doc !== doc) {
    throw new Error('fragment belongs to a different Y.Doc than the provided doc')
  }

  const normalize = config.normalize ?? defaultNormalize
  const onError = config.onError ?? defaultOnError
  let nextDoc: Node
  try {
    nextDoc = config.parse(normalize(text), config.schema)
  } catch (error) {
    onError({ code: 'parse-error', message: 'failed to parse text into ProseMirror document', cause: error })
    return { ok: false, reason: 'parse-error' }
  }

  doc.transact(() => {
    prosemirrorToYXmlFragment(nextDoc, fragment)
  }, origin)
  return { ok: true }
}

/** Options for {@link createYjsBridge}. */
export type YjsBridgeOptions = {
  initialText?: string
  /** Which side wins when both sharedText and sharedProseMirror exist and differ. Default `'text'`. */
  prefer?: 'text' | 'prosemirror'
}

/**
 * Create a collaborative bridge that keeps `Y.Text` and `Y.XmlFragment` in sync.
 *
 * Runs a synchronous bootstrap to reconcile existing state, then installs a
 * `Y.Text` observer for the text → ProseMirror direction.
 *
 * @throws If `sharedText` or `sharedProseMirror` belong to a different `Y.Doc`.
 */
export function createYjsBridge(
  config: YjsBridgeConfig,
  options?: YjsBridgeOptions,
): YjsBridgeHandle {
  const {
    doc,
    sharedText,
    sharedProseMirror,
    schema,
    serialize,
    parse,
  } = config
  const normalize = config.normalize ?? defaultNormalize
  const onError = config.onError ?? defaultOnError

  if (!sharedText.doc) {
    throw new Error('sharedText is not attached to any Y.Doc')
  }
  if (sharedText.doc !== doc) {
    throw new Error('sharedText belongs to a different Y.Doc than the provided doc')
  }
  if (!sharedProseMirror.doc) {
    throw new Error('sharedProseMirror is not attached to any Y.Doc')
  }
  if (sharedProseMirror.doc !== doc) {
    throw new Error('sharedProseMirror belongs to a different Y.Doc than the provided doc')
  }

  let lastBridgedText: string | null = null

  /** Returns `true` if the parse succeeded. */
  const syncTextToProsemirror = (origin: unknown): boolean => {
    const text = normalize(sharedText.toString())
    if (lastBridgedText === text) {
      return true
    }

    const result = replaceSharedProseMirror(doc, sharedProseMirror, text, origin, {
      schema,
      parse,
      normalize,
      onError,
    })
    if (result.ok) {
      lastBridgedText = text
    }
    return result.ok
  }

  const sharedProseMirrorToText = (fragment: YXmlFragment): string | null => {
    try {
      const pmDoc = yXmlFragmentToProseMirrorRootNode(fragment, schema)
      return normalize(serialize(pmDoc))
    } catch (error) {
      onError({ code: 'serialize-error', message: 'failed to convert ProseMirror fragment to text', cause: error })
      return null
    }
  }

  // Bootstrap
  const bootstrap = (): BootstrapResult => {
    const text = normalize(sharedText.toString())
    const hasText = text.length > 0
    const hasProsemirror = sharedProseMirror.length > 0

    if (!hasText && !hasProsemirror) {
      const initial = options?.initialText ?? ''
      if (initial.length > 0) {
        // Set Y.XmlFragment first, then derive Y.Text from serialize(parse(initial))
        // to ensure both shared types are in the same canonical form.
        const initResult = replaceSharedProseMirror(doc, sharedProseMirror, initial, ORIGIN_INIT, {
          schema,
          parse,
          normalize,
          onError,
        })
        if (!initResult.ok) {
          return { source: 'initial', parseError: true }
        }
        const pmDoc = yXmlFragmentToProseMirrorRootNode(sharedProseMirror, schema)
        const canonicalText = serialize(pmDoc)
        replaceSharedText(sharedText, canonicalText, ORIGIN_INIT, normalize)
        lastBridgedText = normalize(canonicalText)
        return { source: 'initial' }
      }
      return { source: 'empty' }
    }

    if (hasText && !hasProsemirror) {
      const ok = syncTextToProsemirror(ORIGIN_INIT)
      return { source: 'text', ...(!ok && { parseError: true }) }
    }

    if (!hasText && hasProsemirror) {
      const textFromProsemirror = sharedProseMirrorToText(sharedProseMirror)
      if (textFromProsemirror !== null) {
        replaceSharedText(sharedText, textFromProsemirror, ORIGIN_INIT, normalize)
        lastBridgedText = normalize(textFromProsemirror)
        return { source: 'prosemirror' }
      }
      return { source: 'prosemirror', parseError: true }
    }

    const prosemirrorText = sharedProseMirrorToText(sharedProseMirror)
    if (prosemirrorText === null) {
      const fallbackText = hasText ? text : (options?.initialText ?? '')
      let parseError = false
      if (fallbackText.length > 0) {
        replaceSharedText(sharedText, fallbackText, ORIGIN_INIT, normalize)
        const fallbackResult = replaceSharedProseMirror(doc, sharedProseMirror, fallbackText, ORIGIN_INIT, {
          schema,
          parse,
          normalize,
          onError,
        })
        if (!fallbackResult.ok) parseError = true
      }
      return { source: 'text', ...(parseError && { parseError: true }) }
    }

    if (prosemirrorText !== text) {
      const prefer = options?.prefer ?? 'text'
      if (prefer === 'prosemirror') {
        replaceSharedText(sharedText, prosemirrorText, ORIGIN_INIT, normalize)
        lastBridgedText = normalize(prosemirrorText)
        return { source: 'prosemirror' }
      } else {
        const ok = syncTextToProsemirror(ORIGIN_INIT)
        return { source: 'text', ...(!ok && { parseError: true }) }
      }
    } else {
      lastBridgedText = text
      return { source: 'both-match' }
    }
  }

  const textObserver = (
    _: unknown,
    transaction: { origin: unknown },
  ) => {
    if (transaction.origin === ORIGIN_PM_TO_TEXT || transaction.origin === ORIGIN_INIT) {
      return
    }

    syncTextToProsemirror(ORIGIN_TEXT_TO_PM)
  }

  // Run bootstrap synchronously before installing the observer so that
  // an exception during bootstrap cannot leave a dangling observer.
  const bootstrapResult = bootstrap()

  sharedText.observe(textObserver)

  return {
    bootstrapResult,
    syncToSharedText(doc: Node): ReplaceTextResult {
      const text = serialize(doc)
      const result = replaceSharedText(sharedText, text, ORIGIN_PM_TO_TEXT, normalize)
      // Always update lastBridgedText unless truly failed (detached).
      // 'unchanged' means Y.Text already has this content — still need to
      // record it so the reverse observer doesn't trigger a redundant sync.
      if (result.ok || result.reason === 'unchanged') {
        lastBridgedText = normalize(text)
      }
      return result
    },
    isYjsSyncChange(tr: Transaction): boolean {
      // Internal meta shape from y-prosemirror's ySyncPlugin (tested against ^1.3.x).
      const meta = tr.getMeta(ySyncPluginKey)
      return (
        typeof meta === 'object' &&
        meta !== null &&
        'isChangeOrigin' in meta &&
        (meta as Record<string, unknown>).isChangeOrigin === true
      )
    },
    dispose() {
      sharedText.unobserve(textObserver)
    },
  }
}
