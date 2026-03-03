import type { Node } from 'prosemirror-model'
import type { Transaction } from 'prosemirror-state'
import { prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorRootNode, ySyncPluginKey } from 'y-prosemirror'
import type { Doc, Text as YText, XmlFragment as YXmlFragment } from 'yjs'
import type { Normalize, OnError } from '@pm-cm/core'
import type { BootstrapResult, YjsBridgeConfig, YjsBridgeHandle } from './types.js'
import { ORIGIN_INIT, ORIGIN_TEXT_TO_PM, ORIGIN_PM_TO_TEXT } from './types.js'

const defaultNormalize: Normalize = (s) => s.replace(/\r\n?/g, '\n')
const defaultOnError: OnError = (event) => console.error(`[bridge] ${event.code}: ${event.message}`, event.cause)

/**
 * Check whether any type modified in the transaction belongs to the
 * given XmlFragment subtree (the fragment itself or any descendant).
 *
 * Uses the Yjs internal `_item.parent` chain which has been stable
 * across the 13.x series and is also relied on by y-prosemirror.
 */
function transactionTouchedXmlFragment(
  changed: Map<object, Set<string | null>>,
  xmlFragment: YXmlFragment,
): boolean {
  for (const type of changed.keys()) {
    if (type === xmlFragment) return true
    // Walk the parent chain from the changed type up to the root.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let item = (type as any)._item
    while (item) {
      if (item.parent === xmlFragment) return true
      item = item.parent?._item ?? null
    }
  }
  return false
}

