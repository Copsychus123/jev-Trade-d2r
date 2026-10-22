// The spoken confirmation of the gear scan: 「成功識別」 once, when a hover gave a record that names an item.
// Speech only (no audio file); a browser with no speech engine, or one that refuses, stays silent: it never throws.

export const ANNOUNCE_TEXT = "成功識別";

/** Speaks 「成功識別」 now, dropping any earlier phrase still queued so fast hovers never pile up into a long echo. */
export function announceRecognized(synth = globalThis.speechSynthesis, Utterance = globalThis.SpeechSynthesisUtterance) {
  if (!synth || !Utterance) return false;
  try {
    const phrase = new Utterance(ANNOUNCE_TEXT);
    phrase.lang = "zh-TW";
    synth.cancel();
    synth.speak(phrase);
    return true;
  } catch {
    return false;
  }
}
