package expo.modules.t3terminal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TerminalLocalEchoTest {
  /** Cooked-mode typing is painted immediately and not fed a second time when the pty echoes it. */
  @Test
  fun printableTypingIsPaintedAndNotFedAgainWhenThePtyEchoesIt() {
    val harness = primed("$\n")
    assertEquals("a", harness.type("a").paint)
    assertEquals("b", harness.type("b").paint)

    val partial = harness.remote("$\na")
    assertTrue(partial is TerminalBufferSync.InSync)
    assertEquals("b", harness.state.predicted)

    val echoed = harness.remote("$\nab")
    assertTrue(echoed is TerminalBufferSync.InSync)
    assertEquals("", harness.state.predicted)
    assertEquals("$\nab", harness.state.confirmed)
  }

  /** A resize-style replay of the same pty buffer must leave an in-flight prediction on screen. */
  @Test
  fun anIdenticalRemoteBufferDoesNotClearAnOutstandingPrediction() {
    val harness = primed("$\n")
    harness.type("a")

    val same = harness.remote("$\n")
    assertTrue(same is TerminalBufferSync.InSync)
    assertEquals("a", harness.state.predicted)
  }

  /** Output that follows a predicted command is appended without repainting the command. */
  @Test
  fun commandOutputAfterAPredictedLineFeedsOnlyTheUnpaintedTail() {
    val harness = primed("$\n")
    harness.type("ls")

    val sync = harness.remote("$\nls\r\nfile\r\n$\n")
    assertFeed(sync, "\r\nfile\r\n$\n")
    assertEquals("", harness.state.predicted)
  }

  /** Backspace from the pty is not predicted; only the deletion sequence is fed after the echoed characters. */
  @Test
  fun backspaceEchoFeedsOnlyTheDeletionSequence() {
    val harness = primed("$\n")
    harness.type("ab")

    assertFeed(harness.remote("$\nab\b \b"), "\b \b")
  }

  /**
   * A raw-mode redraw rolls the grid back and prediction stays off until a key
   * is echoed verbatim. Device replies resume at the new suffix, not the history.
   */
  @Test
  fun aContradictionRebuildsFromThePtyAndStopsPredictingUntilACleanEcho() {
    val harness = primed("$\n")
    harness.type("i")

    val diverged = harness.remote("$\n\u001B[2J")
    assertTrue(diverged is TerminalBufferSync.Reset)
    val reset = diverged as TerminalBufferSync.Reset
    assertEquals("$\n\u001B[2J", reset.buffer)
    assertEquals("$\n".length, reset.replyFrom)
    assertFalse(harness.state.echoTrusted)
    assertNull(harness.type("j").paint)
    assertEquals("j", harness.state.pendingInput)

    val unrelated = harness.remote("$\n\u001B[2JMORE")
    assertFeed(unrelated, "MORE")
    assertEquals("", harness.state.pendingInput)
    assertFalse(harness.state.echoTrusted)

    assertNull(harness.type("s").paint)
    assertFeed(harness.remote("$\n\u001B[2JMOREs"), "s")
    assertTrue(harness.state.echoTrusted)
    assertEquals("h", harness.type("h").paint)
  }

  /** No new pty bytes means the probe used to re-arm echo is still waiting. */
  @Test
  fun anUnchangedBufferKeepsTheProbeArmed() {
    val harness = primed("$\n")
    harness.type("i")
    harness.remote("$\nSCREEN")
    harness.type("j")

    val same = harness.remote(harness.state.confirmed)
    assertTrue(same is TerminalBufferSync.InSync)
    assertEquals("j", harness.state.pendingInput)
  }

  /** A trimmed scrollback keeps echo trust, and the retained tail is not treated as new input. */
  @Test
  fun scrollbackTrimKeepsEchoTrust() {
    val harness = primed("scrollback\n$\n")
    harness.type("a")

    val trimmed = harness.remote("$\n")
    assertTrue(trimmed is TerminalBufferSync.Reset)
    val reset = trimmed as TerminalBufferSync.Reset
    assertEquals("$\n", reset.buffer)
    assertEquals(reset.buffer.length, reset.replyFrom)
    assertTrue(harness.state.echoTrusted)
    assertEquals("", harness.state.predicted)
    assertEquals("b", harness.type("b").paint)
  }

  /** Bytes appended in the same update as a trim still owe device replies. A disjoint buffer is all live. */
  @Test
  fun scrollbackTrimRepliesOnlyForTheNewTail() {
    val harness = primed("HEAD\n$\n")
    val trimmed = harness.remote("$\n\u001B[6n")
    val reset = trimmed as TerminalBufferSync.Reset
    assertEquals("$\n".length, reset.replyFrom)

    assertEquals(4, TerminalLocalEcho.retainedHistoryLength("ababa", "babaXY"))
    assertEquals(3, TerminalLocalEcho.retainedHistoryLength("abcXabc", "abcY"))
    assertEquals(2, TerminalLocalEcho.retainedHistoryLength("aaa", "aa"))
    assertEquals(0, TerminalLocalEcho.retainedHistoryLength("$\n", "trimmed-tail"))
    assertEquals(0, TerminalLocalEcho.retainedHistoryLength("", "abc"))
  }

  /** Keys that arrive before the first pty frame wait, then typing predicts once a prompt exists. */
  @Test
  fun keysBeforeTheFirstFrameAreNotPainted() {
    val harness = EchoHarness()
    assertNull(harness.type("a").paint)
    assertEquals("", harness.state.pendingInput)

    assertFeed(harness.remote("$\n"), "$\n")
    assertEquals("b", harness.type("b").paint)
  }

  /** If Ghostty is not allocated yet, the key is not recorded as already painted. */
  @Test
  fun aMissingSurfaceDoesNotClaimTheCharacterWasPainted() {
    val harness = primed("$\n")
    assertNull(harness.type("a", canPaint = false).paint)
    assertEquals("", harness.state.predicted)

    assertFeed(harness.remote("$\na"), "a")
  }

  /** Password entry is not painted, and the following shell prompt predicts again. */
  @Test
  fun passwordPromptsAreNotPaintedAndTheNextPromptPredictsAgain() {
    val harness = primed("[sudo] password for marcel: ")
    val hidden = harness.type("secret")
    assertNull(hidden.paint)
    assertEquals("", harness.state.predicted)
    assertEquals("", harness.state.pendingInput)

    assertFeed(harness.remote("[sudo] password for marcel: \r\n$\n"), "\r\n$\n")
    assertEquals("ls", harness.type("ls").paint)
  }

  /** Secret detection reads the visible prompt, including passcode and PIN, not ANSI or earlier lines. */
  @Test
  fun passwordPromptDetectionIgnoresAnsiAndEarlierLines() {
    assertTrue(TerminalLocalEcho.looksLikePasswordPrompt("\u001B[31mPassword:\u001B[0m "))
    assertTrue(TerminalLocalEcho.looksLikePasswordPrompt("Enter passphrase for key: "))
    assertTrue(TerminalLocalEcho.looksLikePasswordPrompt("pass phrase: "))
    assertTrue(TerminalLocalEcho.looksLikePasswordPrompt("Passcode: "))
    assertTrue(TerminalLocalEcho.looksLikePasswordPrompt("\u001B[31mPIN:\u001B[0m "))
    assertTrue(TerminalLocalEcho.looksLikePasswordPrompt("Enter PIN: "))
    assertTrue(
      TerminalLocalEcho.looksLikePasswordPrompt("Password for 'https://user@github.com': ")
    )
    assertTrue(
      TerminalLocalEcho.looksLikePasswordPrompt("Enter passphrase (empty for no passphrase): "),
    )
    assertFalse(TerminalLocalEcho.looksLikePasswordPrompt("user@host:~$ "))
    assertFalse(TerminalLocalEcho.looksLikePasswordPrompt("user@host:~/pin: "))
    assertFalse(TerminalLocalEcho.looksLikePasswordPrompt("user@host:~/password-manager: "))
    assertFalse(TerminalLocalEcho.looksLikePasswordPrompt("Password reset complete\n$ "))
    assertFalse(TerminalLocalEcho.looksLikePasswordPrompt("echo hello"))
    assertFalse(TerminalLocalEcho.looksLikePasswordPrompt("mapping: "))
  }

  /** Passcode and PIN prompts leave the secret for the pty, which has echo disabled. */
  @Test
  fun passcodeAndPinPromptsAreNotPainted() {
    for (prompt in listOf("Passcode: ", "PIN: ", "passcode for device: ")) {
      val harness = primed(prompt)
      assertNull(harness.type("1234").paint)
      assertEquals("", harness.state.predicted)
      assertEquals("", harness.state.pendingInput)
    }
  }

  /**
   * Trusted prediction stops at [TerminalLocalEcho.MAX_PENDING_INPUT]. Further
   * keystrokes are not copied into the predicted tail; the pty echo of that
   * overflow is fed once, and painting resumes after the tail drains.
   */
  @Test
  fun trustedPredictionStopsPaintingAtThePendingCap() {
    val harness = primed("$\n")
    val chunk = "a".repeat(64)
    repeat(4) {
      assertEquals(chunk, harness.type(chunk).paint)
    }
    assertEquals(TerminalLocalEcho.MAX_PENDING_INPUT, harness.state.predicted.length)

    repeat(20) {
      assertNull(harness.type("Z").paint)
    }
    assertEquals(TerminalLocalEcho.MAX_PENDING_INPUT, harness.state.predicted.length)
    assertEquals(TerminalLocalEcho.MAX_PENDING_INPUT, harness.state.pendingInput.length)
    assertFalse(harness.state.predicted.contains("Z"))

    val echoed = "$\n" + chunk.repeat(4) + "Z"
    assertFeed(harness.remote(echoed), "Z")
    assertEquals("", harness.state.predicted)
    assertEquals("b", harness.type("b").paint)
  }

  /** An untrusted probe is discarded once it would grow past the same pending cap. */
  @Test
  fun anUntrustedProbeIsDroppedOnceItPassesThePendingCap() {
    val harness = primed("$\n")
    harness.type("i")
    harness.remote("$\n\u001B[2J")
    assertFalse(harness.state.echoTrusted)

    val chunk = "a".repeat(64)
    repeat(5) {
      assertNull(harness.type(chunk).paint)
    }
    assertTrue(harness.state.pendingInput.length <= TerminalLocalEcho.MAX_PENDING_INPUT)
  }

  /** DEL moves the cursor, so a printable key typed before the pty answers is not painted locally. */
  @Test
  fun deleteThenAPrintableKeyWaitsUntilThePtyReplies() {
    val harness = primed("$\nab")
    assertNull(harness.type("\u007F").paint)
    assertTrue(harness.state.awaitingRemote)
    assertNull(harness.type("c").paint)
    assertEquals("", harness.state.predicted)

    assertFeed(harness.remote("$\nab\b \bc"), "\b \bc")
    assertFalse(harness.state.awaitingRemote)
    assertEquals("d", harness.type("d").paint)
  }

  /** Enter moves the cursor, so typeahead is not painted until the next pty frame. */
  @Test
  fun enterThenAPrintableKeyWaitsUntilThePtyReplies() {
    val harness = primed("$\n")
    harness.type("ls")
    assertNull(harness.type("\r").paint)
    assertTrue(harness.state.awaitingRemote)
    assertNull(harness.type("x").paint)

    assertFeed(harness.remote("$\nls\r\n$\nx"), "\r\n$\nx")
    assertFalse(harness.state.awaitingRemote)
    assertEquals("y", harness.type("y").paint)
  }

  /** A secret typed after Enter, before the password prompt arrives, is not painted. */
  @Test
  fun typeaheadBeforeAPasswordPromptArrivesIsNotPainted() {
    val harness = primed("$\n")
    assertNull(harness.type("\r").paint)
    assertNull(harness.type("s3cret").paint)
    assertEquals("", harness.state.predicted)

    assertFeed(
      harness.remote("$\n\r\n[sudo] password for marcel: "),
      "\r\n[sudo] password for marcel: ",
    )
    assertNull(harness.type("x").paint)
    assertEquals("", harness.state.predicted)
  }

  /** Controls, mixed newlines, and pastes wait for the pty; short words and emoji do not. */
  @Test
  fun controlsPastesAndOverlongInputAreNotLocalEcho() {
    val harness = primed("$\n")
    assertNull(TerminalLocalEcho.predictableEcho(""))
    assertNull(TerminalLocalEcho.predictableEcho("\r"))
    assertNull(TerminalLocalEcho.predictableEcho("\n"))
    assertNull(TerminalLocalEcho.predictableEcho("\t"))
    assertNull(TerminalLocalEcho.predictableEcho("\u007F"))
    assertNull(TerminalLocalEcho.predictableEcho("\u0003"))
    assertNull(TerminalLocalEcho.predictableEcho("a\nb"))
    assertNull(TerminalLocalEcho.predictableEcho("x".repeat(65)))
    assertEquals("ok", TerminalLocalEcho.predictableEcho("ok"))
    assertEquals(" ", TerminalLocalEcho.predictableEcho(" "))
    assertEquals("😀", TerminalLocalEcho.predictableEcho("😀"))

    assertNull(harness.type("\u007F").paint)
    assertEquals("", harness.state.predicted)
    assertTrue(harness.state.awaitingRemote)
    assertNull(harness.type("hello").paint)
    assertFeed(harness.remote("$\n\b \bhello"), "\b \bhello")
    assertEquals("!", harness.type("!").paint)
  }

  /** A multi-unit emoji is one echo and is not fed again when the pty returns it. */
  @Test
  fun emojiEchoIsConfirmedWithoutASecondFeed() {
    val harness = primed("$\n")
    assertEquals("😀", harness.type("😀").paint)
    assertTrue(harness.remote("$\n😀") is TerminalBufferSync.InSync)
    assertEquals("", harness.state.predicted)
  }

  /** Feeds [prompt] as the first pty frame so later keystrokes are allowed to paint. */
  private fun primed(prompt: String): EchoHarness {
    val harness = EchoHarness()
    assertFeed(harness.remote(prompt), prompt)
    assertTrue(harness.state.hasRemoteOutput)
    return harness
  }

  /** Asserts [sync] appends exactly [suffix] and nothing that was already painted. */
  private fun assertFeed(sync: TerminalBufferSync, suffix: String) {
    if (sync !is TerminalBufferSync.Feed) {
      error("expected feed of ${suffix.debug()} but was $sync")
    }
    assertEquals(suffix, sync.suffix)
  }
}

private class EchoHarness(initial: TerminalEchoState = TerminalEchoState()) {
  var state: TerminalEchoState = initial
    private set

  /** Applies an authoritative pty buffer and keeps the resulting cursor. */
  fun remote(buffer: String): TerminalBufferSync {
    val sync = TerminalLocalEcho.applyRemoteBuffer(state, buffer)
    state = sync.state
    return sync
  }

  /** Records one local input, optionally while the native surface cannot paint. */
  fun type(input: String, canPaint: Boolean = true): LocalEchoDecision {
    val decision = TerminalLocalEcho.noteLocalInput(state, input, canPaint)
    state = decision.state
    return decision
  }
}

/** Renders control bytes so a failed feed assertion shows the sequence that arrived. */
private fun String.debug(): String = buildString {
  for (character in this@debug) {
    val code = character.code
    if (code < 0x20 || code == 0x7F) {
      append("\\u").append(code.toString(16).padStart(4, '0'))
    } else {
      append(character)
    }
  }
}
