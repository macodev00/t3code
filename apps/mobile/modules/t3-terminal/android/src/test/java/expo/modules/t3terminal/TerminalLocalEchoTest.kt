package expo.modules.t3terminal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TerminalLocalEchoTest {
  @Test
  fun firstKeyIsNotPaintedUntilThePtyEchoesIt() {
    val prompt = note("user@host:~$ ")
    val first = TerminalLocalEcho.noteLocalInput(prompt, "l", canPaint = true)
    assertNull(first.paint)
    assertFalse(first.state.echoTrusted)

    val echoed = TerminalLocalEcho.applyRemoteBuffer(first.state, "user@host:~$ l")
    assertTrue(echoed.state.echoTrusted)
    assertEquals("", echoed.state.pendingInput)

    val second = TerminalLocalEcho.noteLocalInput(echoed.state, "s", canPaint = true)
    assertEquals("s", second.paint)
    assertEquals("s", second.state.predicted)
  }

  @Test
  fun echoDisabledPromptNeverPaintsTheSecret() {
    val typed = typeUnpainted("read -s")
    val entered = TerminalLocalEcho.noteLocalInput(typed, "\r", canPaint = true)
    assertTrue(entered.state.awaitingRemote)
    val prompted = TerminalLocalEcho.applyRemoteBuffer(
      entered.state,
      "user@host:~$ read -s\r\nAPI token: ",
    )
    assertFalse(prompted.state.echoTrusted)
    assertFalse(prompted.state.awaitingRemote)

    var state = prompted.state
    for (ch in "s3cret") {
      val decision = TerminalLocalEcho.noteLocalInput(state, ch.toString(), canPaint = true)
      assertNull(decision.paint)
      state = decision.state
    }
    val hidden = TerminalLocalEcho.applyRemoteBuffer(state, "user@host:~$ read -s\r\nAPI token: ")
    assertFalse(hidden.state.echoTrusted)
    assertEquals("", hidden.state.predicted)
  }

  @Test
  fun keyPastThePendingCapIsNotPaintedAndBlocksTheNextKey() {
    var state = trustedAfter("a")
    val filled = "x".repeat(TerminalLocalEcho.MAX_PENDING_INPUT)
    for (ch in filled) {
      val decision = TerminalLocalEcho.noteLocalInput(state, ch.toString(), canPaint = true)
      assertEquals(ch.toString(), decision.paint)
      state = decision.state
    }

    val overflow = TerminalLocalEcho.noteLocalInput(state, "y", canPaint = true)
    assertNull(overflow.paint)
    assertTrue(overflow.state.pendingInput.endsWith("y"))
    assertFalse(overflow.state.pendingInput == overflow.state.predicted)

    val partial = TerminalLocalEcho.applyRemoteBuffer(overflow.state, "prompt a$filled")
    assertNull(TerminalLocalEcho.noteLocalInput(partial.state, "z", canPaint = true).paint)

    val echoed = TerminalLocalEcho.applyRemoteBuffer(overflow.state, "prompt a$filled" + "y")
    assertEquals("", echoed.state.pendingInput)
    assertTrue(echoed.state.echoTrusted)
    val after = TerminalLocalEcho.noteLocalInput(echoed.state, "q", canPaint = true)
    assertEquals("q", after.paint)

    val blocked = TerminalLocalEcho.noteLocalInput(overflow.state, "z", canPaint = true)
    assertTrue(blocked.state.awaitingRemote)
    val echoedPast = TerminalLocalEcho.applyRemoteBuffer(blocked.state, "prompt a$filled" + "yz")
    assertFalse(echoedPast.state.echoTrusted)
    assertNull(TerminalLocalEcho.noteLocalInput(echoedPast.state, "q", canPaint = true).paint)
  }

  @Test
  fun awaitingRemoteStaysSetWhileSuffixIsOnlyPrintableEcho() {
    val typed = typeUnpainted("ls")
    val entered = TerminalLocalEcho.noteLocalInput(typed, "\r", canPaint = true)
    val echoOnly = TerminalLocalEcho.applyRemoteBuffer(entered.state, "user@host:~$ ls")
    assertTrue(echoOnly.state.awaitingRemote)
    assertNull(TerminalLocalEcho.noteLocalInput(echoOnly.state, "x", canPaint = true).paint)

    val processed = TerminalLocalEcho.applyRemoteBuffer(echoOnly.state, "user@host:~$ ls\r\n")
    assertFalse(processed.state.awaitingRemote)
    assertFalse(processed.state.echoTrusted)
  }

  @Test
  fun divergentRemoteClearsEchoAndDoesNotKeepAPartialPaint() {
    val trusted = trustedAfter("a")
    val painted = TerminalLocalEcho.noteLocalInput(trusted, "bc", canPaint = true)
    val reset = TerminalLocalEcho.applyRemoteBuffer(painted.state, "OTHER")
    assertTrue(reset is TerminalBufferSync.Reset)
    assertFalse(reset.state.echoTrusted)
    assertEquals("", reset.state.predicted)
    assertNull(TerminalLocalEcho.noteLocalInput(reset.state, "z", canPaint = true).paint)
  }

  @Test
  fun scrollbackTrimDoesNotResendTheOverlappingTail() {
    val previous = "HEAD" + "tail-already-answered"
    val remote = "tail-already-answered" + "new"
    assertEquals(
      "tail-already-answered".length,
      TerminalLocalEcho.retainedHistoryLength(previous, remote),
    )
  }

  private fun note(remote: String): TerminalEchoState {
    val sync = TerminalLocalEcho.applyRemoteBuffer(TerminalEchoState(), remote)
    assertFalse(sync.state.echoTrusted)
    return sync.state
  }

  private fun typeUnpainted(text: String): TerminalEchoState {
    var state = note("user@host:~$ ")
    for (ch in text) {
      val decision = TerminalLocalEcho.noteLocalInput(state, ch.toString(), canPaint = true)
      assertNull(decision.paint)
      state = decision.state
    }
    return state
  }

  private fun trustedAfter(char: String): TerminalEchoState {
    val first = TerminalLocalEcho.noteLocalInput(note("prompt "), char, canPaint = true)
    assertNull(first.paint)
    val echoed = TerminalLocalEcho.applyRemoteBuffer(first.state, "prompt $char")
    assertTrue(echoed.state.echoTrusted)
    return echoed.state
  }
}
