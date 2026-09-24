package expo.modules.t3terminal

/**
 * Paints printable Android keystrokes before the remote pty echoes them.
 *
 * Echo-off is not on the wire. A proper prefix of unsent input, or a single
 * echoed byte, is not proof the pty is echoing: unrelated output such as `a`
 * matches the start of a secret. Painting starts only after the pty has
 * finished echoing at least two typed characters on the line, with nothing
 * else mixed in. Any other output closes the gate.
 */
internal object TerminalLocalEcho {
  /** One IME delivery longer than this is a paste, not typing. */
  private const val MAX_PREDICTABLE_INPUT = 64

  /**
   * Cap for input the pty has not echoed yet. A trusted key that would pass
   * it is not painted and stays in [TerminalEchoState.pendingInput] so the
   * next key cannot be drawn ahead of it.
   */
  internal const val MAX_PENDING_INPUT = 256

  /**
   * One matching byte is not an authoritative echo. Trust requires the pty
   * to finish the outstanding input and to have echoed at least this many
   * characters on the line.
   */
  private const val MIN_AUTHORITATIVE_ECHO = 2

  /**
   * Records [input] and, when echo is known to be on, returns the bytes to
   * paint. [canPaint] is false until the native terminal exists.
   */
  fun noteLocalInput(
    state: TerminalEchoState,
    input: String,
    canPaint: Boolean,
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
   * is not fed again. Anything other than a finished echo of the outstanding
   * input clears the echo gate. A contradiction rebuilds from [remote].
   */
  fun applyRemoteBuffer(state: TerminalEchoState, remote: String): TerminalBufferSync {
    if (!remote.startsWith(state.confirmed)) {
      return resetTo(remote, replyFrom = retainedHistoryLength(state.confirmed, remote))
    }
    val suffix = remote.substring(state.confirmed.length)
    val withHold = state.copy(awaitingRemote = stillAwaitingRemote(state, suffix))
    return if (withHold.predicted.isEmpty()) {
      syncUnpredicted(withHold, remote, suffix)
    } else {
      syncPredicted(withHold, remote, suffix)
    }
  }

  /** Short printable input a cooked shell echoes unchanged, or null. */
  fun predictableEcho(input: String): String? {
    if (input.isEmpty() || input.length > MAX_PREDICTABLE_INPUT) return null
    var index = 0
    while (index < input.length) {
      val codePoint = input.codePointAt(index)
      if (codePoint < 0x20 || codePoint == 0x7F || codePoint in 0x80..0x9F) return null
      index += Character.charCount(codePoint)
    }
    return input
  }

  private fun canPaintAhead(
    state: TerminalEchoState,
    echo: String,
    canPaint: Boolean,
  ): Boolean {
    if (!canPaint || !echoKnownOn(state)) return false
    return state.predicted.length + echo.length <= MAX_PENDING_INPUT
  }

  /**
   * Echo is known on only after an authoritative echo, with no control key
   * still in flight and no unpainted printable bytes ahead of the cursor.
   */
  private fun echoKnownOn(state: TerminalEchoState): Boolean =
    state.echoTrusted && !state.awaitingRemote && state.pendingInput == state.predicted

  private fun skipPaint(
    state: TerminalEchoState,
    echo: String?,
    input: String,
    canPaint: Boolean,
  ): LocalEchoDecision {
    val held = if (input.isNotEmpty() && echo == null) {
      state.copy(awaitingRemote = true, awaitingEchoPast = state.pendingInput.length)
    } else {
      state
    }
    val next = when {
      echo != null && shouldRetainTrustedCap(held, echo, canPaint) ->
        held.copy(pendingInput = held.pendingInput + echo)
      echo != null && held.echoTrusted && !echoKnownOn(held) -> holdUnpainted(held, echo)
      echo == null || held.echoTrusted -> held
      else -> held.copy(pendingInput = rememberPending(held.pendingInput, echo))
    }
    return LocalEchoDecision(paint = null, state = next)
  }

  /**
   * Keeps an unpainted trusted key in [TerminalEchoState.pendingInput] so a
   * later partial echo cannot draw the key after it. A key that would grow
   * pending past [MAX_PENDING_INPUT] holds the echo gate until the pty sends
   * something other than the bytes already recorded.
   */
  private fun holdUnpainted(state: TerminalEchoState, echo: String): TerminalEchoState {
    if (state.pendingInput.length + echo.length <= MAX_PENDING_INPUT) {
      return state.copy(pendingInput = state.pendingInput + echo)
    }
    return state.copy(awaitingRemote = true)
  }

  private fun shouldRetainTrustedCap(
    state: TerminalEchoState,
    echo: String,
    canPaint: Boolean,
  ): Boolean {
    if (!canPaint || !echoKnownOn(state)) return false
    return state.predicted.length + echo.length > MAX_PENDING_INPUT
  }

  /**
   * A control key stays unanswered while the new pty bytes are only the
   * printable echo already recorded. Bytes typed after the key clear the
   * hold once they are echoed, even when the key itself produced no output.
   */
  private fun stillAwaitingRemote(state: TerminalEchoState, suffix: String): Boolean {
    if (!state.awaitingRemote) return false
    val outstanding = outstandingPrintable(state)
    val echoedPastControl = suffix.length > state.awaitingEchoPast &&
      outstanding.isNotEmpty() &&
      outstanding.startsWith(suffix)
    if (echoedPastControl) return false
    return suffix.isEmpty() || (outstanding.isNotEmpty() && outstanding.startsWith(suffix))
  }

  private fun outstandingPrintable(state: TerminalEchoState): String = when {
    state.pendingInput.startsWith(state.predicted) -> state.pendingInput
    state.predicted.startsWith(state.pendingInput) -> state.predicted
    else -> state.predicted.ifEmpty { state.pendingInput }
  }

  private fun rememberPending(pending: String, echo: String): String {
    val combined = pending + echo
    if (combined.length > MAX_PENDING_INPUT) return ""
    return combined
  }

  private fun syncUnpredicted(
    state: TerminalEchoState,
    remote: String,
    suffix: String,
  ): TerminalBufferSync {
    val learned = learnEcho(state.pendingInput, suffix)
    val next = state.copy(
      confirmed = remote,
      pendingInput = pendingAfterRemote(state.pendingInput, suffix, learned),
      echoTrusted = trustAfterEcho(state, suffix, learned),
      echoedOnLine = echoedOnLineAfter(state, suffix, learned),
      awaitingEchoPast = advanceHold(state, learned),
      hasRemoteOutput = remote.isNotEmpty(),
    )
    if (suffix.isEmpty()) return TerminalBufferSync.InSync(next)
    return TerminalBufferSync.Feed(suffix, next)
  }

  private fun syncPredicted(
    state: TerminalEchoState,
    remote: String,
    suffix: String,
  ): TerminalBufferSync = when {
    suffix.isEmpty() || state.predicted.startsWith(suffix) ->
      confirmPredictedPrefix(state, remote, suffix)
    suffix.startsWith(state.predicted) ->
      confirmPredictedAndFeedRest(state, remote, suffix)
    else -> resetTo(remote, replyFrom = state.confirmed.length)
  }

  private fun confirmPredictedPrefix(
    state: TerminalEchoState,
    remote: String,
    suffix: String,
  ): TerminalBufferSync {
    if (suffix.isEmpty()) return TerminalBufferSync.InSync(state)
    return TerminalBufferSync.InSync(
      state.copy(
        confirmed = remote,
        predicted = state.predicted.substring(suffix.length),
        pendingInput = dropMatchedPrefix(state.pendingInput, suffix),
        echoedOnLine = state.echoedOnLine + suffix.length,
        awaitingEchoPast = (state.awaitingEchoPast - suffix.length).coerceAtLeast(0),
        hasRemoteOutput = true,
      ),
    )
  }

  private fun confirmPredictedAndFeedRest(
    state: TerminalEchoState,
    remote: String,
    suffix: String,
  ): TerminalBufferSync {
    val extra = suffix.substring(state.predicted.length)
    val pending = dropMatchedPrefix(state.pendingInput, state.predicted)
    val learned = learnEcho(pending, extra)
    val finishedExtra = learned.confirmedEcho && learned.pending.isEmpty() && extra == pending
    return TerminalBufferSync.Feed(
      extra,
      state.copy(
        confirmed = remote,
        predicted = "",
        pendingInput = pendingAfterRemote(pending, extra, learned),
        echoTrusted = state.echoTrusted && (extra.isEmpty() || finishedExtra),
        echoedOnLine = if (extra.isEmpty() || finishedExtra) {
          state.echoedOnLine + state.predicted.length + pending.length
        } else {
          0
        },
        awaitingEchoPast = 0,
        hasRemoteOutput = true,
      ),
    )
  }

  /**
   * Enables the gate only when [suffix] is exactly the outstanding input and
   * the line has now echoed at least [MIN_AUTHORITATIVE_ECHO] characters.
   * A proper prefix, including a lone `a`, does not enable it.
   */
  private fun trustAfterEcho(
    state: TerminalEchoState,
    suffix: String,
    learned: LearnedEcho,
  ): Boolean {
    if (suffix.isEmpty()) return state.echoTrusted
    if (!finishedEcho(state.pendingInput, suffix, learned)) return false
    return state.echoedOnLine + state.pendingInput.length >= MIN_AUTHORITATIVE_ECHO
  }

  private fun echoedOnLineAfter(
    state: TerminalEchoState,
    suffix: String,
    learned: LearnedEcho,
  ): Int {
    if (suffix.isEmpty()) return state.echoedOnLine
    val consumed = if (learned.confirmedEcho) {
      state.pendingInput.length - learned.pending.length
    } else {
      0
    }
    if (consumed == 0) return 0
    return state.echoedOnLine + consumed
  }

  /** The pty returned the whole outstanding input and nothing else. */
  private fun finishedEcho(pending: String, suffix: String, learned: LearnedEcho): Boolean =
    pending.isNotEmpty() &&
      learned.confirmedEcho &&
      learned.pending.isEmpty() &&
      suffix.length == pending.length

  private fun advanceHold(state: TerminalEchoState, learned: LearnedEcho): Int {
    if (!learned.confirmedEcho) return 0
    val consumed = state.pendingInput.length - learned.pending.length
    return (state.awaitingEchoPast - consumed).coerceAtLeast(0)
  }

  private fun pendingAfterRemote(
    pending: String,
    suffix: String,
    learned: LearnedEcho,
  ): String {
    if (suffix.isNotEmpty() && !learned.confirmedEcho) return ""
    return if (suffix.isEmpty()) pending else learned.pending
  }

  private fun learnEcho(pending: String, suffix: String): LearnedEcho = when {
    pending.isEmpty() || suffix.isEmpty() -> LearnedEcho(pending, confirmedEcho = false)
    suffix.startsWith(pending) -> LearnedEcho("", confirmedEcho = true)
    pending.startsWith(suffix) ->
      LearnedEcho(pending.substring(suffix.length), confirmedEcho = true)
    else -> LearnedEcho(pending, confirmedEcho = false)
  }

  private fun dropMatchedPrefix(pending: String, prefix: String): String = when {
    prefix.isEmpty() -> pending
    pending.startsWith(prefix) -> pending.substring(prefix.length)
    else -> ""
  }

  /**
   * Length of the longest suffix of [previous] that is a prefix of [remote].
   * A scrollback trim drops the head and may append bytes in the same update.
   * That overlap was already answered, so device replies are not resent.
   */
  internal fun retainedHistoryLength(previous: String, remote: String): Int {
    if (previous.isEmpty() || remote.isEmpty()) return 0
    if (remote.startsWith(previous)) return previous.length
    val border = prefixBorder(remote)
    var matched = 0
    for (index in previous.indices) {
      while (matched > 0 && previous[index] != remote[matched]) {
        matched = border[matched - 1]
      }
      if (previous[index] == remote[matched]) matched++
      if (matched == remote.length && index != previous.lastIndex) {
        matched = border[matched - 1]
      }
    }
    return matched
  }

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

  private fun resetTo(remote: String, replyFrom: Int): TerminalBufferSync = TerminalBufferSync.Reset(
    buffer = remote,
    replyFrom = replyFrom,
    state = TerminalEchoState(
      confirmed = remote,
      echoTrusted = false,
      hasRemoteOutput = remote.isNotEmpty(),
    ),
  )

  private data class LearnedEcho(val pending: String, val confirmedEcho: Boolean)
}

/**
 * [confirmed] is pty output already applied. [predicted] is the painted tail
 * still absent from [confirmed]. [pendingInput] is predictable input not yet
 * observed. [echoTrusted] is set only after a finished multi-character echo
 * and cleared when the pty sends anything else. [awaitingRemote] holds
 * painting after a control key. [awaitingEchoPast] is the pending length at
 * that key, so a later echoed character can release the hold when the key
 * itself produced no output. [echoedOnLine] counts consecutive echoed
 * characters since the last non-echo byte.
 */
internal data class TerminalEchoState(
  val confirmed: String = "",
  val predicted: String = "",
  val pendingInput: String = "",
  val echoTrusted: Boolean = false,
  val hasRemoteOutput: Boolean = false,
  val awaitingRemote: Boolean = false,
  val awaitingEchoPast: Int = 0,
  val echoedOnLine: Int = 0,
)

/** [paint] is null when the key must wait for the pty. */
internal data class LocalEchoDecision(
  val paint: String?,
  val state: TerminalEchoState,
)

/** How to update Ghostty after a remote buffer arrives. */
internal sealed interface TerminalBufferSync {
  val state: TerminalEchoState

  data class InSync(override val state: TerminalEchoState) : TerminalBufferSync

  data class Feed(val suffix: String, override val state: TerminalEchoState) : TerminalBufferSync

  /**
   * Replay [buffer]. [replyFrom] is where device replies may resume; earlier
   * bytes were already answered by the previous session.
   */
  data class Reset(
    val buffer: String,
    val replyFrom: Int,
    override val state: TerminalEchoState,
  ) : TerminalBufferSync
}