/** Result of {@link replaceSharedText}. */
export type ReplaceTextResult =
  | { ok: true }
  | { ok: false; reason: 'unchanged' }
  | { ok: false; reason: 'detached' }
  | { ok: false; reason: 'serialize-error' }
  | { ok: false; reason: 'skip-pending' }
  | { ok: false; reason: 'parse-failed' }

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
  const skipOrigins = config.skipOrigins ?? null

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

  // Manages the deferred fallback for skipOrigins: an XmlFragment observer
  // detects when the expected remote update arrives (cancelling the fallback),
  // and a timeout fires the fallback only if the update never arrives.
  let pendingSkipCleanup: (() => void) | null = null

  // When true, syncToSharedText is blocked. Set during the skip window
  // (between a skipOrigins Y.Text change and the paired XmlFragment update)
  // to prevent stale PM content from overwriting newer Y.Text.
  let skipPending = false

  // When true, syncToSharedText is blocked because the last
  // syncTextToProsemirror failed to parse. PM is stale and must not
  // overwrite newer Y.Text content. Cleared on the next successful parse
  // or when a transaction touches both Y.Text and XmlFragment (ySyncPlugin
  // handles the XmlFragment → PM direction in that case).
  let parseFailed = false

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
      parseFailed = false
      // Canonicalize only during bootstrap (ORIGIN_INIT).
      //
      // During live editing the text may be in an intermediate state where
      // serialize(parse(text)) !== text (e.g. partially typed syntax that the
      // parser interprets differently from the user's intent). Writing the
      // canonical form back to Y.Text in that situation corrupts the document
      // and can trigger reentrant updates in editor view-plugins that observe
      // Y.Text changes.
      //
      // At bootstrap time the text is well-formed (loaded from persistence),
      // so the round-trip is idempotent and canonicalization ensures both
      // shared types agree for future bridge mounts (`both-match`).
      let canonical = text
      if (origin === ORIGIN_INIT) {
        try {
          const pmDoc = yXmlFragmentToProseMirrorRootNode(sharedProseMirror, schema)
          canonical = normalize(serialize(pmDoc))
          if (canonical !== text) {
            replaceSharedText(sharedText, canonical, ORIGIN_INIT, normalize)
          }
        } catch {
          // Serialization failure during canonicalization is non-fatal;
          // fall back to using the original text as lastBridgedText.
        }
      }
      lastBridgedText = canonical
    } else {
      parseFailed = true
      // Parse failed — still update lastBridgedText to prevent the
      // textObserver from re-attempting the same failed parse on every
      // Y.Text change. PM→Y.Text writes are blocked by the parseFailed
      // flag until the next successful syncTextToProsemirror.
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
        let canonicalText: string
        try {
          canonicalText = serialize(pmDoc)
        } catch (error) {
          onError({ code: 'serialize-error', message: 'failed to serialize ProseMirror document during bootstrap', cause: error })
          return { source: 'initial', parseError: true }
        }
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
        lastBridgedText = normalize(fallbackText)
        const fallbackResult = replaceSharedProseMirror(doc, sharedProseMirror, fallbackText, ORIGIN_INIT, {
          schema,
          parse,
          normalize,
          onError,
        })
        if (!fallbackResult.ok) {
          parseError = true
          // Block PM→Y.Text writes — PM is stale (XmlFragment wasn't
          // updated because parse failed). Without this, a subsequent
          // PM edit can overwrite the authoritative Y.Text content.
          parseFailed = true
        }
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
    transaction: { origin: unknown; changed: Map<object, Set<string | null>> },
  ) => {
    if (transaction.origin === ORIGIN_PM_TO_TEXT || transaction.origin === ORIGIN_INIT) {
      return
    }

    // When the same transaction also modified the XmlFragment subtree
    // (e.g. a remote Y.Doc update applied via Y.applyUpdate that modified
    // both shared types atomically), ySyncPlugin already handles the
    // XmlFragment → PM direction. Calling syncTextToProsemirror would
    // redundantly reconstruct the XmlFragment via prosemirrorToYXmlFragment,
    // destroying existing Yjs Item IDs and invalidating cursor
    // RelativePositions held by peers in Awareness state.
    if (transactionTouchedXmlFragment(transaction.changed, sharedProseMirror)) {
      lastBridgedText = normalize(sharedText.toString())
      // XmlFragment was also updated in this transaction — ySyncPlugin
      // handles the XmlFragment → PM direction, so PM is up to date.
      // Clear parseFailed since PM is no longer stale.
      parseFailed = false
      return
    }

    // When multiple clients run a bridge, a remote Y.Text change and its
    // corresponding Y.XmlFragment change arrive as separate transactions.
    // Writing to XmlFragment here would race with the remote XmlFragment
    // update, causing the CRDT to keep both insertions (duplicate nodes).
    // Skip the sync and let the remote XmlFragment update handle it.
    //
    // Event-driven fallback: install a one-shot XmlFragment observer to
    // detect when the expected update arrives (cancelling the fallback).
    // A timeout fires the fallback only if no XmlFragment change arrives,
    // preventing PM from becoming permanently stale when the sender is
    // a text-only producer or the XmlFragment update was lost.
    if (skipOrigins !== null && skipOrigins.has(transaction.origin)) {
      const expectedText = normalize(sharedText.toString())
      lastBridgedText = expectedText

      // If XmlFragment already matches the expected text (e.g., the paired
      // XmlFragment update arrived before the Y.Text update), no skip
      // window is needed — XmlFragment is already caught up.
      const pmTextNow = sharedProseMirrorToText(sharedProseMirror)
      if (pmTextNow !== null && normalize(pmTextNow) === expectedText) {
        parseFailed = false
        // Clean up any previous pending skip fallback so its skipPending
        // doesn't remain latched after this early return.
        if (pendingSkipCleanup) pendingSkipCleanup()
        return
      }

      // Snapshot XmlFragment state at skip start. The fallback uses this
      // to detect whether XmlFragment was modified during the skip window
      // (by ySyncPlugin or local PM edits). If modified, the fallback
      // must NOT overwrite XmlFragment with older Y.Text content.
      const xmlTextAtSkipStart = pmTextNow

      // Cancel any previous pending skip fallback BEFORE setting skipPending,
      // because the previous cleanup sets skipPending = false.
      if (pendingSkipCleanup) pendingSkipCleanup()
      skipPending = true

      let resolved = false

      const resolve = () => {
        if (resolved) return
        resolved = true
        skipPending = false
        sharedProseMirror.unobserveDeep(xmlCatchUpObserver)
        clearTimeout(timer)
        pendingSkipCleanup = null
      }

      // Observe deep XmlFragment changes to detect when the expected
      // remote update arrives. Requires BOTH origin match AND content
      // verification: origin alone is coarse (shared across peers) and
      // could match an unrelated update, prematurely unblocking stale
      // PM→Y.Text writes. Content verification ensures the XmlFragment
      // has actually caught up to the expected text. When parse/serialize
      // is non-idempotent (content never matches), the timeout fallback
      // handles it.
      const xmlCatchUpObserver = (
        _events: unknown[],
        transaction: { origin: unknown },
      ) => {
        if (resolved) return
        if (skipOrigins!.has(transaction.origin)) {
          const pmText = sharedProseMirrorToText(sharedProseMirror)
          if (pmText !== null && normalize(pmText) === expectedText) {
            // XmlFragment caught up — ySyncPlugin updates PM, so
            // PM is no longer stale from any prior parse failure.
            parseFailed = false
            resolve()
          }
        }
      }

      const runFallback = () => {
        resolve()
        // Guard: if text has changed since, a newer update superseded this one.
        if (lastBridgedText !== expectedText) return
        // Verify XmlFragment caught up by comparing its serialized form.
        const pmText = sharedProseMirrorToText(sharedProseMirror)
        if (pmText === null || normalize(pmText) !== expectedText) {
          // If XmlFragment was modified during the skip window (by
          // ySyncPlugin applying remote updates or by local PM edits),
          // the current state is authoritative — do NOT overwrite with
          // older Y.Text content. Update lastBridgedText and let the
          // normal bridge flow reconcile via syncToSharedText.
          //
          // Three cases detect modification:
          // 1. XmlFragment content differs from the snapshot at skip start.
          // 2. XmlFragment was unserializable at skip start but is now
          //    serializable — something changed its structure.
          // 3. XmlFragment was serializable at skip start but is now
          //    unserializable — structure was modified in a breaking way.
          const changedDuringSkip =
            (xmlTextAtSkipStart !== null && pmText !== null && normalize(pmText) !== normalize(xmlTextAtSkipStart))
            || (xmlTextAtSkipStart === null && pmText !== null)
            || (xmlTextAtSkipStart !== null && pmText === null)
          if (changedDuringSkip) {
            lastBridgedText = pmText !== null ? normalize(pmText) : lastBridgedText
            // Do NOT clear parseFailed here. XmlFragment changed but
            // hasn't caught up to expectedText — PM may be at an
            // intermediate state. Keeping parseFailed blocks stale
            // PM→Y.Text writes until a new Y.Text change triggers
            // a successful syncTextToProsemirror.
            return
          }
          // XmlFragment unchanged since skip start — truly stale
          // (paired XmlFragment never arrived). Sync Y.Text → XmlFragment.
          lastBridgedText = null
          syncTextToProsemirror(ORIGIN_TEXT_TO_PM)
        }
      }

      const timer = setTimeout(runFallback, 500)

      sharedProseMirror.observeDeep(xmlCatchUpObserver)
      pendingSkipCleanup = resolve
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
      // Block PM→Y.Text writes during the skip window to prevent stale
      // PM content from overwriting newer Y.Text. The skip is resolved
      // when the paired XmlFragment update arrives (observer) or by the
      // timeout fallback.
      if (skipPending) {
        return { ok: false, reason: 'skip-pending' }
      }
      // Block PM→Y.Text writes when the last Y.Text→PM parse failed.
      // PM is stale and writing it back would resurrect deleted content.
      // Cleared on the next successful syncTextToProsemirror.
      if (parseFailed) {
        return { ok: false, reason: 'parse-failed' }
      }
      let text: string
      try {
        text = serialize(doc)
      } catch (error) {
        onError({ code: 'serialize-error', message: 'failed to serialize ProseMirror document', cause: error })
        return { ok: false, reason: 'serialize-error' }
      }
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
      if (pendingSkipCleanup) pendingSkipCleanup()
    },
  }
}
