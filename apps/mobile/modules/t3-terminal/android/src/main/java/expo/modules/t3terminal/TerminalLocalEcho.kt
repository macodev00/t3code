package expo.modules.t3terminal

/**
 * Paints printable Android keystrokes before the remote pty echoes them.
 *
 * The surface otherwise waits for a full attach round trip before Ghostty
 * can draw, so every character feels late on a phone. Only bytes a cooked
 * shell echoes unchanged are painted ahead. Controls, pastes, and secret
 * prompts stay on the remote path. Prediction stops once the unconfirmed
 * tail would pass [MAX_PENDING_INPUT]. If the pty byte stream contradicts a
 * prediction, the grid is rebuilt from that stream and local echo stays off
 * until a later keystroke is echoed verbatim.
 */
internal object TerminalLocalEcho {
  /** One IME delivery longer than this is a paste, not typing. */
  private const val MAX_PREDICTABLE_INPUT = 64

  /**
   * Cap for input the pty has not echoed yet. The untrusted probe is dropped
   * past this size. A trusted session stops painting once another key would
   * pass it; that key stays in pendingInput until the pty echoes it.
   */
  internal const val MAX_PENDING_INPUT = 256

  private val OSC = Regex("\u001B\\][^\u0007]*(?:\u0007|\u001B\\\\)")
  private val CSI = Regex("\u001B\\[[0-9:;<=>?]*[ -/]*[@-~]")
  private val SIMPLE_ESC = Regex("\u001B[@-Z\\-_]")

  /**
   * Secret prompt on the current line. The keyword starts the line or follows
   * whitespace or an opening bracket, and the line ends with `:`. That covers
   * `Passcode:` and `PIN:` plus prompts whose colon is not the first one
   * (`Password for 'https://…':`, `Enter passphrase (empty for no passphrase):`)
   * without treating a path such as `~/pin:` as a prompt.
   */
  private val PASSWORD_PROMPT = Regex(
    "(?i)(?:^|[\\s\\[('\"])(?:pass(?:word|phrase|code)|pass phrase|pin)\\b[^\\n\\r]*:\\s*$",
  )

  /**
   * Returns [input] when it is a short run of characters a cooked shell
   * echoes unchanged, or null when the pty must be allowed to interpret it.
   */
  fun predictableEcho(input: String): String? {
    if (!isPredictableEcho(input)) return null
    return input
  }

  /**
   * Records [input] and, when it is safe, returns the bytes to paint now.
   * [canPaint] is false until the native terminal exists; the key is still
   * sent to the pty by the caller. A trusted prediction that would grow past
   * [MAX_PENDING_INPUT] is not painted.
   */
  fun noteLocalInput(
    state: TerminalEchoState,
    input: String,
    canPaint: Boolean
  ): LocalEchoDecision {
    val echo = predictableEcho(input)
    if (echo == null || !canPaintAhead(state, echo, canPaint)) {
      return skipPaint(state, echo, input, canPaint)
    }
    return LocalEchoDecision(
      paint = echo,
      state = state.copy(
        pendingInput = state.pendingInput + echo,
        predicted = state.predicted + echo,
      ),
    )
  }

  /**
   * Folds the authoritative pty buffer into [state]. A confirmed prediction
   * produces no further bytes to feed. A contradiction rebuilds from [remote].
   * [TerminalBufferSync.Reset.replyFrom] marks where device replies may resume.
   */
  fun applyRemoteBuffer(state: TerminalEchoState, remote: String): TerminalBufferSync {
    if (!remote.startsWith(state.confirmed)) {
      return resetTo(
        remote,
        echoTrusted = state.echoTrusted,
        replyFrom = retainedHistoryLength(state.confirmed, remote),
      )
    }
    val suffix = remote.substring(state.confirmed.length)
    val withOutput = state.copy(
      hasRemoteOutput = remote.isNotEmpty(),
      awaitingRemote = stillAwaitingRemote(state, suffix),
    )
    return if (withOutput.predicted.isEmpty()) {
      syncUnpredicted(withOutput, remote, suffix)
    } else {
      syncPredicted(withOutput, remote, suffix)
    }
  }

