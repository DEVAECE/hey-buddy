// Offline voice: "Hey Buddy" wake word + dictation using the Vosk engine
// (runs locally, no audio leaves the PC), and replies via Windows' built-in voices.
/* global Vosk */
(function () {
  const MODEL_URL = 'app://buddy/model/vosk-model-small-en-us-0.15.tar.gz';

  // The small offline model often hears "buddy" as "body"/"buddie", so normal accepts those.
  const WAKE_PATTERNS = {
    strict: [/\b(?:hey|hi|okay|ok) buddy\b/],
    normal: [/\b(?:hey|hi|okay|ok|a|hay|he) (?:buddy|buddie|body)\b/, /^(?:buddy|body)\b/],
    relaxed: [
      /\b(?:hey|hi|okay|ok|a|hay|he|they) (?:buddy|body|bodie|bodhi|buddie|buddha|birdie|birdy|but he|bunny|butty)\b/,
      /^(?:buddy|body|bodhi|buddie)\b/,
    ],
  };
  const FILLER = new Set(['the', 'huh', 'uh', 'um', 'a', 'oh', 'hmm']);

  class Voice {
    constructor(opts) {
      this.o = opts; // { getSettings, onStatus, onWake, onPartial, onCommand, onCancel }
      this.mode = 'stopped'; // stopped | loading | wake | paused | command
      this.buffer = '';
      this.lastSpeechEnd = 0;
      this.timers = {};
      this.heard = []; // recent final transcripts, for the Voice check in Settings
      this.micDeviceId = '';
    }

    // Microphone in use, and its current loudness (0..1) for the level meter.
    get micLabel() { return this.stream ? this.stream.getAudioTracks()[0]?.label || '' : ''; }
    level() {
      if (!this.analyser) return 0;
      const buf = new Float32Array(this.analyser.fftSize);
      this.analyser.getFloatTimeDomainData(buf);
      let sum = 0; for (const v of buf) sum += v * v;
      return Math.min(1, Math.sqrt(sum / buf.length) * 8);
    }

    async _getMic(deviceId) {
      const audio = { echoCancellation: true, noiseSuppression: true, channelCount: 1 };
      if (deviceId) {
        try { return await navigator.mediaDevices.getUserMedia({ audio: { ...audio, deviceId: { exact: deviceId } }, video: false }); }
        catch (e) { console.warn('Chosen microphone unavailable, using the Windows default', e); }
      }
      return navigator.mediaDevices.getUserMedia({ audio, video: false });
    }

    _closeMic() {
      clearInterval(this.timers.keepalive);
      try { this.proc && this.proc.disconnect(); } catch (_) {}
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      if (this.ctx) this.ctx.close().catch(() => {});
      this.proc = this.stream = this.ctx = this.analyser = null;
    }

    // Re-open the microphone (e.g. after choosing a different one in Settings).
    async switchMic() {
      if (this.mode === 'stopped' || this.mode === 'loading') return;
      const mode = this.mode === 'command' ? (this.settings.wakeWordEnabled ? 'wake' : 'paused') : this.mode;
      this._clearTimers();
      this._closeMic();
      this.mode = 'stopped';
      await this.start();
      if (this.mode !== 'stopped') { this.mode = mode; this._idleStatus(); }
    }

    get settings() { return this.o.getSettings(); }

    status(state, text) { this.o.onStatus && this.o.onStatus(state, text); }

    async start() {
      if (this.mode !== 'stopped') return;
      this.mode = 'loading';
      this.status('loading', 'Loading voice engine…');
      try {
        if (!this.model) this.model = await Vosk.createModel(MODEL_URL, -1);
      } catch (e) {
        console.error(e);
        this.mode = 'stopped';
        this.status('error', 'Voice engine failed to load');
        return;
      }
      try {
        this.micDeviceId = this.settings.micDeviceId || '';
        this.stream = await this._getMic(this.micDeviceId);
      } catch (e) {
        console.error(e);
        this.mode = 'stopped';
        this.status('error', 'Microphone blocked - check Windows privacy settings');
        return;
      }
      this.ctx = new AudioContext();
      if (this.ctx.state === 'suspended') { try { await this.ctx.resume(); } catch (_) {} }
      this.rec = new this.model.KaldiRecognizer(this.ctx.sampleRate);
      this.rec.on('result', (m) => this._onResult((m.result && m.result.text) || ''));
      this.rec.on('partialresult', (m) => this._onPartial((m.result && m.result.partial) || ''));

      const src = this.ctx.createMediaStreamSource(this.stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      src.connect(this.analyser);
      this.proc = this.ctx.createScriptProcessor(4096, 1, 1);
      this.proc.onaudioprocess = (ev) => {
        if (this.mode !== 'wake' && this.mode !== 'command') return;
        try { this.rec.acceptWaveform(ev.inputBuffer); } catch (err) { /* ignore */ }
      };
      src.connect(this.proc);
      this.proc.connect(this.ctx.destination); // output is silent; needed so the node runs

      this.mode = this.settings.wakeWordEnabled ? 'wake' : 'paused';
      this._idleStatus();
      // Some systems suspend audio after sleep; keep it alive.
      this.timers.keepalive = setInterval(() => { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); }, 5000);
    }

    _idleStatus() {
      if (this.mode === 'wake') this.status('idle', 'Listening for "Hey Buddy"');
      else if (this.mode === 'paused') this.status('off', 'Wake word off - click the orb or press Ctrl+Space to talk');
    }

    setWakeEnabled(on) {
      if (this.mode === 'stopped' || this.mode === 'loading') return;
      if (this.mode === 'command') return; // apply after the command ends
      this.mode = on ? 'wake' : 'paused';
      this._idleStatus();
    }

    get ready() { return this.mode === 'wake' || this.mode === 'paused' || this.mode === 'command'; }

    // Manual push-to-talk (orb / mic button / Ctrl+Space)
    listenNow() {
      if (!this.ready) {
        if (this.mode === 'stopped') this.start().then(() => this.ready && this.listenNow());
        return;
      }
      if (this.mode === 'command') { this.cancel(); return; }
      this._enterCommand('');
    }

    cancel() {
      if (this.mode !== 'command') return;
      this._clearTimers();
      this.buffer = '';
      this.mode = this.settings.wakeWordEnabled ? 'wake' : 'paused';
      this._idleStatus();
      this.o.onCancel && this.o.onCancel();
    }

    _wakeMatch(text) {
      const pats = WAKE_PATTERNS[this.settings.wakeSensitivity] || WAKE_PATTERNS.normal;
      for (const p of pats) {
        const m = p.exec(text);
        if (m) return { index: m.index, end: m.index + m[0].length };
      }
      return null;
    }

    _strip(text) {
      const m = this._wakeMatch(text);
      return (m ? text.slice(m.end) : text).trim();
    }

    _ttsRecentlyActive() {
      return window.speechSynthesis.speaking || Date.now() - this.lastSpeechEnd < 700;
    }

    _enterCommand(initial) {
      this._clearTimers();
      this.mode = 'command';
      this.buffer = '';
      this.heardSomething = false;
      window.speechSynthesis.cancel();
      this.status('active', 'Listening…');
      this.o.onWake && this.o.onWake(initial);
      this._armSilence(9000);
    }

    _armSilence(ms) {
      clearTimeout(this.timers.silence);
      this.timers.silence = setTimeout(() => {
        if (this.mode !== 'command') return;
        if (this.buffer.trim()) this._finish();
        else this.cancel();
      }, ms);
    }

    _onPartial(partial) {
      if (!partial) return;
      if (this.mode === 'wake') {
        if (this._ttsRecentlyActive()) return;
        if (this._wakeMatch(partial)) this._enterCommand(this._strip(partial));
        return;
      }
      if (this.mode === 'command') {
        clearTimeout(this.timers.finalize);
        const live = this._strip(partial);
        if (live) this.heardSomething = true;
        this.o.onPartial && this.o.onPartial((this.buffer + ' ' + live).trim());
        this._armSilence(5000);
      }
    }

    _onResult(text) {
      text = (text || '').trim();
      if (text) {
        this.heard.push({ text, at: Date.now(), wake: !!this._wakeMatch(text) || this.mode === 'command' });
        if (this.heard.length > 6) this.heard.shift();
      }
      if (this.mode === 'wake') {
        if (!text || this._ttsRecentlyActive()) return;
        if (this._wakeMatch(text)) {
          const after = this._strip(text);
          this._enterCommand(after);
          if (meaningful(after)) { this.buffer = after; this._scheduleFinish(); }
        }
        return;
      }
      if (this.mode === 'command') {
        const t = this._strip(text);
        if (meaningful(t)) {
          this.buffer = (this.buffer + ' ' + t).trim();
          this.o.onPartial && this.o.onPartial(this.buffer);
          this._scheduleFinish();
        }
      }
    }

    // Wait briefly in case the user is just pausing mid-sentence.
    _scheduleFinish() {
      clearTimeout(this.timers.finalize);
      this.timers.finalize = setTimeout(() => this._finish(), 1500);
    }

    _finish() {
      const text = this.buffer.trim();
      this._clearTimers();
      this.buffer = '';
      this.mode = this.settings.wakeWordEnabled ? 'wake' : 'paused';
      this._idleStatus();
      if (text) this.o.onCommand && this.o.onCommand(text);
      else this.o.onCancel && this.o.onCancel();
    }

    _clearTimers() {
      clearTimeout(this.timers.silence);
      clearTimeout(this.timers.finalize);
    }

    // ---------- speaking ----------
    speak(text) {
      const s = this.settings;
      if (!s.speakReplies || !text) return;
      const clean = String(text)
        .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
        .replace(/\bT-(\d+)/g, 'task $1')
        .replace(/[*#_`]/g, '')
        .slice(0, 900);
      const u = new SpeechSynthesisUtterance(clean);
      const voice = window.speechSynthesis.getVoices().find((v) => v.name === s.voiceName);
      if (voice) u.voice = voice;
      u.rate = Number(s.speechRate) || 1;
      u.onend = u.onerror = () => { this.lastSpeechEnd = Date.now(); };
      window.speechSynthesis.speak(u);
    }
  }

  function meaningful(t) {
    if (!t) return false;
    const words = t.split(/\s+/).filter((w) => !FILLER.has(w));
    return words.length > 0;
  }

  window.BuddyVoice = Voice;
})();
