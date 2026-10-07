/* global buddy, BuddySprite */
// The on-screen companion: a character that sits in the screen corner, walks in to
// deliver reminders and triggers in a speech bubble, and chats via the same AI as the main window.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const linkify = (s) => esc(s).replace(/\bT-\d+\b/g, (m) => `<button class="tlink" data-task="${m}">${m}</button>`);

  const charEl = $('#char'); const sprite = $('#sprite'); const img = $('#customImg'); const bubble = $('#bubble');
  const ctx = sprite.getContext('2d');
  // Render at the screen's real pixel density so the smooth robot stays sharp (96x120 CSS px box).
  const DPR = Math.max(1, Math.round((window.devicePixelRatio || 1) * 4) / 4);
  sprite.width = 96 * DPR; sprite.height = 120 * DPR;
  sprite.style.width = '96px'; sprite.style.height = '120px';
  const SCALE = 4 * DPR;
  const OFF = 170;          // px the character sits off-screen to the right when away
  const WALK_SPEED = 0.15;  // px per ms
  const ALERTS = new Set(['reminder', 'due']);
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let settings = {};
  let custom = null;        // { idle, talk } image URLs when a custom character is set
  let mode = 'offscreen'; let modeAt = performance.now();
  let x = OFF; let onArrive = null;
  let sleeping = false; let quietUntil = 0; let focusUntil = 0;
  let corner = 'br';          // br | bl | tr | tl: which screen corner the window sits in
  const dir = () => (corner[1] === 'l' ? -1 : 1); // the character walks in from the nearest side edge
  function applyCorner(c) {
    corner = ['br', 'bl', 'tr', 'tl'].includes(c) ? c : 'br';
    document.body.classList.remove('corner-br', 'corner-bl', 'corner-tr', 'corner-tl');
    document.body.classList.add(`corner-${corner}`);
  }
  applyCorner('br');
  let queue = []; let current = null;
  let timers = {};
  let typing = null;        // { text, shown, el, rate }
  let lastTranscript = '';

  const setMode = (m) => { mode = m; modeAt = performance.now(); };
  const later = (name, ms, fn) => { clearTimeout(timers[name]); timers[name] = setTimeout(fn, ms); };
  const cancel = (name) => clearTimeout(timers[name]);
  const act = (a) => buddy.companionAction(a);
  const name = () => (settings.userName ? `, ${settings.userName}` : '');

  // ---------------- character & mood ----------------
  const LOOK = { pixel: 'robot', pixelRobot: 'robotPixel', man: 'man', woman: 'woman' };
  const lookId = () => LOOK[settings.companionCharacter] || 'robot';
  const focusing = () => Date.now() < focusUntil;
  const minsLeft = () => Math.max(1, Math.ceil((focusUntil - Date.now()) / 60000));

  // focus (focus mode on) > night > weekend > Monday > Friday > plain
  function mood() {
    if (focusing()) return 'focus';
    if (settings.moodsEnabled === false) return 'plain';
    const d = new Date(); const h = d.getHours(); const day = d.getDay();
    if (h >= 21 || h < 6) return 'night';
    if (day === 0 || day === 6) return 'weekend';
    if (day === 1) return 'monday';
    if (day === 5) return 'friday';
    return 'plain';
  }
  const ACCESSORY = { focus: 'headphones', monday: 'headphones', friday: 'party', weekend: 'shades', night: 'nightcap' };

  function greeting() {
    const n = name();
    switch (mood()) {
      case 'focus': return `We're in focus mode${n}: ${minsLeft()} min to go. Need to note something quickly?`;
      case 'night': return `Working late${n}? I'm a little sleepy, but I'm here. What's up?`;
      case 'weekend': return `Hey${n}, it's the weekend! Want me to note anything for Monday?`;
      case 'monday': return `Happy Monday${n}! New week, let's get focused. What's first?`;
      case 'friday': return `Happy Friday${n}! Let's finish the week strong. What's up?`;
      default: return `Hi${n}! What's up? Tell me about a task, an update or a blocker.`;
    }
  }

  // ---------------- animation ----------------
  function pose(t) {
    const e = t - modeAt;
    const blink = Math.floor(t / 110) % 40 === 0;
    const step = Math.floor(e / 170) % 2 ? 'walk1' : 'walk2';
    const talking = typing && typing.shown < typing.text.length;
    const md = mood();
    switch (mode) {
      case 'drag': return { arms: 'up', eyes: 'happy', mouth: 'o', legs: Math.floor(e / 260) % 2 ? 'walk1' : 'walk2' }; // dangling
      case 'walkin': case 'walkout': return { legs: step };
      case 'wave': return { arms: Math.floor(e / 200) % 2 ? 'wave1' : 'wave2', eyes: 'happy', mouth: 'open' };
      case 'celebrate': return { arms: 'up', eyes: 'happy', mouth: 'open', legs: Math.floor(e / 320) % 2 ? 'jump' : 'stand' };
      case 'drink': return { arms: 'cup', eyes: 'closed', mouth: 'flat' };
      case 'stretch': return { arms: Math.floor(e / 500) % 2 ? 'stretch' : 'up', eyes: 'happy' };
      case 'listen': return { eyes: blink ? 'closed' : 'open', mouth: 'o', bulb: Math.floor(e / 400) % 2 === 0 };
      case 'think': return { eyes: Math.floor(e / 600) % 2 ? 'look-left' : 'look-right', mouth: 'flat' };
      case 'sleep': return { eyes: 'closed', mouth: 'flat', bulb: false };
      default: {
        const speak = talking && Math.floor(t / 140) % 2;
        if (md === 'night') { // droopy eyes, a yawn every ~9 s
          const yawn = t % 9000 < 1300;
          return { eyes: yawn || blink ? 'closed' : 'half', mouth: speak ? 'open' : yawn ? 'o' : 'flat' };
        }
        if (md === 'focus' || md === 'monday') return { eyes: blink ? 'closed' : 'open', mouth: speak ? 'open' : 'flat' };
        if (md === 'friday') return { eyes: t % 6000 < 1500 ? 'happy' : blink ? 'closed' : 'open', mouth: speak || t % 6000 < 1500 ? 'open' : 'smile' };
        return { eyes: blink ? 'closed' : 'open', mouth: speak ? 'open' : 'smile' };
      }
    }
  }

  function yOffset(t) {
    const e = t - modeAt;
    if (mode === 'celebrate') return reduceMotion ? 0 : -Math.abs(Math.sin(e / 160)) * 20;
    if (reduceMotion || mode === 'offscreen' || mode === 'drag') return 0;
    if (mode === 'walkin' || mode === 'walkout') return Math.floor(e / 170) % 2 ? -3 : 0;
    if (mode === 'sleep') return Math.floor(t / 1400) % 2 ? 2 : 0;
    const md = mood();
    if (md === 'friday' && mode === 'idle' && t % 6000 < 500) return -Math.sin(((t % 6000) / 500) * Math.PI) * 10; // happy hop
    if (md === 'focus' || md === 'monday') return 0; // still and steady
    return Math.floor(t / (md === 'night' ? 1400 : 700)) % 2 ? -2 : 0;
  }

  const badge = $('#badge');
  let badgeText = '';
  function updateBadge() {
    const text = focusing() ? `🎧 ${minsLeft()} min` : '';
    if (text !== badgeText) { badgeText = text; badge.textContent = text; badge.hidden = !text; }
  }

  let lastT = performance.now();
  function frame(t) {
    const dt = t - lastT; lastT = t;
    if (mode === 'walkin') {
      x = Math.max(0, x - dt * WALK_SPEED);
      if (x === 0) { setMode('idle'); const cb = onArrive; onArrive = null; if (cb) cb(); }
    } else if (mode === 'walkout') {
      x = Math.min(OFF, x + dt * WALK_SPEED);
      if (x === OFF) setMode('offscreen');
    }
    charEl.style.transform = `translate(${Math.round(x * dir())}px, ${Math.round(yOffset(t))}px)`;

    const p = pose(t);
    if (custom) {
      const src = p.mouth === 'open' && custom.talk ? custom.talk : custom.idle;
      if (img.getAttribute('src') !== src) img.setAttribute('src', src);
    } else {
      const md = mood();
      BuddySprite.draw(ctx, { ...p, acc: md === 'plain' ? null : (mode === 'sleep' && md !== 'focus' ? 'nightcap' : ACCESSORY[md]) }, SCALE, lookId());
    }
    updateBadge();

    if (typing && typing.shown < typing.text.length) {
      typing.shown = Math.min(typing.text.length, typing.shown + dt * typing.rate);
      typing.el.innerHTML = linkify(typing.text.slice(0, Math.ceil(typing.shown)));
    }
    requestAnimationFrame(frame);
  }

  function walkIn(cb) {
    sleepy(false);
    if (x === 0 && mode !== 'walkout') { cb && cb(); return; }
    onArrive = cb; setMode('walkin');
  }
  function walkOut() { onArrive = null; if (x < OFF) setMode('walkout'); }
  function sleepy(on) { charEl.classList.toggle('sleeping', on); }

  // Idle: sit in the corner (peek mode), sleep when away, or leave the screen.
  function goIdle() {
    bubble.hidden = true; typing = null;
    const peek = settings.companionPeek && Date.now() >= quietUntil;
    if (!peek) { sleepy(false); walkOut(); return; }
    const settle = () => { setMode(sleeping ? 'sleep' : 'idle'); sleepy(sleeping); };
    if (x > 0) walkIn(settle); else settle();
  }

  // ---------------- queue ----------------
  function enqueue(it) {
    if (ALERTS.has(it.kind)) {
      const i = queue.findIndex((q) => !ALERTS.has(q.kind));
      if (i < 0) queue.push(it); else queue.splice(i, 0, it);
    } else queue.push(it);
  }

  // A reminder may interrupt a check-in/break/chat the user hasn't started answering.
  const interruptible = (c) => c && !ALERTS.has(c.kind) && !c.engaged && !c.waiting && c.kind !== 'listen';

  function show(items) {
    items.forEach(enqueue);
    if (!current) { next(true); return; }
    if (ALERTS.has(queue[0]?.kind) && interruptible(current)) { finish(); return; }
    renderProgress();
  }

  function finish() { cancel('expire'); cancel('step'); current = null; next(false); }

  function next(greet) {
    current = queue.shift() || null;
    if (!current) { goIdle(); return; }
    const arriving = x > 0 || mode === 'offscreen' || mode === 'sleep' || mode === 'walkout';
    walkIn(() => {
      if (greet || arriving) {
        setMode('wave');
        later('step', reduceMotion ? 50 : 750, () => present(current));
      } else present(current);
    });
  }

  // ---------------- bubble content ----------------
  const HEAD = {
    reminder: 'Reminder', due: 'Due now', briefing: 'Your day', checkin: 'Check-in', wrapup: 'Wrap-up',
    water: 'Water break', stretch: 'Stretch break', welcome: 'Welcome back', chat: 'Buddy', info: 'Buddy',
    reply: 'Buddy', listen: 'Listening…', focusEnd: 'Focus done',
  };
  const EXPIRE = { briefing: 10, welcome: 2, checkin: 3, wrapup: 5, water: 3, stretch: 3, chat: 2, info: 1, reply: 1, listen: 0.5, focusEnd: 5 };

  function shortWhen(iso) {
    const d = new Date(iso); const t = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const day = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
    return day === 0 ? `today ${t}` : day === 1 ? `tomorrow ${t}` : day === -1 ? `yesterday ${t}` : `${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} ${t}`;
  }

  function head(kind) {
    const pending = queue.filter((q) => ALERTS.has(q.kind)).length;
    return `<div class="b-head"><b>${esc(HEAD[kind] || 'Buddy')}</b><span class="progress" id="prog">${ALERTS.has(kind) && pending ? `+${pending} more` : ''}</span>
      <button class="x" data-a="dismiss" title="Dismiss" aria-label="Dismiss">✕</button></div>`;
  }
  function renderProgress() {
    const el = $('#prog'); if (!el || !current) return;
    const pending = queue.filter((q) => ALERTS.has(q.kind)).length;
    el.textContent = ALERTS.has(current.kind) && pending ? `+${pending} more` : '';
  }
  const askBox = (ph) => `<div class="ask"><textarea id="askText" rows="1" placeholder="${esc(ph)}"></textarea><button class="a primary" data-a="send">Send</button></div>`;

  function say(text, el) {
    typing = { text, shown: reduceMotion ? text.length : 0, el, rate: Math.max(0.045, text.length / 2600) };
    el.innerHTML = reduceMotion ? linkify(text) : '';
  }

  function present(it) {
    cancel('expire');
    let body = '';
    let text = it.text || '';
    switch (it.kind) {
      case 'reminder': case 'due': {
        const meta = [it.taskId, it.due ? `due ${shortWhen(it.due)}` : '', it.status === 'Blocked' ? 'blocked' : ''].filter(Boolean).join(' · ');
        text = it.kind === 'due' ? `"${it.title}" is due now.` : `Don't forget: "${it.title}".`;
        const standalone = !it.taskId; // a reminder not tied to a task
        body = `<div class="title p-${esc(it.priority)}">${esc(it.title)}</div>
          <div class="meta">${esc(standalone ? (it.repeat && it.repeat !== 'none' ? `repeats ${it.repeat}` : '') : meta)}${it.late ? ' <span class="late">(missed while away)</span>' : ''}</div>
          ${it.note && it.note !== 'Snoozed' ? `<div class="say" id="say"></div>` : ''}
          <div class="actions">${standalone ? '<button class="a primary" data-a="dismiss">Got it</button>' : '<button class="a primary" data-a="done">Mark done</button>'}
          <button class="a" data-a="snooze" data-m="15">Snooze 15 min</button><button class="a" data-a="snooze" data-m="60">1 hour</button>
          ${standalone && it.repeat && it.repeat !== 'none' ? '<button class="a link" data-a="rem-stop">Stop reminding</button>' : '<button class="a" data-a="open">Open</button>'}</div>`;
        if (it.note && it.note !== 'Snoozed') text = it.note; else text = '';
        break;
      }
      case 'briefing':
        body = `<div class="say" id="say"></div><div class="actions"><button class="a primary" data-a="dismiss">Let's go</button><button class="a" data-a="open">Open Buddy</button></div>`;
        break;
      case 'welcome': case 'info': case 'reply':
        body = `<div class="say ${it.error ? 'error' : ''}" id="say"></div>${it.kind === 'reply' ? askBox('Reply to Buddy…') : ''}
          <div class="actions"><button class="a primary" data-a="dismiss">OK</button>${it.kind !== 'info' ? '<button class="a" data-a="open">Open Buddy</button>' : ''}</div>`;
        break;
      case 'checkin':
        body = `<div class="say" id="say"></div>${askBox('e.g. "BOM 60% done, waiting on Alex"')}
          <div class="actions"><button class="a" data-a="later" data-m="30">Ask me in 30 min</button><button class="a link" data-a="dismiss">Skip</button></div>`;
        break;
      case 'wrapup':
        body = `<div class="say" id="say"></div>${askBox('What did you get done today?')}
          <div class="actions"><button class="a" data-a="report">Open daily stand-up</button><button class="a link" data-a="dismiss">Later</button></div>`;
        break;
      case 'chat':
        body = `<div class="say" id="say"></div>${askBox('A task, an update or a blocker…')}
          <div class="actions">${focusing()
            ? '<button class="a" data-a="focus-stop">Stop focus</button>'
            : `<button class="a" data-a="focus">🎧 Focus ${Number(settings.focusMinutes) || 50} min</button>`}
          <button class="a" data-a="open">Open Buddy</button><button class="a link" data-a="hide">Hide for 1 hour</button></div>`;
        break;
      case 'focusEnd':
        body = `<div class="say" id="say"></div>
          <div class="actions"><button class="a primary" data-a="dismiss">Take a break</button><button class="a" data-a="focus">🎧 Focus again</button></div>`;
        break;
      case 'water': {
        const n = it.count || 0;
        body = `<div class="say" id="say"></div>${n ? `<span class="count">${n} glass${n > 1 ? 'es' : ''} so far today</span>` : ''}
          <div class="actions"><button class="a primary" data-a="water">I drank 💧</button><button class="a" data-a="break-snooze" data-m="10">Snooze 10 min</button><button class="a link" data-a="dismiss">Skip</button></div>`;
        break;
      }
      case 'stretch':
        body = `<div class="say" id="say"></div><div class="actions"><button class="a primary" data-a="stretched">Done</button><button class="a" data-a="break-snooze" data-m="10">Snooze 10 min</button><button class="a link" data-a="dismiss">Skip</button></div>`;
        break;
      case 'listen':
        body = `<div class="you" id="live">${esc(lastTranscript || 'Say a task, an update, or a question.')}</div>
          <div class="actions"><button class="a" data-a="voice-cancel">Cancel</button></div>`;
        break;
      default:
        body = `<div class="say" id="say"></div><div class="actions"><button class="a primary" data-a="dismiss">OK</button></div>`;
    }
    bubble.innerHTML = head(it.kind) + body;
    bubble.hidden = false;
    setMode(it.kind === 'listen' ? 'listen' : 'idle');
    const sayEl = $('#say', bubble);
    if (sayEl && text) say(text, sayEl); else typing = null;
    if (it.kind === 'focusEnd') { setMode('celebrate'); confetti(); later('step', 1800, () => { if (current === it) setMode('idle'); }); }
    const mins = EXPIRE[it.kind];
    if (mins) later('expire', (it.kind === 'welcome' && !it.urgent ? 0.4 : mins) * 60000, () => { if (current === it && !it.engaged && !it.waiting) finish(); });
  }

  // Brief message, then move on (e.g. "Okay, I'll remind you in 15 min.")
  function ack(text, ms = 1600, celebrate = false) {
    cancel('expire');
    bubble.innerHTML = `<div class="say" id="say"></div>`;
    bubble.hidden = false;
    say(text, $('#say', bubble));
    setMode(celebrate ? 'celebrate' : 'idle');
    if (celebrate) confetti();
    later('step', ms, finish);
  }

  // ---------------- conversation ----------------
  function send() {
    const ta = $('#askText', bubble);
    const text = ta ? ta.value.trim() : '';
    if (!text || !current) return;
    const it = current;
    it.waiting = true; it.you = text;
    cancel('expire');
    act({ action: 'say', text, kind: it.kind, prompt: it.kind === 'chat' || it.kind === 'reply' ? '' : it.text });
    thinking(text);
  }

  function thinking(you) {
    bubble.innerHTML = `${head('chat')}<div class="you">${esc(you)}</div><div class="dots" aria-label="Buddy is thinking"><i></i><i></i><i></i></div>`;
    bubble.hidden = false;
    setMode('think');
  }

  function onReply({ text, error }) {
    if (current && current.waiting) {
      const you = current.you;
      current = { kind: 'reply', text, error };
      present(current);
      if (you) $('#say', bubble).insertAdjacentHTML('beforebegin', `<div class="you">${esc(you)}</div>`);
    } else {
      enqueue({ kind: 'reply', text, error });
      if (!current) next(false);
    }
  }

  // ---------------- voice (wake word runs in the main window) ----------------
  function onListen() {
    lastTranscript = '';
    if (current && current.kind !== 'listen') {
      if (ALERTS.has(current.kind)) queue.unshift(current);
      cancel('expire'); cancel('step');
    }
    current = { kind: 'listen' };
    walkIn(() => present(current));
  }

  // ---------------- actions ----------------
  bubble.addEventListener('click', async (e) => {
    const link = e.target.closest('[data-task]');
    if (link) { act({ action: 'open', taskId: link.dataset.task }); return; }
    const b = e.target.closest('[data-a]'); if (!b || !current) return;
    const it = current; const a = b.dataset.a; const m = Number(b.dataset.m) || 0;
    switch (a) {
      case 'dismiss': finish(); break;
      case 'send': send(); break;
      case 'done': await act({ action: 'done', taskId: it.taskId }); ack(pick(['Nice work!', 'Done and dusted!', 'One less thing!']) + ` ${it.taskId} is marked done.`, 2000, true); break;
      case 'snooze': await act({ action: 'snooze', taskId: it.taskId, reminderId: it.reminderId, minutes: m }); ack(`Okay, I'll remind you again in ${m === 60 ? '1 hour' : `${m} min`}.`); break;
      case 'open': act({ action: 'open', taskId: it.taskId, reminderId: it.reminderId }); finish(); break;
      case 'rem-stop': await act({ action: 'reminder-stop', reminderId: it.reminderId }); ack('Okay, I\'ve paused that reminder. Turn it back on any time in the Reminders tab.', 2400); break;
      case 'report': act({ action: 'report', type: 'daily' }); finish(); break;
      case 'later': await act({ action: 'snooze-trigger', kind: it.kind, minutes: m }); ack(`Okay, I'll check in again in ${m} min.`); break;
      case 'break-snooze': await act({ action: 'snooze-trigger', kind: it.kind, minutes: m }); ack(`Okay, ${m} more minutes.`); break;
      case 'water': {
        const r = await act({ action: 'water' });
        const n = r?.count || 1;
        cancel('expire'); bubble.hidden = true; setMode('drink');
        later('step', reduceMotion ? 50 : 1300, () => ack(`Refreshing! That's ${n} glass${n > 1 ? 'es' : ''} today.`, 2200, true));
        break;
      }
      case 'stretched':
        cancel('expire'); bubble.hidden = true; setMode('stretch');
        later('step', reduceMotion ? 50 : 1600, () => ack('Feels better, right?', 1800, true));
        break;
      case 'hide': act({ action: 'hide', minutes: 60 }); finish(); break;
      case 'focus': { const r = await act({ action: 'focus' }); ack(r?.text || 'Focus mode on.', 2600); break; }
      case 'focus-stop': { const r = await act({ action: 'focus-stop' }); ack(r?.text || 'Focus mode stopped.', 2200); break; }
      case 'voice-cancel': act({ action: 'voice-cancel' }); finish(); break;
      default: break;
    }
  });
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  bubble.addEventListener('keydown', (e) => {
    if (e.target.id === 'askText' && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    if (e.key === 'Escape' && current && !ALERTS.has(current.kind)) finish();
  });
  bubble.addEventListener('input', (e) => {
    if (current) { current.engaged = true; cancel('expire'); }
    if (e.target.id === 'askText') { e.target.style.height = 'auto'; e.target.style.height = `${Math.min(e.target.scrollHeight, 110)}px`; }
  });
  bubble.addEventListener('focusin', () => { if (current) { current.engaged = true; cancel('expire'); } });

  // Drag the character anywhere; on release the window snaps to the nearest screen corner.
  // Screen coordinates are used so moving the window under the cursor doesn't feed back.
  let drag = null; let justDragged = false;
  charEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    justDragged = false;
    drag = { x: e.screenX, y: e.screenY, moved: false, prevMode: mode };
    charEl.setPointerCapture(e.pointerId);
  });
  charEl.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.moved) {
      if (Math.hypot(e.screenX - drag.x, e.screenY - drag.y) < 5) return; // still a click
      drag.moved = true;
      buddy.companionDrag('start', drag.x, drag.y);
      document.body.classList.add('dragging');
      if (x === 0) setMode('drag');
    }
    buddy.companionDrag('move', e.screenX, e.screenY);
  });
  const endDrag = () => {
    if (!drag) return;
    const d = drag; drag = null;
    if (!d.moved) return;
    justDragged = true;
    document.body.classList.remove('dragging');
    buddy.companionDrag('end');
    if (mode === 'drag') setMode(d.prevMode === 'sleep' && !current ? 'sleep' : current?.kind === 'listen' ? 'listen' : 'idle');
  };
  charEl.addEventListener('dragstart', (e) => e.preventDefault()); // never a native drag-and-drop
  charEl.addEventListener('pointerup', endDrag);
  charEl.addEventListener('pointercancel', endDrag);

  charEl.addEventListener('click', () => {
    if (justDragged) { justDragged = false; return; }
    if (current) { const ta = $('#askText', bubble); if (ta) ta.focus(); return; }
    show([{ kind: 'chat', text: greeting() }]);
  });

  // Click-through: the window ignores the mouse except over the character and bubble.
  let interactive = false;
  const setInteractive = (on) => { if (on !== interactive) { interactive = on; buddy.companionMouse(on); } };
  // (While dragging, stay interactive even if the cursor briefly outruns the window.)
  document.addEventListener('mousemove', (e) => { if (!drag) setInteractive(!!e.target.closest('.hit')); });
  document.documentElement.addEventListener('mouseleave', () => { if (!drag && !bubble.contains(document.activeElement)) setInteractive(false); });

  // ---------------- confetti ----------------
  function confetti() {
    if (reduceMotion) return;
    const cv = $('#confetti'); const c = cv.getContext('2d');
    cv.width = innerWidth; cv.height = innerHeight;
    const colors = ['#3157D5', '#FFC845', '#F59AB0', '#4FB3FF', '#1F8A5B', '#D9822B'];
    const ox = corner[1] === 'l' ? 66 : innerWidth - 66;
    const oy = corner[0] === 't' ? 90 : innerHeight - 110;
    const parts = Array.from({ length: 90 }, () => ({
      x: ox, y: oy, vx: (Math.random() - 0.65) * 7, vy: -Math.random() * 9 - 4,
      s: 4 + Math.random() * 4, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4, c: colors[Math.floor(Math.random() * colors.length)],
    }));
    const t0 = performance.now();
    (function step(t) {
      const e = t - t0;
      c.clearRect(0, 0, cv.width, cv.height);
      for (const p of parts) {
        p.vy += 0.28; p.x += p.vx; p.y += p.vy; p.r += p.vr;
        c.save(); c.globalAlpha = Math.max(0, 1 - e / 1900); c.translate(p.x, p.y); c.rotate(p.r);
        c.fillStyle = p.c; c.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); c.restore();
      }
      if (e < 1900) requestAnimationFrame(step); else c.clearRect(0, 0, cv.width, cv.height);
    })(t0);
  }

  // ---------------- character art ----------------
  function applyCharacter() {
    if (settings.companionCharacter === 'custom' && settings.customCharacterVersion) {
      const v = settings.customCharacterVersion;
      custom = { idle: `app://buddy/character/idle.png?v=${v}`, talk: null };
      const probe = new Image();
      probe.onload = () => { if (custom) custom.talk = probe.src; };
      probe.src = `app://buddy/character/talk.png?v=${v}`;
      img.hidden = false; sprite.hidden = true;
    } else {
      custom = null; img.hidden = true; sprite.hidden = false;
    }
  }

  // ---------------- messages from the main process ----------------
  buddy.onCompanion((m) => {
    switch (m.type) {
      case 'settings':
        settings = m.settings || {};
        applyCorner(settings.companionCorner);
        applyCharacter();
        if (!current) goIdle();
        break;
      case 'show': show(m.items || []); break;
      case 'listen': onListen(); break;
      case 'partial':
        lastTranscript = m.text || '';
        if (current?.kind === 'listen') { const el = $('#live', bubble); if (el) el.textContent = lastTranscript || '…'; }
        break;
      case 'listen-end': if (current?.kind === 'listen' && !current.waiting) finish(); break;
      case 'thinking':
        if (current?.kind === 'listen') { current.waiting = true; current.you = m.text || lastTranscript; thinking(current.you); }
        break;
      case 'reply': onReply(m); break;
      case 'away':
        sleeping = !!m.away;
        if (!current && (mode === 'idle' || mode === 'sleep')) { setMode(sleeping ? 'sleep' : 'idle'); sleepy(sleeping); }
        break;
      case 'focus': focusUntil = m.until || 0; updateBadge(); break;
      case 'corner': applyCorner(m.corner); break;
      case 'quiet':
        quietUntil = m.until || 0;
        if (!current) goIdle();
        if (quietUntil > Date.now()) later('quiet', quietUntil - Date.now() + 500, () => { if (!current) goIdle(); });
        break;
      default: break;
    }
  });

  requestAnimationFrame(frame);
  buddy.companionReady();
})();
