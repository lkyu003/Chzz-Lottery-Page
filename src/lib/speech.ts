const VOICE_WAIT_TIMEOUT_MS = 1_500;

export async function getSystemVoices(): Promise<SpeechSynthesisVoice[]> {
  if (!("speechSynthesis" in window)) return [];

  const voices = window.speechSynthesis.getVoices();
  if (voices.length > 0) return voices;

  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      resolve(window.speechSynthesis.getVoices());
    }, VOICE_WAIT_TIMEOUT_MS);

    function cleanup() {
      window.clearTimeout(timeout);
      window.speechSynthesis.removeEventListener("voiceschanged", handleVoices);
    }

    function handleVoices() {
      const nextVoices = window.speechSynthesis.getVoices();
      if (nextVoices.length === 0) return;
      cleanup();
      resolve(nextVoices);
    }

    window.speechSynthesis.addEventListener("voiceschanged", handleVoices);
  });
}

export async function speakMessage(
  voiceName: string,
  message: string
): Promise<void> {
  if (!message.trim() || !("speechSynthesis" in window)) return;

  const voices = await getSystemVoices();
  const selectedVoice =
    voices.find((voice) => voice.name === voiceName) ??
    voices.find((voice) => voice.lang === "ko-KR") ??
    voices[0];
  const utterance = new SpeechSynthesisUtterance(message);

  if (selectedVoice) utterance.voice = selectedVoice;

  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

export function stopSpeaking(): void {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}
