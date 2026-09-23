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

  /** Backspace is not predicted; only the pty's deletion sequence is fed after the echoed characters. */
  @Test
  fun backspaceEchoFeedsOnlyTheDeletionSequence() {
    val harness = primed("$\n")
    harness.type("ab")

    assertFeed(harness.remote("$\nab\b \b"), "\b \b")
  }

  /** A raw-mode redraw rolls the grid back and prediction stays off until a key is echoed verbatim. */
  @Test
  fun aContradictionRebuildsFromThePtyAndStopsPredictingUntilACleanEcho() {
    val harness = primed("$\n")
    harness.type("i")

    val diverged = harness.remote("$\n\u001B[2J")
    assertTrue(diverged is TerminalBufferSync.Reset)
    assertEquals("$\n\u001B[2J", (diverged as TerminalBufferSync.Reset).buffer)
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

  /** A trimmed scrollback is not an echo-mode change, so the next key still paints. */
  @Test
  fun scrollbackTrimKeepsEchoTrust() {
    val harness = primed("$\n")
    harness.type("a")

    val trimmed = harness.remote("trimmed-tail")
    assertTrue(trimmed is TerminalBufferSync.Reset)
    assertTrue(harness.state.echoTrusted)
    assertEquals("", harness.state.predicted)
    assertEquals("b", harness.type("b").paint)
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

  /** Password detection reads the visible prompt, not ANSI color or earlier lines. */
  @Test
  fun passwordPromptDetectionIgnoresAnsiAndEarlierLines() {
    assertTrue(TerminalLocalEcho.looksLikePasswordPrompt("\u001B[31mPassword:\u001B[0m "))
    assertTrue(TerminalLocalEcho.looksLikePasswordPrompt("Enter passphrase for key: "))
    assertTrue(TerminalLocalEcho.looksLikePasswordPrompt("pass phrase: "))
    assertFalse(TerminalLocalEcho.looksLikePasswordPrompt("user@host:~$ "))
    assertFalse(TerminalLocalEcho.looksLikePasswordPrompt("Password reset complete\n$ "))
    assertFalse(TerminalLocalEcho.looksLikePasswordPrompt("echo hello"))
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
    assertEquals("hello", harness.type("hello").paint)
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
