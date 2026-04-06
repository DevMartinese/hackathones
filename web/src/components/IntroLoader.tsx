import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

// Lazy import keeps the heavy three.js / WebGPU bundle out of the home's
// initial JS payload — it loads as a separate chunk in parallel.
const IntroSparkle = lazy(() => import("./loader-variants/IntroSparkle"));

type Phase = "preparing" | "ready" | "loading" | "shrinking" | "settled";

const LOADING_MS = 6000;
const SHRINK_MS = 900;
const BAR_WIDTH = 24;

function hasWebGPU(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

// ---------- Audio (Hans Zimmer flavor) ----------
// BRAAAM + sub-bass drone + detuned sawtooth pad + cathedral reverb,
// all filtered by a lowpass that opens over the 6s for rising tension.

type ToneModule = typeof import("tone");

type AudioGraph = {
  Tone: ToneModule;
  master: InstanceType<ToneModule["Gain"]>;
  reverb: InstanceType<ToneModule["Reverb"]>;
  sub: InstanceType<ToneModule["Oscillator"]>;
  subLow: InstanceType<ToneModule["Oscillator"]>;
  pad1: InstanceType<ToneModule["Oscillator"]>;
  pad2: InstanceType<ToneModule["Oscillator"]>;
  pad3: InstanceType<ToneModule["Oscillator"]>;
  pad4: InstanceType<ToneModule["Oscillator"]>;
  padFilter: InstanceType<ToneModule["Filter"]>;
  braaam: InstanceType<ToneModule["MonoSynth"]>;
};

async function buildAudio(): Promise<AudioGraph> {
  const Tone = await import("tone");

  // Cathedral-sized reverb.
  const reverb = new Tone.Reverb({ decay: 6, preDelay: 0.04, wet: 0.55 });
  await reverb.ready;
  reverb.toDestination();

  // Master gain — sits right before the reverb so we can fade the whole mix.
  const master = new Tone.Gain(0).connect(reverb);

  // Deep sub-bass drone (A0 + A1).
  const subLow = new Tone.Oscillator({
    type: "sine",
    frequency: 27.5, // A0
    volume: -6,
  });
  const sub = new Tone.Oscillator({
    type: "sine",
    frequency: 55, // A1
    volume: -14,
  });
  subLow.connect(master);
  sub.connect(master);

  // Strings-like pad — sawtooths detuned for thickness, chord A2 + E3.
  const padFilter = new Tone.Filter({
    type: "lowpass",
    frequency: 280,
    Q: 1.8,
  });
  padFilter.connect(master);

  const pad1 = new Tone.Oscillator({
    type: "sawtooth",
    frequency: 110, // A2
    volume: -22,
  });
  const pad2 = new Tone.Oscillator({
    type: "sawtooth",
    frequency: 110,
    detune: 8,
    volume: -22,
  });
  const pad3 = new Tone.Oscillator({
    type: "sawtooth",
    frequency: 164.81, // E3
    volume: -26,
  });
  const pad4 = new Tone.Oscillator({
    type: "sawtooth",
    frequency: 164.81,
    detune: -7,
    volume: -26,
  });
  pad1.connect(padFilter);
  pad2.connect(padFilter);
  pad3.connect(padFilter);
  pad4.connect(padFilter);

  // BRAAAM — MonoSynth with big filter envelope.
  const braaam = new Tone.MonoSynth({
    oscillator: { type: "sawtooth" },
    envelope: { attack: 0.01, decay: 0.9, sustain: 0.35, release: 2.2 },
    filter: { type: "lowpass", Q: 3 },
    filterEnvelope: {
      baseFrequency: 90,
      octaves: 4,
      attack: 0.02,
      decay: 0.6,
      sustain: 0.15,
      release: 1.2,
    },
  });
  braaam.volume.value = -8;
  braaam.connect(master);

  return {
    Tone,
    master,
    reverb,
    sub,
    subLow,
    pad1,
    pad2,
    pad3,
    pad4,
    padFilter,
    braaam,
  };
}

function disposeAudio(audio: AudioGraph | null) {
  if (!audio) return;
  const oscs = [
    audio.sub,
    audio.subLow,
    audio.pad1,
    audio.pad2,
    audio.pad3,
    audio.pad4,
  ];
  for (const o of oscs) {
    try {
      o.stop();
    } catch {}
    o.dispose();
  }
  audio.braaam.dispose();
  audio.padFilter.dispose();
  audio.master.dispose();
  audio.reverb.dispose();
}

export default function IntroLoader() {
  const [mounted, setMounted] = useState(false);
  const [phase, setPhase] = useState<Phase>("preparing");
  const [progress, setProgress] = useState(0);
  const [audio, setAudio] = useState<AudioGraph | null>(null);
  const audioStartedRef = useRef(false);

  // Decide on mount whether to show the intro at all.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const root = document.documentElement;
    if (prefersReducedMotion() || !hasWebGPU()) {
      root.classList.remove("intro-pending");
      return;
    }
    setMounted(true);
  }, []);

  // Build the audio graph (async — downloads Tone.js + generates reverb IR).
  useEffect(() => {
    if (!mounted) return;
    let disposed = false;
    let localAudio: AudioGraph | null = null;
    buildAudio()
      .then((a) => {
        if (disposed) {
          disposeAudio(a);
          return;
        }
        localAudio = a;
        setAudio(a);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      disposeAudio(localAudio);
      setAudio(null);
    };
  }, [mounted]);

  // Shader is ready → move to "ready" (waiting for user gesture).
  const handleShaderReady = useCallback(() => {
    setPhase((current) => (current === "preparing" ? "ready" : current));
  }, []);

  // Reveal terminal underneath as soon as the shader starts retreating.
  useEffect(() => {
    if (phase === "shrinking" || phase === "settled") {
      document.documentElement.classList.remove("intro-pending");
    }
  }, [phase]);

  // begin() is shared between the document gesture listeners (desktop fast
  // path: keydown/click) and the explicit button (mobile reliable path).
  // Idempotent via triggeredRef so duplicate fires are safe.
  const triggeredRef = useRef(false);
  const begin = useCallback(async () => {
    if (triggeredRef.current) return;
    triggeredRef.current = true;
    if (audio) {
      try {
        await audio.Tone.start();
      } catch {}
    }
    setPhase("loading");
  }, [audio]);

  // In "ready": wait for any gesture, then unlock audio and move to loading.
  useEffect(() => {
    if (phase !== "ready") return;
    triggeredRef.current = false;

    document.addEventListener("pointerdown", begin);
    document.addEventListener("keydown", begin);
    document.addEventListener("touchstart", begin);

    return () => {
      document.removeEventListener("pointerdown", begin);
      document.removeEventListener("keydown", begin);
      document.removeEventListener("touchstart", begin);
    };
  }, [phase, begin]);

  // Hand focus to the terminal textarea once the loader has fully settled
  // — otherwise the user has to click into it manually before typing.
  useEffect(() => {
    if (phase !== "settled") return;
    const t = window.setTimeout(() => {
      const cmd = document.getElementById("cmd") as HTMLTextAreaElement | null;
      if (cmd && typeof cmd.focus === "function") {
        cmd.focus({ preventScroll: true });
      }
    }, 80);
    return () => window.clearTimeout(t);
  }, [phase]);

  // In "loading": drive the bar, drive the audio, schedule shrink/settle.
  useEffect(() => {
    if (phase !== "loading") return;

    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min((now - start) / LOADING_MS, 1);
      setProgress(p);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    // Kick off the Hans Zimmer sequence.
    if (audio && !audioStartedRef.current) {
      audioStartedRef.current = true;
      const ctxReady = audio.Tone.getContext().state === "running";
      if (ctxReady) {
        const now = audio.Tone.now();
        const loadingSec = LOADING_MS / 1000;

        // Start all sustained oscillators.
        audio.sub.start(now);
        audio.subLow.start(now);
        audio.pad1.start(now);
        audio.pad2.start(now);
        audio.pad3.start(now);
        audio.pad4.start(now);

        // Master swell: fade in over 1.2s.
        audio.master.gain.setValueAtTime(0, now);
        audio.master.gain.linearRampToValueAtTime(0.9, now + 1.2);

        // Filter opens over the full duration for tension.
        audio.padFilter.frequency.setValueAtTime(280, now);
        audio.padFilter.frequency.exponentialRampToValueAtTime(
          2800,
          now + loadingSec
        );

        // Opening BRAAAM on A1.
        audio.braaam.triggerAttackRelease("A1", "2n", now);

        // Mid tension hit on E2 around 60% in.
        audio.braaam.triggerAttackRelease(
          "E2",
          "4n",
          now + loadingSec * 0.6
        );

        // Climax hit on A2 just before the shrink.
        audio.braaam.triggerAttackRelease(
          "A2",
          "2n",
          now + loadingSec - 0.4
        );
      }
    }

    const t1 = window.setTimeout(() => setPhase("shrinking"), LOADING_MS);
    const t2 = window.setTimeout(
      () => setPhase("settled"),
      LOADING_MS + SHRINK_MS
    );

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [phase, audio]);

  // Fade audio out during the shrink.
  useEffect(() => {
    if (phase !== "shrinking") return;
    if (!audio || !audioStartedRef.current) return;
    const now = audio.Tone.now();
    audio.master.gain.cancelScheduledValues(now);
    audio.master.gain.setValueAtTime(audio.master.gain.value, now);
    audio.master.gain.linearRampToValueAtTime(0, now + SHRINK_MS / 1000);
    const stopTimer = window.setTimeout(() => {
      try {
        audio.sub.stop();
        audio.subLow.stop();
        audio.pad1.stop();
        audio.pad2.stop();
        audio.pad3.stop();
        audio.pad4.stop();
      } catch {}
    }, SHRINK_MS + 500);
    return () => window.clearTimeout(stopTimer);
  }, [phase, audio]);

  if (!mounted) return null;

  const filled = Math.floor(progress * BAR_WIDTH);
  const bar =
    phase === "loading" || phase === "shrinking" || phase === "settled"
      ? "\u2588".repeat(filled) + "\u2591".repeat(BAR_WIDTH - filled)
      : "\u2591".repeat(BAR_WIDTH);
  const pct = Math.floor(progress * 100);

  let label: string;
  let pctLabel: string;
  if (phase === "preparing") {
    label = "preparing shader...";
    pctLabel = "  --%";
  } else if (phase === "ready") {
    label = "press any key to begin";
    pctLabel = "ready";
  } else {
    label = "loading hackathones...";
    pctLabel = `${String(pct).padStart(3, " ")}%`;
  }

  return (
    <div className={`intro-loader intro-${phase}`} aria-hidden="true">
      <div className="intro-stage">
        <Suspense fallback={null}>
          <IntroSparkle
            paused={phase === "shrinking" || phase === "settled"}
            onReady={handleShaderReady}
          />
        </Suspense>
      </div>
      <div className="intro-bar">
        <pre className="intro-bar-line">[{bar}] {pctLabel}</pre>
        {phase === "ready" ? (
          <>
            <p className="intro-bar-label intro-bar-label-touchless">
              press any key to begin
            </p>
            <button
              type="button"
              className="intro-bar-button"
              onClick={begin}
            >
              [ tap to begin ]
            </button>
          </>
        ) : (
          <p className="intro-bar-label">{label}</p>
        )}
      </div>
    </div>
  );
}