  /**
   * True when the current pty line asks for a secret (password, passphrase,
   * passcode, or PIN). Those prompts run with echo disabled, so painting the
   * key would reveal it until the next remote frame. The whole current line
   * is inspected so a long prompt cannot drop the leading keyword.
   */
  fun looksLikePasswordPrompt(buffer: String): Boolean {
    if (buffer.isEmpty()) return false
    val line = stripAnsi(
      buffer.substringAfterLast('\n').substringAfterLast('\r'),
    ).trimEnd()
    return PASSWORD_PROMPT.containsMatchIn(line)
  }

  /**
   * True for space and other non-control characters. C0/C1 controls and DEL
   * are excluded because the pty may swallow or expand them.
   */
  private fun isEchoableCodePoint(codePoint: Int): Boolean =
    codePoint >= 0x20 && codePoint != 0x7F && codePoint !in 0x80..0x9F

  /** True when every code point in [input] is safe to paint ahead of the pty. */
  private fun isPredictableEcho(input: String): Boolean {
    if (input.isEmpty() || input.length > MAX_PREDICTABLE_INPUT) return false
    return codePointsAreEchoable(input)
  }

  /** True when [input] contains no C0/C1 control or DEL code point. */
  private fun codePointsAreEchoable(input: String): Boolean {
    var index = 0
    while (index < input.length) {
      val codePoint = input.codePointAt(index)
      if (!isEchoableCodePoint(codePoint)) return false
      index += Character.charCount(codePoint)
    }
    return true
  }

  /**
   * True when [echo] may be painted now. A missing surface, a cursor that is
   * not ready, or a prediction that would pass [MAX_PENDING_INPUT] stays on
   * the remote path.
   */
  private fun canPaintAhead(
    state: TerminalEchoState,
    echo: String,
    canPaint: Boolean
  ): Boolean {
    if (!canPaint || !shouldPaint(state)) return false
    return state.predicted.length + echo.length <= MAX_PENDING_INPUT
  }

  /**
   * Local echo is safe only after the pty has drawn a frame, echo has not
   * been contradicted, no control key is still in flight, every outstanding
   * byte is already on screen, and the cursor is not sitting on a secret prompt.
   */
  private fun shouldPaint(state: TerminalEchoState): Boolean {
    val cursorReady = state.hasRemoteOutput &&
      state.echoTrusted &&
      !state.awaitingRemote &&
      state.pendingInput == state.predicted
    return cursorReady && !looksLikePasswordPrompt(state.confirmed)
  }

  /**
   * Keeps a key that was not painted so a later verbatim echo can arm
   * prediction. A non-empty control holds painting until the pty answers,
   * because that key can move the cursor. Trusted keys refused at the
   * pending-input cap stay in [TerminalEchoState.pendingInput] so a later
   * partial echo cannot paint past them. Secrets and keys that arrived
   * before the surface was ready are not recorded as pending.
   */
  private fun skipPaint(
    state: TerminalEchoState,
    echo: String?,
    input: String,
    canPaint: Boolean
  ): LocalEchoDecision {
    val held = if (input.isNotEmpty() && echo == null) {
      state.copy(awaitingRemote = true)
    } else {
      state
    }
    val next = when {
      echo != null && shouldRetainTrustedCap(held, echo, canPaint) ->
        held.copy(pendingInput = held.pendingInput + echo)
      echo == null || held.echoTrusted -> held
      else -> held.copy(pendingInput = rememberPending(held.pendingInput, echo))
    }
    return LocalEchoDecision(paint = null, state = next)
  }

  /**
   * True when a trusted key was skipped only because painting it would grow
   * the predicted tail past [MAX_PENDING_INPUT].
   */
  private fun shouldRetainTrustedCap(
    state: TerminalEchoState,
    echo: String,
    canPaint: Boolean
  ): Boolean {
    if (!canPaint || !state.echoTrusted || !shouldPaint(state)) return false
    return state.predicted.length + echo.length > MAX_PENDING_INPUT
  }

  /**
   * A control key stays unanswered while the new pty bytes are only the
   * printable echo already recorded. `\r`/`\n` or other processing clears it.
   */
  private fun stillAwaitingRemote(state: TerminalEchoState, suffix: String): Boolean {
    val outstanding = outstandingPrintable(state)
    return state.awaitingRemote &&
      (suffix.isEmpty() || (outstanding.isNotEmpty() && outstanding.startsWith(suffix)))
  }

