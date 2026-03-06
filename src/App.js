import { useState, useEffect, useRef, useCallback } from "react";

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────
const NUM_STARS = 12;
const SCHEDULE_AHEAD = 0.12;   // seconds to look ahead when scheduling
const SCHEDULER_INTERVAL = 20; // ms between scheduler ticks

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function getRhythmLabel(activeStars) {
  const count = activeStars.filter(Boolean).length;
  if (count === 1) return "4分音符";
  if (count === 2) return "8分音符";
  if (count === 3) return "3連符";
  if (count === 4) return "16分音符";
  if (count === 6) return "6連符";
  if (count === 12) return "32分音符";
  return `${count}分割`;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Median of array
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ─────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────
export default function Metronome() {
  // ── Playback state ──
  const [bpm, setBpm] = useState(140);
  const [isPlaying, setIsPlaying] = useState(false);
  const [activeStars, setActiveStars] = useState(() => {
    const s = Array(NUM_STARS).fill(false);
    s[0] = true;
    return s;
  });
  const [activeBeatStar, setActiveBeatStar] = useState(-1);

  // ── Mic / BPM detection state ──
  const [micActive, setMicActive] = useState(false);       // mic is running
  const [micStatus, setMicStatus] = useState("idle");      // idle | requesting | listening | error
  const [detectedBpm, setDetectedBpm] = useState(null);    // last detected value (display only)
  const [micLevel, setMicLevel] = useState(0);             // 0-1 for VU meter

  // ── Refs: audio engine ──
  const audioCtxRef    = useRef(null);
  const schedulerRef   = useRef(null);
  const nextBeatTimeRef = useRef(0);
  const currentSubRef  = useRef(0);

  // ── Refs: mic analysis ──
  const micStreamRef    = useRef(null);
  const micAnalyserRef  = useRef(null);
  const micSourceRef    = useRef(null);
  const micRafRef       = useRef(null);
  const prevEnergyRef   = useRef(0);
  const onsetTimesRef   = useRef([]);   // timestamps (AudioContext time) of detected beats
  

  // ── Refs: stable copies of state ──
  const bpmRef         = useRef(bpm);
  const activeStarsRef = useRef(activeStars);
  const isPlayingRef   = useRef(isPlaying);
  const bpmStateRef    = useRef(bpm);

  useEffect(() => { bpmRef.current = bpm; bpmStateRef.current = bpm; }, [bpm]);
  useEffect(() => { activeStarsRef.current = activeStars; }, [activeStars]);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);

  // ── Refs: long-press ──
  const longPressRef = useRef(null);

  // ─────────────────────────────────────────────
  // Geometry helpers
  // ─────────────────────────────────────────────
  const getStarPosition = (index) => {
    const angle = (index / NUM_STARS) * 2 * Math.PI - Math.PI / 2;
    const r = 42;
    return { cx: 50 + r * Math.cos(angle), cy: 50 + r * Math.sin(angle) };
  };

  const starPath = (cx, cy, outerR = 6.2, innerR = 2.5) => {
    const pts = [];
    for (let p = 0; p < 16; p++) {
      const a = (p / 16) * 2 * Math.PI - Math.PI / 2;
      const radius = p % 2 === 0 ? outerR : innerR;
      pts.push(`${cx + radius * Math.cos(a)},${cy + radius * Math.sin(a)}`);
    }
    return "M" + pts.join("L") + "Z";
  };

  // ─────────────────────────────────────────────
  // Audio engine: click synthesis
  // ─────────────────────────────────────────────
  const scheduleClick = useCallback((ctx, time, isAccent) => {
    if (isAccent) {
      // Accent: bright triangle + sine layer
      const osc  = ctx.createOscillator(), g  = ctx.createGain();
      const osc2 = ctx.createOscillator(), g2 = ctx.createGain();
      osc.connect(g);   g.connect(ctx.destination);
      osc2.connect(g2); g2.connect(ctx.destination);
      osc.type = "triangle"; osc.frequency.value = 2200;
      g.gain.setValueAtTime(0, time);
      g.gain.linearRampToValueAtTime(1.0, time + 0.001);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.035);
      osc.start(time); osc.stop(time + 0.04);
      osc2.type = "sine"; osc2.frequency.value = 1100;
      g2.gain.setValueAtTime(0, time);
      g2.gain.linearRampToValueAtTime(0.4, time + 0.001);
      g2.gain.exponentialRampToValueAtTime(0.001, time + 0.025);
      osc2.start(time); osc2.stop(time + 0.03);
    } else {
      // Sub-beat: soft sine click
      const osc = ctx.createOscillator(), g = ctx.createGain();
      osc.connect(g); g.connect(ctx.destination);
      osc.type = "sine"; osc.frequency.value = 1000;
      g.gain.setValueAtTime(0, time);
      g.gain.linearRampToValueAtTime(0.45, time + 0.002);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.04);
      osc.start(time); osc.stop(time + 0.045);
    }
  }, []);

  // ─────────────────────────────────────────────
  // Audio engine: scheduler
  //   Uses Web Audio API currentTime for precise timing.
  //   Schedules audio SCHEDULE_AHEAD seconds ahead,
  //   sets visual timeout derived from the same timestamp.
  // ─────────────────────────────────────────────
  const scheduleBeats = useCallback(() => {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    const stars = activeStarsRef.current;
    if (!stars.some(Boolean)) return;

    // One full 12-subdivision cycle = one quarter-note beat
    // Slot duration = (60 / bpm) / 12
    const slotDur = 60 / bpmRef.current / 12;

    while (nextBeatTimeRef.current < ctx.currentTime + SCHEDULE_AHEAD) {
      const sub      = currentSubRef.current % 12;
      const beatTime = nextBeatTimeRef.current;

      if (stars[sub]) {
        scheduleClick(ctx, beatTime, sub === 0);

        // Visual flash: fire setTimeout aligned to the audio timestamp
        const delayMs = (beatTime - ctx.currentTime) * 1000;
        const s = sub, sd = slotDur;
        setTimeout(() => {
          if (!isPlayingRef.current) return;
          setActiveBeatStar(s);
          setTimeout(() => setActiveBeatStar(cur => cur === s ? -1 : cur),
            Math.min(200, sd * 600 * 12));
        }, Math.max(0, delayMs));
      }

      nextBeatTimeRef.current += slotDur;
      currentSubRef.current  += 1;
    }
  }, [scheduleClick]);

  const getOrCreateAudioCtx = useCallback(() => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtxRef.current.state === "suspended") audioCtxRef.current.resume();
    return audioCtxRef.current;
  }, []);

  const startScheduler = useCallback(() => {
    const ctx = getOrCreateAudioCtx();
    nextBeatTimeRef.current = ctx.currentTime + 0.05;
    currentSubRef.current   = 0;
    scheduleBeats();
    schedulerRef.current = setInterval(scheduleBeats, SCHEDULER_INTERVAL);
  }, [getOrCreateAudioCtx, scheduleBeats]);

  const stopScheduler = useCallback(() => {
    if (schedulerRef.current) { clearInterval(schedulerRef.current); schedulerRef.current = null; }
    setActiveBeatStar(-1);
  }, []);

  // Restart scheduler when playing and bpm changes
  const restartScheduler = useCallback(() => {
    if (!isPlayingRef.current || !audioCtxRef.current) return;
    if (schedulerRef.current) clearInterval(schedulerRef.current);
    nextBeatTimeRef.current = audioCtxRef.current.currentTime + 0.05;
    currentSubRef.current   = 0;
    scheduleBeats();
    schedulerRef.current = setInterval(scheduleBeats, SCHEDULER_INTERVAL);
  }, [scheduleBeats]);

  useEffect(() => {
    if (isPlaying) startScheduler();
    else stopScheduler();
    return stopScheduler;
  }, [isPlaying]); // eslint-disable-line

  useEffect(() => { restartScheduler(); }, [bpm]); // eslint-disable-line

  // ─────────────────────────────────────────────
  // BPM detection: onset detection via spectral flux
  //
  //   Algorithm:
  //   1. Every ~20ms, grab frequency-domain data (AnalyserNode).
  //   2. Compute per-bin positive flux (energy increase) → "onset strength".
  //   3. If flux exceeds adaptive threshold, record onset timestamp.
  //   4. Collect last N onset intervals → median → BPM estimate.
  //   5. Apply octave-band correction (halve/double if too far from 60-180).
  // ─────────────────────────────────────────────
  const analyseMic = useCallback(() => {
    const analyser = micAnalyserRef.current;
    if (!analyser) return;

    const bufLen  = analyser.frequencyBinCount;
    const freqBuf = new Float32Array(bufLen);
    const timeBuf = new Float32Array(analyser.fftSize);

    // Adaptive threshold state (closure-level)
    let prevSpectrum = new Float32Array(bufLen);
    let threshold    = 0.015;
    let lastOnset    = 0;
    const MIN_ONSET_GAP = 0.2; // seconds — ignore onsets closer than this

    const tick = () => {
      micRafRef.current = requestAnimationFrame(tick);

      const ctx = audioCtxRef.current;
      if (!ctx) return;
      const now = ctx.currentTime;

      analyser.getFloatFrequencyData(freqBuf);
      analyser.getFloatTimeDomainData(timeBuf);

      // ── VU meter (RMS of time-domain) ──
      let rms = 0;
      for (let i = 0; i < timeBuf.length; i++) rms += timeBuf[i] * timeBuf[i];
      rms = Math.sqrt(rms / timeBuf.length);
      setMicLevel(clamp(rms * 8, 0, 1));

      // ── Spectral flux (positive only, focus on 60–4000 Hz for drums/bass) ──
      // AnalyserNode gives dBFS, convert to linear power
      let flux = 0;
      // Only use bins covering roughly 60–4000 Hz
      // binHz = sampleRate / fftSize
      const binHz  = (ctx.sampleRate || 44100) / analyser.fftSize;
      const loB    = Math.floor(60   / binHz);
      const hiB    = Math.ceil(4000  / binHz);
      for (let b = loB; b < Math.min(hiB, bufLen); b++) {
        const power     = Math.pow(10, freqBuf[b] / 20);
        const prevPower = Math.pow(10, prevSpectrum[b] / 20);
        const diff = power - prevPower;
        if (diff > 0) flux += diff;
      }
      prevSpectrum = freqBuf.slice();

      // ── Adaptive threshold (slowly tracks background flux) ──
      threshold = threshold * 0.97 + flux * 0.03 * 1.5;
      const dynThreshold = Math.max(threshold * 1.4, 0.012);

      // ── Onset detection ──
      if (flux > dynThreshold && (now - lastOnset) > MIN_ONSET_GAP) {
        lastOnset = now;
        const onsets = onsetTimesRef.current;
        onsets.push(now);
        if (onsets.length > 24) onsets.shift();

        if (onsets.length >= 4) {
          // Compute intervals between consecutive onsets
          const intervals = [];
          for (let i = 1; i < onsets.length; i++) {
            intervals.push(onsets[i] - onsets[i - 1]);
          }

          // Remove outliers: keep only intervals within ±40% of median
          const med = median(intervals);
          const filtered = intervals.filter(iv => Math.abs(iv - med) / med < 0.4);
          if (filtered.length < 2) return;

          let estimatedBpm = 60 / median(filtered);

          // Octave correction: bring into 50–200 BPM range
          while (estimatedBpm < 50)  estimatedBpm *= 2;
          while (estimatedBpm > 200) estimatedBpm /= 2;

          const rounded = Math.round(estimatedBpm);
          if (rounded >= 40 && rounded <= 240) {
            setDetectedBpm(rounded);
            // Smooth update to actual BPM: blend toward detected value
            const current = bpmStateRef.current;
            const smoothed = Math.round(current * 0.4 + rounded * 0.6);
            const clamped  = clamp(smoothed, 40, 240);
            bpmStateRef.current = clamped;
            setBpm(clamped);
          }
        }
      }
    };
    tick();
  }, []);

  const [micDevices, setMicDevices] = useState([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("default");

  const loadMicDevices = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter(d => d.kind === "audioinput");
      setMicDevices(audioInputs);
      // Prefer built-in / internal mic
      const builtin = audioInputs.find(d =>
        /built.?in|internal|内蔵/i.test(d.label)
      );
      if (builtin) setSelectedDeviceId(builtin.deviceId);
    } catch (_) {}
  }, []);

  const startMic = useCallback(async () => {
    if (navigator.permissions) {
      try {
        const perm = await navigator.permissions.query({ name: "microphone" });
        if (perm.state === "denied") { setMicStatus("error"); return; }
      } catch (_) {}
    }

    setMicStatus("requesting");
    try {
      // Build audio constraints — prefer selected device, fall back to default
      const audioConstraints = {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        ...(selectedDeviceId && selectedDeviceId !== "default"
          ? { deviceId: { exact: selectedDeviceId } }
          : {}),
      };

      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      micStreamRef.current = stream;

      // After permission granted, enumerate devices to get labels
      await loadMicDevices();

      const ctx = getOrCreateAudioCtx();
      const source   = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize             = 2048;
      analyser.smoothingTimeConstant = 0.5;
      source.connect(analyser);

      micSourceRef.current   = source;
      micAnalyserRef.current = analyser;
      onsetTimesRef.current  = [];

      setMicActive(true);
      setMicStatus("listening");
      analyseMic();
    } catch (err) {
      console.error("Mic error:", err.name, err.message);
      setMicStatus("error");
    }
  }, [getOrCreateAudioCtx, analyseMic, selectedDeviceId, loadMicDevices]);

  const stopMic = useCallback(() => {
    if (micRafRef.current) { cancelAnimationFrame(micRafRef.current); micRafRef.current = null; }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(t => t.stop());
      micStreamRef.current = null;
    }
    if (micSourceRef.current)  { micSourceRef.current.disconnect();  micSourceRef.current  = null; }
    micAnalyserRef.current = null;
    onsetTimesRef.current  = [];
    setMicActive(false);
    setMicStatus("idle");
    setDetectedBpm(null);
    setMicLevel(0);
  }, []);

  // Cleanup on unmount
  useEffect(() => () => {
    stopMic();
    stopScheduler();
  }, []); // eslint-disable-line

  // ─────────────────────────────────────────────
  // Tap tempo
  // ─────────────────────────────────────────────
  const tapTimesRef = useRef([]);
  const handleTap = useCallback(() => {
    const now = Date.now();
    const taps = tapTimesRef.current;
    taps.push(now);
    if (taps.length > 8) taps.shift();
    if (taps.length >= 2) {
      const intervals = [];
      for (let i = 1; i < taps.length; i++) intervals.push(taps[i] - taps[i - 1]);
      const avg     = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const newBpm  = clamp(Math.round(60000 / avg), 20, 300);
      bpmStateRef.current = newBpm;
      setBpm(newBpm);
    }
    setTimeout(() => {
      if (tapTimesRef.current.length > 0) {
        const last = tapTimesRef.current[tapTimesRef.current.length - 1];
        if (Date.now() - last > 3000) tapTimesRef.current = [];
      }
    }, 3100);
  }, []);

  // ─────────────────────────────────────────────
  // +/− with long-press acceleration
  // ─────────────────────────────────────────────
  const changeBpm = useCallback((delta) => {
    const next = clamp(bpmStateRef.current + delta, 20, 300);
    bpmStateRef.current = next;
    setBpm(next);
  }, []);

  const isTouchActiveRef = useRef(false);

  const startLongPress = useCallback((delta, isTouch = false) => {
    if (isTouch) {
      isTouchActiveRef.current = true;
    } else {
      // If touch already handled this, skip mouse event
      if (isTouchActiveRef.current) return;
    }
    changeBpm(delta);
    let speed = 300, step = 0;
    const tick = () => {
      changeBpm(delta);
      step++;
      if (step > 15)     speed = 50;
      else if (step > 5) speed = 120;
      longPressRef.current = setTimeout(tick, speed);
    };
    longPressRef.current = setTimeout(tick, speed);
  }, [changeBpm]);

  const stopLongPress = useCallback((isTouch = false) => {
    if (isTouch) {
      // Reset touch flag after a short delay so mouseup doesn't sneak in
      setTimeout(() => { isTouchActiveRef.current = false; }, 300);
    }
    if (longPressRef.current) { clearTimeout(longPressRef.current); longPressRef.current = null; }
  }, []);

  // ─────────────────────────────────────────────
  // Star toggle
  // ─────────────────────────────────────────────
  const toggleStar = useCallback((i) => {
    if (i === 0) return;
    setActiveStars(prev => { const n = [...prev]; n[i] = !n[i]; return n; });
  }, []);

  // ─────────────────────────────────────────────
  // Derived
  // ─────────────────────────────────────────────
  const rhythmLabel = getRhythmLabel(activeStars);


  // ─────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────
  return (
    <div style={{
      minHeight: "100vh",
      background: "#F0EFE8",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: "'Georgia', serif",
      userSelect: "none",
      WebkitUserSelect: "none",
    }}>

      {/* ── Rhythm label ── */}
      <div style={{ marginBottom: 10, height: 24 }}>
        <span style={{ fontSize: 13, fontFamily: "monospace", color: "#3DBDB5", fontWeight: 700, letterSpacing: 2 }}>
          {rhythmLabel}
        </span>
      </div>

      {/* ── Stars circle + play button ── */}
      <div style={{ position: "relative", width: 320, height: 320 }}>
        <svg viewBox="0 0 100 100" style={{ width: "100%", height: "100%", overflow: "visible" }}>
          {Array.from({ length: NUM_STARS }).map((_, i) => {
            const { cx, cy } = getStarPosition(i);
            const isOn       = activeStars[i];
            const isBeat     = activeBeatStar === i;
            const isAccent   = i === 0;

            let fill   = "none";
            let stroke = "#4ECDC4";
            let glow   = null;
            if (isBeat) {
              fill   = isAccent ? "#FF6B35" : "#FFD700";
              stroke = isAccent ? "#FF4500" : "#FFD700";
              glow   = isAccent ? "#FF6B35" : "#FFD700";
            } else if (isOn) {
              fill   = isAccent ? "rgba(255,107,53,0.75)" : "rgba(78,205,196,0.55)";
              stroke = isAccent ? "#FF6B35" : "#4ECDC4";
            }

            return (
              <g key={i} onClick={() => toggleStar(i)} style={{ cursor: i === 0 ? "default" : "pointer" }}>
                {isBeat && (
                  <path d={starPath(cx, cy, 9, 4)} fill={glow} opacity={0.2}
                    style={{ filter: "blur(5px)" }} />
                )}
                <path
                  d={starPath(cx, cy)}
                  fill={fill} stroke={stroke} strokeWidth={0.75}
                  style={{
                    transition: isBeat ? "none" : "fill 0.15s, stroke 0.15s",
                    filter: isBeat ? `drop-shadow(0 0 3px ${glow})` : "none",
                    transform: isBeat ? "scale(1.15)" : "scale(1)",
                    transformOrigin: `${cx}px ${cy}px`,
                  }}
                />
                {/* Invisible hit area — large circle for easy tap */}
                <circle cx={cx} cy={cy} r={9} fill="transparent" />
              </g>
            );
          })}
        </svg>

        {/* Play / Pause */}
        <button
          onClick={() => setIsPlaying(p => !p)}
          style={{
            position: "absolute", top: "50%", left: "50%",
            transform: "translate(-50%, -50%)",
            width: 110, height: 110, borderRadius: "50%",
            background: isPlaying
              ? "linear-gradient(135deg, #FF6B35, #E8441A)"
              : "linear-gradient(135deg, #4ECDC4, #3DBDB5)",
            border: "none", cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: isPlaying
              ? "0 0 0 6px rgba(255,107,53,0.2), 0 8px 32px rgba(255,107,53,0.45)"
              : "0 4px 20px rgba(78,205,196,0.35)",
            transition: "background 0.25s ease, box-shadow 0.25s ease",
            outline: "none", WebkitTapHighlightColor: "transparent",
          }}
          onMouseDown={e => e.currentTarget.style.transform = "translate(-50%,-50%) scale(0.94)"}
          onMouseUp={e   => e.currentTarget.style.transform = "translate(-50%,-50%) scale(1)"}
          onTouchStart={e => e.currentTarget.style.transform = "translate(-50%,-50%) scale(0.94)"}
          onTouchEnd={e  => e.currentTarget.style.transform = "translate(-50%,-50%) scale(1)"}
        >
          {isPlaying ? (
            <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
              <rect x="8"  y="7" width="7" height="22" rx="2" fill="white" />
              <rect x="21" y="7" width="7" height="22" rx="2" fill="white" />
            </svg>
          ) : (
            <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
              <path d="M12 8L28 18L12 28V8Z" fill="white" />
            </svg>
          )}
        </button>
      </div>

      {/* ── BPM controls ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 28, marginTop: 24 }}>
        {/* − button */}
        <button
          onMouseDown={e => { e.currentTarget.style.transform = "scale(0.92)"; startLongPress(-1, false); }}
          onMouseUp={e   => { e.currentTarget.style.transform = "scale(1)";    stopLongPress(false); }}
          onMouseLeave={e=> { e.currentTarget.style.transform = "scale(1)";    stopLongPress(false); }}
          onTouchStart={e=> { e.preventDefault(); e.currentTarget.style.transform = "scale(0.92)"; startLongPress(-1, true); }}
          onTouchEnd={e  => { e.currentTarget.style.transform = "scale(1)";    stopLongPress(true); }}
          style={{
            width: 62, height: 62, borderRadius: "50%",
            background: "linear-gradient(135deg, #4ECDC4, #3DBDB5)",
            border: "none", cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: "0 4px 16px rgba(78,205,196,0.4)",
            outline: "none", transition: "transform 0.1s",
            WebkitTapHighlightColor: "transparent",
          }}
        >
          <svg width="22" height="4" viewBox="0 0 22 4">
            <rect x="0" y="0" width="22" height="4" rx="2" fill="white" />
          </svg>
        </button>

        {/* BPM tap display */}
        <div
          onClick={handleTap}
          title="タップでテンポ設定"
          style={{
            width: 110, textAlign: "center",
            fontSize: 64, fontWeight: 800,
            color: micActive ? "#2ECC71" : "#3DBDB5",
            cursor: "pointer", letterSpacing: -2, lineHeight: 1,
            fontFamily: "'Georgia', serif",
            textShadow: micActive
              ? "0 2px 12px rgba(46,204,113,0.35)"
              : "0 2px 8px rgba(61,189,181,0.2)",
            transition: "color 0.3s, text-shadow 0.3s",
            WebkitTapHighlightColor: "transparent",
          }}
        >
          {bpm}
        </div>

        {/* + button */}
        <button
          onMouseDown={e => { e.currentTarget.style.transform = "scale(0.92)"; startLongPress(1, false); }}
          onMouseUp={e   => { e.currentTarget.style.transform = "scale(1)";    stopLongPress(false); }}
          onMouseLeave={e=> { e.currentTarget.style.transform = "scale(1)";    stopLongPress(false); }}
          onTouchStart={e=> { e.preventDefault(); e.currentTarget.style.transform = "scale(0.92)"; startLongPress(1, true); }}
          onTouchEnd={e  => { e.currentTarget.style.transform = "scale(1)";    stopLongPress(true); }}
          style={{
            width: 62, height: 62, borderRadius: "50%",
            background: "linear-gradient(135deg, #4ECDC4, #3DBDB5)",
            border: "none", cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: "0 4px 16px rgba(78,205,196,0.4)",
            outline: "none", transition: "transform 0.1s",
            WebkitTapHighlightColor: "transparent",
          }}
        >
          <svg width="22" height="22" viewBox="0 0 22 22">
            <rect x="0" y="9" width="22" height="4" rx="2" fill="white" />
            <rect x="9" y="0" width="4" height="22" rx="2" fill="white" />
          </svg>
        </button>
      </div>

      {/* ── Mic section ── */}
      <div style={{ marginTop: 28, display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>

        {/* Device selector — shown when devices are available and mic not yet active */}
        {!micActive && micDevices.length > 0 && (
          <select
            value={selectedDeviceId}
            onChange={e => setSelectedDeviceId(e.target.value)}
            style={{
              padding: "6px 12px", borderRadius: 20,
              border: "1.5px solid rgba(78,205,196,0.5)",
              background: "#F0EFE8", color: "#3DBDB5",
              fontSize: 12, fontWeight: 600,
              outline: "none", cursor: "pointer",
              maxWidth: 240,
            }}
          >
            {micDevices.map(d => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `マイク ${d.deviceId.slice(0,6)}`}
              </option>
            ))}
          </select>
        )}

        {/* Mic toggle button */}
        <button
          onClick={() => micActive ? stopMic() : startMic()}
          style={{
            display: "flex", alignItems: "center", gap: 10,
            padding: "10px 24px", borderRadius: 32,
            background: micActive
              ? "linear-gradient(135deg, #1aad6c, #128a55)"
              : "linear-gradient(135deg, #4ECDC4, #3DBDB5)",
            border: "none", cursor: "pointer",
            color: "white", fontSize: 13, fontWeight: 700, letterSpacing: 1,
            boxShadow: micActive
              ? "0 4px 18px rgba(26,173,108,0.45)"
              : "0 4px 16px rgba(78,205,196,0.4)",
            transition: "all 0.25s ease",
            outline: "none", WebkitTapHighlightColor: "transparent",
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round">
            <rect x="9" y="2" width="6" height="11" rx="3" />
            <path d="M5 10a7 7 0 0 0 14 0" />
            <line x1="12" y1="19" x2="12" y2="22" />
            <line x1="8" y1="22" x2="16" y2="22" />
          </svg>
          {micActive ? "BPM検出中 — 停止" : "マイクでBPM検出"}
        </button>

        {/* Mic panel: shown while active */}
        {micActive && (() => {
          const SEG = 20;
          const filled = Math.round(micLevel * SEG);
          // Status label
          const statusLabel =
            micLevel < 0.02
              ? { text: "🎙 音声を待機中…", color: "#9BB0AE" }
              : detectedBpm
              ? { text: `✅ BPM検出完了`, color: "#2ECC71" }
              : { text: "🔍 ビート解析中…", color: "#FFD93D" };

          return (
            <div style={{
              width: 240, padding: "12px 16px", borderRadius: 14,
              background: "rgba(78,205,196,0.08)",
              border: "1px solid rgba(78,205,196,0.2)",
              display: "flex", flexDirection: "column", gap: 8,
            }}>
              {/* Label row */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 11, fontFamily: "monospace", color: statusLabel.color, fontWeight: 700, letterSpacing: 0.5, transition: "color 0.3s" }}>
                  {statusLabel.text}
                </span>
                {detectedBpm && (
                  <span style={{ fontSize: 12, fontFamily: "monospace", color: "#2ECC71", fontWeight: 800, letterSpacing: 1 }}>
                    {detectedBpm} BPM
                  </span>
                )}
              </div>

              {/* Segment VU meter */}
              <div style={{ display: "flex", gap: 2 }}>
                {Array.from({ length: SEG }).map((_, s) => {
                  const active = s < filled;
                  const isHigh = s >= SEG * 0.8;
                  const isMid  = s >= SEG * 0.55;
                  const color  = active
                    ? isHigh  ? "#E74C3C"
                    : isMid   ? "#FFD93D"
                    : "#2ECC71"
                    : "rgba(78,205,196,0.15)";
                  return (
                    <div key={s} style={{
                      flex: 1, height: 10, borderRadius: 2,
                      background: color,
                      transition: "background 0.04s",
                      boxShadow: active ? `0 0 4px ${color}` : "none",
                    }} />
                  );
                })}
              </div>

              {/* Sub-status row */}
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontSize: 10, color: "#9BB0AE", fontFamily: "monospace" }}>
                  入力レベル: {Math.round(micLevel * 100)}%
                </span>
                <span style={{ fontSize: 10, color: "#9BB0AE", fontFamily: "monospace" }}>
                  サンプル数: {Math.min(onsetTimesRef.current.length, 24)}/8
                </span>
              </div>
            </div>
          );
        })()}

        {/* Error state */}
        {micStatus === "error" && (
          <div style={{ textAlign: "center", maxWidth: 260 }}>
            <span style={{ fontSize: 12, color: "#E74C3C", fontFamily: "monospace", fontWeight: 700 }}>
              マイクへのアクセスが拒否されています
            </span>
            <br />
            <span style={{ fontSize: 11, color: "#9BB0AE", lineHeight: 1.7 }}>
              ブラウザのアドレスバー横のアイコン、または「設定 → サイトの設定 → マイク」からこのサイトの許可を変更してください。
            </span>
          </div>
        )}
      </div>

      {/* ── Hint ── */}
      <p style={{ marginTop: 20, fontSize: 11, color: "#9BB0AE", letterSpacing: 0.5, textAlign: "center", lineHeight: 1.9 }}>
        星をタップしてリズムを追加　／　数字タップ → タップテンポ<br />
        <span style={{ color: "#FF6B35", fontWeight: 700 }}>12時</span> は常にオン（アクセント音）
      </p>
    </div>
  );
}