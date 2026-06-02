"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/utils/cn";

export type MicState = "idle" | "recording" | "busy";

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1] ?? "");
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Voice input. Records a clip, AUTO-STOPS after a short silence (no manual stop
 * needed), then transcribes via Gemini (/api/transcribe) and hands the text
 * back through onTranscript. Reports its state via onState so the input can
 * show "Listening…" / "Transcribing…".
 */
export default function MicButton({
  onTranscript,
  onState,
  disabled,
  size = 28,
  className,
}: {
  onTranscript: (text: string) => void;
  onState?: (s: MicState) => void;
  disabled?: boolean;
  size?: number;
  className?: string;
}) {
  const [state, setState] = useState<MicState>("idle");
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);

  const setMic = (s: MicState) => { setState(s); onState?.(s); };

  const cleanupAudio = () => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    if (audioCtxRef.current) { audioCtxRef.current.close().catch(() => {}); audioCtxRef.current = null; }
  };

  const stop = () => {
    cleanupAudio();
    try { recorderRef.current?.stop(); } catch { /* ignore */ }
    recorderRef.current = null;
  };

  // Clean up if unmounted mid-recording.
  useEffect(() => () => { cleanupAudio(); streamRef.current?.getTracks().forEach((t) => t.stop()); }, []);

  const start = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || "audio/webm" });
        if (blob.size < 1200) { setMic("idle"); return; } // too short / silent
        setMic("busy");
        try {
          const audio = await blobToBase64(blob);
          const res = await fetch("/api/transcribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ audio, mimeType: mr.mimeType }),
          });
          const d = (await res.json()) as { text?: string; error?: string };
          if (res.ok && d.text) onTranscript(d.text);
          else if (d.error) setError(d.error);
        } catch {
          setError("Couldn't transcribe. Try again.");
        } finally {
          setMic("idle");
        }
      };
      mr.start();
      recorderRef.current = mr;
      setMic("recording");

      // Silence-based auto-stop using the Web Audio level.
      try {
        const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new AudioCtx();
        audioCtxRef.current = ctx;
        const srcNode = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        srcNode.connect(analyser);
        const buf = new Uint8Array(analyser.fftSize);
        const startedAt = Date.now();
        let spoke = false;
        let silenceStart = 0;
        const SILENCE_MS = 1600;
        const THRESHOLD = 0.014;
        const MAX_MS = 25000;
        const tick = () => {
          if (!recorderRef.current) return;
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
          const rms = Math.sqrt(sum / buf.length);
          const now = Date.now();
          if (rms > THRESHOLD) { spoke = true; silenceStart = 0; }
          else if (spoke) {
            if (!silenceStart) silenceStart = now;
            else if (now - silenceStart > SILENCE_MS) { stop(); return; }
          }
          if (now - startedAt > MAX_MS) { stop(); return; }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch { /* silence detection unavailable — manual stop still works */ }
    } catch {
      setError("Microphone access was blocked.");
      setMic("idle");
    }
  };

  const toggle = () => {
    if (state === "recording") stop();
    else if (state === "idle") start();
  };

  return (
    <div className="relative flex-shrink-0">
      <button
        type="button"
        disabled={disabled || state === "busy"}
        onClick={toggle}
        aria-label={state === "recording" ? "Stop recording" : "Voice input"}
        title={state === "recording" ? "Stop" : "Speak"}
        className={cn(
          "flex items-center justify-center rounded-8 transition-all active:scale-95",
          state === "recording"
            ? "bg-accent-crimson text-accent-white"
            : "text-black-alpha-40 hover:bg-black-alpha-4 hover:text-accent-black",
          state === "busy" && "opacity-60 cursor-wait",
          className,
        )}
        style={{ width: size, height: size }}
      >
        {state === "busy" ? (
          <span className="w-14 h-14 border-2 border-black-alpha-16 border-t-heat-100 rounded-full animate-spin" />
        ) : state === "recording" ? (
          <span className="relative flex items-center justify-center">
            <span className="absolute inline-flex h-18 w-18 rounded-full bg-accent-white/40 animate-ping" />
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
          </span>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="2" width="6" height="12" rx="3" />
            <path d="M5 10a7 7 0 0 0 14 0M12 19v3" />
          </svg>
        )}
      </button>
      {error && (
        <div
          className="absolute bottom-full right-0 mb-8 w-[240px] px-12 py-10 rounded-10 text-mono-x-small leading-relaxed z-30"
          style={{ background: "#eb3424", color: "#ffffff", boxShadow: "0 10px 28px rgba(0,0,0,0.22)" }}
          role="alert"
        >
          {error}
          <button
            type="button"
            onClick={() => setError(null)}
            className="ml-2 underline opacity-80 hover:opacity-100"
          >
            dismiss
          </button>
        </div>
      )}
    </div>
  );
}