  /** Unconfirmed printable bytes the pty may still echo unchanged. */
  private fun outstandingPrintable(state: TerminalEchoState): String = when {
    state.pendingInput.startsWith(state.predicted) -> state.pendingInput
    state.predicted.startsWith(state.pendingInput) -> state.predicted
    else -> state.predicted.ifEmpty { state.pendingInput }
  }

  /** Drops the probe once it exceeds [MAX_PENDING_INPUT]. */
  private fun rememberPending(pending: String, echo: String): String {
    val combined = pending + echo
    if (combined.length > MAX_PENDING_INPUT) return ""
    return combined
  }

  /** Applies pty bytes that were not painted ahead of time. */
  private fun syncUnpredicted(
    state: TerminalEchoState,
    remote: String,
    suffix: String
  ): TerminalBufferSync {
    val learned = learnEcho(state.pendingInput, suffix)
    val next = state.copy(
      confirmed = remote,
      pendingInput = pendingAfterRemote(state.pendingInput, suffix, learned),
      echoTrusted = state.echoTrusted || learned.confirmedEcho,
    )
    if (suffix.isEmpty()) return TerminalBufferSync.InSync(next)
    return TerminalBufferSync.Feed(suffix, next)
  }

  /** Applies pty bytes while a local prediction is still on screen. */
  private fun syncPredicted(
    state: TerminalEchoState,
    remote: String,
    suffix: String
  ): TerminalBufferSync = when {
    suffix.isEmpty() || state.predicted.startsWith(suffix) ->
      confirmPredictedPrefix(state, remote, suffix)
    suffix.startsWith(state.predicted) ->
      confirmPredictedAndFeedRest(state, remote, suffix)
    else -> resetTo(remote, echoTrusted = false, replyFrom = state.confirmed.length)
  }

  /** The remote stream confirmed a prefix of what is already on screen. */
  private fun confirmPredictedPrefix(
    state: TerminalEchoState,
    remote: String,
    suffix: String
  ): TerminalBufferSync {
    if (suffix.isEmpty()) return TerminalBufferSync.InSync(state)
    return TerminalBufferSync.InSync(
      state.copy(
        confirmed = remote,
        predicted = state.predicted.substring(suffix.length),
        pendingInput = dropMatchedPrefix(state.pendingInput, suffix),
        echoTrusted = true,
      ),
    )
  }

  /** The prediction was echoed, and the pty sent more bytes after it. */
  private fun confirmPredictedAndFeedRest(
    state: TerminalEchoState,
    remote: String,
    suffix: String
  ): TerminalBufferSync {
    val extra = suffix.substring(state.predicted.length)
    val pending = dropMatchedPrefix(state.pendingInput, state.predicted)
    val learned = learnEcho(pending, extra)
    return TerminalBufferSync.Feed(
      extra,
      state.copy(
        confirmed = remote,
        predicted = "",
        pendingInput = pendingAfterRemote(pending, extra, learned),
        echoTrusted = true,
      ),
    )
  }

  /**
   * Consumes [pending] when [suffix] echoes it. Anything that is not that
   * echo is dropped, except when [suffix] is empty: the pty has not spoken
   * yet, so the probe stays armed.
   */
  private fun pendingAfterRemote(
    pending: String,
    suffix: String,
    learned: LearnedEcho
  ): String {
    if (suffix.isNotEmpty() && !learned.confirmedEcho) return ""
    return if (suffix.isEmpty()) pending else learned.pending
  }

  /** Matches [pending] against the front of a new pty suffix. */
  private fun learnEcho(pending: String, suffix: String): LearnedEcho = when {
    pending.isEmpty() || suffix.isEmpty() -> LearnedEcho(pending, confirmedEcho = false)
    suffix.startsWith(pending) -> LearnedEcho("", confirmedEcho = true)
    pending.startsWith(suffix) ->
      LearnedEcho(pending.substring(suffix.length), confirmedEcho = true)
    else -> LearnedEcho(pending, confirmedEcho = false)
  }

