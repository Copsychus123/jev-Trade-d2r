// Sharing the game window: one VideoFrame at a time, read straight from the track.
//
// MediaStreamTrackProcessor, not requestVideoFrameCallback and not a timer: when the game covers Chrome those stop or
// get throttled, and the scan would freeze exactly when the player is using it.

/**
 * Asks for one window (the player picks it in Chrome's own dialog) and hands every frame to `onFrame(frame)`.
 * The callback must call `frame.close()`; a thrown error ends nothing, so the caller reports it and keeps watching.
 * `onEnded` runs when the player presses Chrome's "stop sharing" (no argument), or when the read loop fails (the
 * error), so the caller can show why the capture stopped. A cancelled dialog returns null; other errors throw.
 */
export async function startCapture(onFrame, onEnded = () => {}) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "window", frameRate: { ideal: 15, max: 15 } },
      audio: false,
      selfBrowserSurface: "exclude",
    });
  } catch (error) {
    if (error?.name === "NotAllowedError") return null; // the player closed the dialog without picking a window
    throw error;
  }
  const track = stream.getVideoTracks()[0];
  track.addEventListener("ended", () => onEnded());
  let reader;
  try {
    reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
  } catch (error) {
    for (const streamTrack of stream.getTracks()) streamTrack.stop(); // no reader: do not leave the share running
    throw error;
  }
  let stopped = false;

  const pump = async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      try {
        if (!stopped) await onFrame(value);
      } finally {
        value.close(); // closed once by the callback and once here: closing a VideoFrame twice is a no-op
      }
      if (stopped) break;
    }
  };
  pump().catch((error) => onEnded(error)); // a read failure goes to the caller; the ended listener is the clean stop

  return {
    stop() {
      stopped = true;
      reader.cancel().catch(() => {});
      for (const streamTrack of stream.getTracks()) streamTrack.stop();
    },
  };
}
