package expo.modules.t3terminal

/**
 * Paints printable Android keystrokes before the remote pty echoes them.
 *
 * The surface otherwise waits for a full attach round trip before Ghostty
 * can draw, so every character feels late on a phone. Only bytes a cooked
 * shell echoes unchanged are painted ahead. Controls, pastes, and password
 * prompts stay on the remote path. If the pty byte stream contradicts a
 * prediction, the grid is rebuilt from that stream and local echo stays off
 * until a later keystroke is echoed verbatim.
 */
internal object TerminalLocalEcho {
  /** One IME delivery longer than this is a paste, not typing. */
  private const val MAX_PREDICTABLE_INPUT = 64

  /** Unconfirmed probe retained while echo is off, so a raw session cannot grow forever. */
  private const val MAX_PENDING_INPUT = 256

  /** Tail of the pty stream inspected for a password prompt. */
  private const val PASSWORD_TAIL_CHARS = 240

  private val OSC = Regex("\u001B\\][^\u0007]*(?:\u0007|\u001B\\\\)")
  private val CSI = Regex("\u001B\\[[0-9:;<=>?]*[ -/]*[@-~]")
  private val SIMPLE_ESC = Regex("\u001B[@-Z\\-_]")
  private val PASSWORD_PROMPT = Regex(
    "(?i)(?:pass(?:word|phrase)|pass phrase)\\s*(?:for\\b[^:\\n\\r]*)?:\\s*$",
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
   * sent to the pty by the caller.
   */
  fun noteLocalInput(
    state: TerminalEchoState,
    input: String,
    canPaint: Boolean
  ): LocalEchoDecision {
    val echo = predictableEcho(input)
    if (echo == null || !canPaint || !shouldPaint(state)) {
      return skipPaint(state, echo)
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
   */
  fun applyRemoteBuffer(state: TerminalEchoState, remote: String): TerminalBufferSync {
    if (!remote.startsWith(state.confirmed)) {
      return resetTo(remote, echoTrusted = state.echoTrusted)
    }
    val withOutput = state.copy(hasRemoteOutput = remote.isNotEmpty())
    val suffix = remote.substring(state.confirmed.length)
    return if (state.predicted.isEmpty()) {
      syncUnpredicted(withOutput, remote, suffix)
    } else {
      syncPredicted(withOutput, remote, suffix)
    }
  }

  /**
   * True when the visible tail of pty output is a password or passphrase
   * prompt. Those prompts run with echo disabled, so painting the key would
   * reveal it until the next remote frame.
   */
  fun looksLikePasswordPrompt(buffer: String): Boolean {
    if (buffer.isEmpty()) return false
    val visible = stripAnsi(buffer.takeLast(PASSWORD_TAIL_CHARS))
    val line = visible.substringAfterLast('\n').substringAfterLast('\r').trimEnd()
    return PASSWORD_PROMPT.containsMatchIn(line)
  }

  /**
   * True for space and other non-control characters. C0/C1 controls and DEL
   * are excluded because the pty may swallow or expand them.
   */
  private fun isEchoableCodePoint(
    codePoint: Int
  ): Boolean = codePoint >= 0x20 && codePoint != 0x7F && codePoint !in 0x80..0x9F

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
   * Local echo is safe only after the pty has drawn a frame, echo has not
   * been contradicted, every outstanding byte is already on screen, and the
   * cursor is not sitting on a password prompt.
   */
  private fun shouldPaint(state: TerminalEchoState): Boolean {
    val cursorReady = state.hasRemoteOutput &&
      state.echoTrusted &&
      state.pendingInput == state.predicted
    return cursorReady && !looksLikePasswordPrompt(state.confirmed)
  }

  /**
   * Keeps a key that was not painted so a later verbatim echo can arm
   * prediction. Already-trusted input that we refused to paint (a password,
   * or a surface that is not ready) must not block the next safe key.
   */
  private fun skipPaint(state: TerminalEchoState, echo: String?): LocalEchoDecision {
    if (echo == null || state.echoTrusted) {
      return LocalEchoDecision(paint = null, state = state)
    }
    return LocalEchoDecision(
      paint = null,
      state = state.copy(pendingInput = rememberPending(state.pendingInput, echo)),
    )
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
    else -> resetTo(remote, echoTrusted = false)
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
  private fun pendingAfterRemote(pending: String, suffix: String, learned: LearnedEcho): String {
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

  /** Rebuilds emulator state from [remote] after the byte stream is no longer a prefix. */
  private fun resetTo(
    remote: String,
    echoTrusted: Boolean
  ): TerminalBufferSync = TerminalBufferSync.Reset(
    buffer = remote,
    state = TerminalEchoState(
      confirmed = remote,
      echoTrusted = echoTrusted,
      hasRemoteOutput = remote.isNotEmpty(),
    ),
  )

  /** Removes OSC, CSI, and single-character escapes so a prompt can be read. */
  private fun stripAnsi(
    text: String
  ): String = SIMPLE_ESC.replace(CSI.replace(OSC.replace(text, ""), ""), "")

  /** What remains of a probe after comparing it with one pty suffix. */
  private data class LearnedEcho(val pending: String, val confirmedEcho: Boolean)
}

/**
 * Cursor for local echo. [confirmed] is pty output already applied.
 * [predicted] is the painted tail still absent from [confirmed].
 * [pendingInput] is predictable input not yet observed in the pty stream.
 */
internal data class TerminalEchoState(
  val confirmed: String = "",
  val predicted: String = "",
  val pendingInput: String = "",
  val echoTrusted: Boolean = true,
  val hasRemoteOutput: Boolean = false
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

  /** Discard the emulator and replay [buffer]. */
  data class Reset(val buffer: String, override val state: TerminalEchoState) : TerminalBufferSync
}