  /** Removes an echoed prefix, or forgets [pending] if it does not match. */
  private fun dropMatchedPrefix(pending: String, prefix: String): String = when {
    prefix.isEmpty() -> pending
    pending.startsWith(prefix) -> pending.substring(prefix.length)
    else -> ""
  }

  /**
   * Length of the longest suffix of [previous] that is a prefix of [remote].
   *
   * A scrollback trim drops the head of the pty buffer and may append new
   * bytes in the same update. That overlapping tail was already answered.
   * The scan is linear so a full scrollback does not compare quadratically
   * on the UI thread.
   */
  internal fun retainedHistoryLength(previous: String, remote: String): Int {
    val fast = when {
      previous.isEmpty() || remote.isEmpty() -> 0
      remote.startsWith(previous) -> previous.length
      else -> -1
    }
    if (fast >= 0) return fast
    val border = prefixBorder(remote)
    var matched = 0
    for (index in previous.indices) {
      while (matched > 0 && previous[index] != remote[matched]) {
        matched = border[matched - 1]
      }
      if (previous[index] == remote[matched]) {
        matched++
      }
      if (matched == remote.length && index != previous.lastIndex) {
        matched = border[matched - 1]
      }
    }
    return matched
  }

  /** Knuth-Morris-Pratt border table for [pattern]. */
  private fun prefixBorder(pattern: String): IntArray {
    val border = IntArray(pattern.length)
    var length = 0
    var index = 1
    while (index < pattern.length) {
      if (pattern[index] == pattern[length]) {
        length++
        border[index] = length
        index++
      } else if (length > 0) {
        length = border[length - 1]
      } else {
        index++
      }
    }
    return border
  }

  /**
   * Rebuilds emulator state from [remote] after the byte stream is no longer
   * a prefix. [replyFrom] is the first index whose device replies are still owed.
   */
  private fun resetTo(
    remote: String,
    echoTrusted: Boolean,
    replyFrom: Int
  ): TerminalBufferSync = TerminalBufferSync.Reset(
    buffer = remote,
    replyFrom = replyFrom,
    state = TerminalEchoState(
      confirmed = remote,
      echoTrusted = echoTrusted,
      hasRemoteOutput = remote.isNotEmpty(),
    ),
  )

  /** Removes OSC, CSI, and single-character escapes so a prompt can be read. */
  private fun stripAnsi(text: String): String =
    SIMPLE_ESC.replace(CSI.replace(OSC.replace(text, ""), ""), "")

  /** What remains of a probe after comparing it with one pty suffix. */
  private data class LearnedEcho(val pending: String, val confirmedEcho: Boolean)
}

/**
 * Cursor for local echo. [confirmed] is pty output already applied.
 * [predicted] is the painted tail still absent from [confirmed].
 * [pendingInput] is predictable input not yet observed in the pty stream.
 * [awaitingRemote] is set after a control key until the pty's handling of
 * that key is visible, so a later printable echo of earlier keys cannot
 * paint the next character at a stale cursor.
 */
internal data class TerminalEchoState(
  val confirmed: String = "",
  val predicted: String = "",
  val pendingInput: String = "",
  val echoTrusted: Boolean = true,
  val hasRemoteOutput: Boolean = false,
  val awaitingRemote: Boolean = false
)

/** Result of a local keystroke: [paint] is null when the pty must echo it. */
internal data class LocalEchoDecision(
  val paint: String?,
  val state: TerminalEchoState
)

/** How to update the Ghostty session after a remote buffer arrives. */
internal sealed interface TerminalBufferSync {
  val state: TerminalEchoState

  /** The emulator already shows [state]. */
  data class InSync(override val state: TerminalEchoState) : TerminalBufferSync

  /** Append [suffix] to the emulator. These bytes were not painted locally. */
  data class Feed(val suffix: String, override val state: TerminalEchoState) : TerminalBufferSync

  /**
   * Discard the emulator and replay [buffer].
   *
   * [replyFrom] is the index where bytes the previous session has not already
   * answered begin. The view replays the prefix without sending device replies,
   * so a historical cursor report is not typed into the shell.
   */
  data class Reset(
    val buffer: String,
    val replyFrom: Int,
    override val state: TerminalEchoState
  ) : TerminalBufferSync
}
