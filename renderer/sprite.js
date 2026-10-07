// Buddy's built-in pixel-art characters, drawn in code (no image files) on a 24x30 grid.
// A look (robot / man / woman) sets colours and hair; a pose picks eyes / mouth / arms / legs;
// an accessory (headphones, party hat, shades, nightcap) shows the companion's mood.
(function () {
  const W = 24; const H = 30;
  const BASE = {
    line: '#1C2733', eye: '#1C2733', cheek: '#F59AB0', white: '#FFFFFF', tongue: '#F07A93',
    cup: '#E8F6FF', water: '#4FB3FF', bulb: '#FFC845', bulbOff: '#8A97A6', shoes: '#1C2733',
  };
  const LOOKS = {
    robotPixel: { kind: 'robot', body: '#3157D5', bodyHi: '#5A7DF0', face: '#DCE6FF', panel: '#6F8DF0', hand: '#BFD0FF', leg: '#2A3A4F' },
    man: { kind: 'human', hair: 'short', skin: '#C98B5E', hairColor: '#2B1E16', body: '#3157D5', bodyHi: '#5A7DF0', collar: '#E8EEF9', leg: '#2A3A4F' },
    woman: { kind: 'human', hair: 'long', skin: '#D9A27A', hairColor: '#3A2418', body: '#D9577B', bodyHi: '#E87D9A', collar: '#FCE4EC', leg: '#3A3550' },
  };

  const ARMS = {
    // [x, y, w, h, handAtTop]
    down: [[5, 18, 2, 6, false], [17, 18, 2, 6, false]],
    wave1: [[5, 18, 2, 6, false], [17, 12, 2, 6, true]],
    wave2: [[5, 18, 2, 6, false], [18, 11, 2, 6, true]],
    up: [[5, 12, 2, 6, true], [17, 12, 2, 6, true]],
    stretch: [[3, 10, 2, 7, true], [19, 10, 2, 7, true]],
    cup: [[5, 18, 2, 6, false], [14, 19, 4, 2, false]],
  };
  // [legL, legR, footL, footR]
  const LEGS = {
    stand: [[8, 25, 3, 3], [13, 25, 3, 3], [7, 28, 4, 1], [13, 28, 4, 1]],
    walk1: [[7, 25, 3, 3], [14, 25, 3, 2], [6, 28, 4, 1], [14, 27, 4, 1]],
    walk2: [[8, 25, 3, 2], [14, 25, 3, 3], [7, 27, 4, 1], [14, 28, 4, 1]],
    jump: [[8, 25, 3, 2], [13, 25, 3, 2], [7, 27, 4, 1], [13, 27, 4, 1]],
  };

  function draw(ctx, pose = {}, P = 4, lookId = 'robot') {
    if (lookId === 'robot') { drawSmoothRobot(ctx, pose, P); return; }
    const L = { ...BASE, ...(LOOKS[lookId] || LOOKS.robotPixel) };
    const robot = L.kind === 'robot';
    const eyes = pose.eyes || 'open';
    const mouth = pose.mouth || 'smile';
    const arms = ARMS[pose.arms] || ARMS.down;
    const legs = LEGS[pose.legs] || LEGS.stand;
    ctx.clearRect(0, 0, W * P, H * P);
    const px = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(x * P, y * P, w * P, h * P); };

    // Solid parts share a 1px outline so the silhouette reads as one shape; they fill in list order.
    const solids = [];
    if (robot) solids.push([11, 1, 2, 2, pose.bulb === false ? L.bulbOff : L.bulb]); // antenna bulb
    if (!robot && L.hair === 'long') solids.push([4, 5, 16, 13, L.hairColor]); // hair behind the head
    const headColor = robot ? L.body : L.skin;
    solids.push([6, 5, 12, 11, headColor], [5, 6, 14, 9, headColor]); // head (rounded)
    if (!robot) solids.push([6, 4, 12, 3, L.hairColor]); // hair on top
    solids.push([8, 18, 8, 7, L.body], [7, 19, 10, 5, L.body]); // torso (rounded)
    solids.push(...arms.map(([x, y, w, h]) => [x, y, w, h, L.body]));
    solids.push(...legs.slice(0, 2).map(([x, y, w, h]) => [x, y, w, h, L.leg]));
    solids.push(...legs.slice(2).map(([x, y, w, h]) => [x, y, w, h, robot ? L.leg : L.shoes]));
    if (pose.arms === 'cup') solids.push([12, 15, 4, 5, L.cup]);
    for (const [x, y, w, h] of solids) px(x - 1, y - 1, w + 2, h + 2, L.line);
    if (robot) px(11, 3, 2, 2, L.line); // antenna stem
    px(10, 16, 4, 2, robot ? L.line : L.skin); // neck
    for (const [x, y, w, h, c] of solids) px(x, y, w, h, c);

    // Hands
    const hand = robot ? L.hand : L.skin;
    for (const [x, y, w, h, top] of arms) {
      if (pose.arms === 'cup' && x === 14) { px(14, 19, 1, 2, hand); continue; }
      px(x, top ? y : y + h - 1, w, 1, hand);
    }
    if (pose.arms === 'cup') px(12, 15, 4, 1, L.water);

    if (robot) {
      // Head shine, face screen, belly panel with status light
      px(6, 6, 3, 1, L.bodyHi);
      px(8, 7, 8, 7, L.face); px(7, 8, 10, 5, L.face);
      px(9, 20, 6, 3, L.panel);
      px(11, 21, 2, 1, pose.bulb === false ? L.bulbOff : L.bulb);
    } else {
      // Hairline, fringe, collar, shirt shine
      if (L.hair === 'short') { px(5, 6, 1, 3, L.hairColor); px(18, 6, 1, 3, L.hairColor); px(7, 7, 3, 1, L.hairColor); }
      else { px(5, 6, 1, 6, L.hairColor); px(18, 6, 1, 6, L.hairColor); px(6, 7, 5, 1, L.hairColor); px(12, 7, 1, 1, L.hairColor); }
      px(10, 18, 4, 1, L.collar);
      px(8, 19, 2, 1, L.bodyHi);
    }

    // Eyes
    const dx = eyes === 'look-left' ? -1 : eyes === 'look-right' ? 1 : 0;
    if (eyes === 'closed') { px(9, 11, 2, 1, L.eye); px(13, 11, 2, 1, L.eye); }
    else if (eyes === 'half') { px(9, 10, 2, 2, L.eye); px(13, 10, 2, 2, L.eye); px(9, 10, 2, 1, robot ? L.face : L.skin); px(13, 10, 2, 1, robot ? L.face : L.skin); px(9, 11, 2, 1, L.eye); px(13, 11, 2, 1, L.eye); }
    else if (eyes === 'happy') {
      for (const ox of [0, 4]) { px(9 + ox, 9, 2, 1, L.eye); px(8 + ox, 10, 1, 1, L.eye); px(11 + ox, 10, 1, 1, L.eye); }
    } else {
      px(9 + dx, 9, 2, 3, L.eye); px(13 + dx, 9, 2, 3, L.eye);
      px(9 + dx, 9, 1, 1, L.white); px(13 + dx, 9, 1, 1, L.white);
    }
    if (eyes !== 'closed' && eyes !== 'half') { px(7, 12, 1, 1, L.cheek); px(16, 12, 1, 1, L.cheek); }

    // Mouth
    if (mouth === 'open') { px(10, 12, 4, 2, L.eye); px(11, 13, 2, 1, L.tongue); }
    else if (mouth === 'o') px(11, 12, 2, 2, L.eye);
    else if (mouth === 'flat') px(10, 13, 4, 1, L.eye);
    else { px(10, 12, 1, 1, L.eye); px(11, 13, 2, 1, L.eye); px(13, 12, 1, 1, L.eye); }

    drawAccessory(px, pose.acc, L);
  }

  function drawAccessory(px, acc, L) {
    const line = L.line;
    if (acc === 'headphones') {
      px(6, 2, 12, 1, line); px(5, 3, 1, 3, line); px(18, 3, 1, 3, line); // band
      px(7, 3, 10, 1, '#5B6B7B');
      for (const x of [3, 18]) { px(x, 7, 3, 6, line); px(x + (x < 10 ? 1 : 0), 8, 2, 4, '#E8590C'); } // ear cups
    } else if (acc === 'party') {
      const rows = [[11, 0, 2], [11, 1, 2], [10, 2, 4], [10, 3, 4], [9, 4, 6]];
      rows.forEach(([x, y, w], i) => px(x, y, w, 1, i % 2 ? '#FFC845' : '#E8457A'));
      px(11, 0, 2, 1, '#4FB3FF'); px(8, 5, 8, 1, line);
    } else if (acc === 'shades') {
      px(7, 9, 4, 3, line); px(13, 9, 4, 3, line); px(11, 9, 2, 1, line); // lenses + bridge
      px(6, 9, 1, 1, line); px(17, 9, 1, 1, line);
      px(8, 9, 1, 1, '#5B6B7B'); px(14, 9, 1, 1, '#5B6B7B'); // glint
    } else if (acc === 'nightcap') {
      px(6, 3, 12, 2, '#3D4F9F'); px(5, 5, 14, 1, '#F4F6F8'); // cap + white band
      px(16, 2, 3, 2, '#3D4F9F'); px(18, 3, 2, 3, '#3D4F9F'); px(19, 6, 2, 2, '#3D4F9F'); // droop
      px(20, 8, 2, 2, '#F4F6F8'); // pompom
      px(8, 3, 1, 1, '#FFC845'); px(13, 4, 1, 1, '#FFC845'); // stars
    }
  }

  // ---------- smooth robot (vector) ----------
  // Same pose/accessory vocabulary as the pixel looks, drawn with paths and gradients in a
  // 96x120 logical box (P/4 scales it, so P = 4 * devicePixelRatio stays crisp).
  const R = {
    body1: '#6A8CFF', body2: '#2F4FD0', limb: '#3A5BDB', hand: '#E8EEFF', handEdge: '#9FB3F2',
    leg: '#2C3F86', foot: '#1C2A5C', visor1: '#1A2756', visor2: '#0A1230', glow: '#7FE8FF',
    neck: '#22336F', bulb: '#FFC845', bulbOff: '#8A97A6', cheek: 'rgba(255,128,170,.55)',
  };
  // [shoulderX, shoulderY, handX, handY]
  const S_ARMS = {
    down: [[29, 76, 20, 96], [67, 76, 76, 96]],
    wave1: [[29, 76, 20, 96], [67, 76, 84, 52]],
    wave2: [[29, 76, 20, 96], [67, 76, 90, 60]],
    up: [[29, 76, 9, 50], [67, 76, 87, 50]],
    stretch: [[29, 76, 5, 40], [67, 76, 91, 40]],
    cup: [[29, 76, 20, 96], [67, 76, 58, 80]],
  };
  // [hipX, hipY, footX, footY]
  const S_LEGS = {
    stand: [[40, 100, 39, 111], [56, 100, 57, 111]],
    walk1: [[40, 100, 34, 111], [56, 100, 60, 107]],
    walk2: [[40, 100, 44, 107], [56, 100, 62, 111]],
    jump: [[40, 100, 37, 105], [56, 100, 59, 105]],
  };

  function drawSmoothRobot(ctx, pose, P) {
    const eyes = pose.eyes || 'open';
    const mouth = pose.mouth || 'smile';
    const acc = pose.acc;
    const lit = pose.bulb !== false;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.scale(P / 4, P / 4);
    ctx.lineJoin = 'round';

    const grad = (y0, y1, a, b) => { const g = ctx.createLinearGradient(0, y0, 0, y1); g.addColorStop(0, a); g.addColorStop(1, b); return g; };
    const shape = (fn, fill, stroke, lw = 1.5) => { ctx.beginPath(); fn(); if (fill) { ctx.fillStyle = fill; ctx.fill(); } if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); } };
    const rr = (x, y, w, h, r) => () => ctx.roundRect(x, y, w, h, r);
    const circle = (x, y, r) => () => ctx.arc(x, y, r, 0, Math.PI * 2);
    const ellipse = (x, y, rx, ry, rot = 0) => () => ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
    const line = (x1, y1, x2, y2, w, color) => { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineCap = 'round'; ctx.lineWidth = w; ctx.strokeStyle = color; ctx.stroke(); };
    const glow = (color, blur, fn) => { ctx.save(); ctx.shadowColor = color; ctx.shadowBlur = blur; fn(); ctx.restore(); };

    // Antenna (hidden under hats)
    if (acc !== 'party' && acc !== 'nightcap') {
      line(48, 13, 48, 6, 3, R.neck);
      if (lit) glow(R.bulb, 10, () => shape(circle(48, 5, 4.5), R.bulb));
      else shape(circle(48, 5, 4.5), R.bulbOff);
      shape(circle(46.6, 3.6, 1.4), 'rgba(255,255,255,.75)');
    }

    // Legs and feet
    for (const [hx, hy, fx, fy] of S_LEGS[pose.legs] || S_LEGS.stand) {
      line(hx, hy, fx, fy, 8, R.leg);
      shape(ellipse(fx + (fx < 48 ? -1 : 1), fy + 3, 8, 4), R.foot);
    }

    // Body with chest light
    shape(rr(23, 67, 50, 35, 15), grad(67, 102, R.body1, R.body2), 'rgba(16,30,100,.35)');
    shape(rr(29, 71, 22, 5, 2.5), 'rgba(255,255,255,.22)');
    shape(circle(48, 86, 6.5), R.visor2);
    if (lit) glow(R.bulb, 8, () => shape(circle(48, 86, 3.6), R.bulb)); else shape(circle(48, 86, 3.6), R.bulbOff);

    // Neck
    shape(rr(41, 61, 14, 9, 4), R.neck);

    // Arms and hands (the cup sits in the right hand)
    const arms = S_ARMS[pose.arms] || S_ARMS.down;
    for (const [sx, sy, hx, hy] of arms) {
      line(sx, sy, hx, hy, 8, R.limb);
      shape(circle(hx, hy, 5.6), R.hand, R.handEdge, 1.2);
    }
    if (pose.arms === 'cup') {
      shape(rr(50, 58, 15, 19, 4), 'rgba(232,246,255,.92)', '#9CC9E8', 1.2);
      shape(rr(51.5, 64, 12, 11.5, 3), '#4FB3FF');
      shape(rr(53, 60, 2.5, 13, 1.2), 'rgba(255,255,255,.7)');
    }

    // Ears
    for (const x of [7, 80]) {
      shape(rr(x, 31, 9, 18, 4.5), R.limb, 'rgba(16,30,100,.35)');
      shape(circle(x + 4.5, 40, 1.8), lit ? R.glow : R.bulbOff);
    }

    // Head: glossy shell
    shape(rr(13, 12, 70, 54, 22), grad(12, 66, R.body1, R.body2), 'rgba(16,30,100,.35)');
    shape(ellipse(31, 21, 13, 4.5, -0.25), 'rgba(255,255,255,.32)');

    // Visor with a faint reflection
    shape(rr(21, 22, 54, 36, 14), grad(22, 58, R.visor1, R.visor2));
    ctx.save(); ctx.beginPath(); ctx.roundRect(21, 22, 54, 36, 14); ctx.clip();
    shape(() => { ctx.moveTo(52, 22); ctx.lineTo(66, 22); ctx.lineTo(44, 58); ctx.lineTo(30, 58); ctx.closePath(); }, 'rgba(255,255,255,.05)');
    ctx.restore();

    // Eyes (glowing)
    const dx = eyes === 'look-left' ? -3 : eyes === 'look-right' ? 3 : 0;
    glow(R.glow, 7, () => {
      ctx.fillStyle = R.glow; ctx.strokeStyle = R.glow; ctx.lineCap = 'round';
      for (const cx of [38 + dx, 58 + dx]) {
        ctx.beginPath();
        if (eyes === 'closed') { ctx.lineWidth = 2.6; ctx.moveTo(cx - 5, 39); ctx.quadraticCurveTo(cx, 42.5, cx + 5, 39); ctx.stroke(); }
        else if (eyes === 'happy') { ctx.lineWidth = 3; ctx.moveTo(cx - 5.5, 42); ctx.quadraticCurveTo(cx, 31, cx + 5.5, 42); ctx.stroke(); }
        else if (eyes === 'half') { ctx.roundRect(cx - 5, 37.5, 10, 6.5, 3); ctx.fill(); }
        else { ctx.roundRect(cx - 5, 31.5, 10, 13, 5); ctx.fill(); }
      }
    });
    if (eyes === 'open' || eyes === 'look-left' || eyes === 'look-right') {
      for (const cx of [38 + dx, 58 + dx]) shape(circle(cx - 1.8, 35, 1.6), 'rgba(255,255,255,.85)');
    }
    if (eyes !== 'closed' && eyes !== 'half') { shape(ellipse(28, 48.5, 4, 2.3), R.cheek); shape(ellipse(68, 48.5, 4, 2.3), R.cheek); }

    // Mouth (glowing)
    glow(R.glow, 6, () => {
      ctx.fillStyle = R.glow; ctx.strokeStyle = R.glow; ctx.lineCap = 'round'; ctx.lineWidth = 2.4;
      ctx.beginPath();
      if (mouth === 'open') { ctx.roundRect(43, 46.5, 10, 7, 3.5); ctx.fill(); }
      else if (mouth === 'o') { ctx.arc(48, 50, 3, 0, Math.PI * 2); ctx.stroke(); }
      else if (mouth === 'flat') { ctx.moveTo(44, 50.5); ctx.lineTo(52, 50.5); ctx.stroke(); }
      else { ctx.moveTo(43, 48); ctx.quadraticCurveTo(48, 54, 53, 48); ctx.stroke(); }
    });

    // Mood accessories
    if (acc === 'headphones') {
      ctx.beginPath(); ctx.arc(48, 40, 34, Math.PI * 1.08, Math.PI * 1.92);
      ctx.lineWidth = 4.5; ctx.lineCap = 'round'; ctx.strokeStyle = '#2A3550'; ctx.stroke();
      for (const x of [4, 81]) {
        shape(rr(x, 30, 11, 20, 5.5), grad(30, 50, '#FF8A4C', '#E0531A'), 'rgba(90,30,0,.35)');
        shape(rr(x + 2.5, 34, 6, 12, 3), 'rgba(0,0,0,.16)');
      }
    } else if (acc === 'party') {
      ctx.save();
      ctx.beginPath(); ctx.moveTo(35, 15); ctx.lineTo(61, 15); ctx.lineTo(50, 2); ctx.closePath();
      ctx.fillStyle = '#E8457A'; ctx.fill(); ctx.clip();
      ctx.fillStyle = '#FFC845';
      for (let i = -2; i < 6; i++) { ctx.beginPath(); ctx.moveTo(30 + i * 8, 16); ctx.lineTo(34 + i * 8, 16); ctx.lineTo(48 + i * 8, 0); ctx.lineTo(44 + i * 8, 0); ctx.closePath(); ctx.fill(); }
      ctx.restore();
      shape(circle(50, 3, 3.2), '#4FB3FF');
    } else if (acc === 'shades') {
      for (const x of [28, 50]) shape(rr(x, 31, 18, 13, 5.5), grad(31, 44, '#3A3F4C', '#0D0F14'));
      line(46, 35, 50, 35, 2.2, '#0D0F14');
      line(21, 35, 28, 34, 2, '#0D0F14'); line(68, 34, 75, 35, 2, '#0D0F14');
      line(31, 34, 36, 33, 1.6, 'rgba(255,255,255,.55)'); line(53, 34, 58, 33, 1.6, 'rgba(255,255,255,.55)');
    } else if (acc === 'nightcap') {
      shape(() => { ctx.moveTo(15, 22); ctx.bezierCurveTo(20, 2, 70, -2, 82, 12); ctx.quadraticCurveTo(93, 24, 90, 40); ctx.quadraticCurveTo(84, 26, 76, 22); ctx.closePath(); }, grad(0, 30, '#4A5FC0', '#33449A'));
      shape(rr(13, 17, 68, 8, 4), '#F4F6F8', 'rgba(0,0,0,.08)');
      glow('#FFFFFF', 4, () => shape(circle(90, 42, 5.5), '#FFFFFF'));
      for (const [x, y] of [[30, 10], [52, 6], [66, 12]]) shape(circle(x, y, 1.3), '#FFC845');
    }
    ctx.restore();
  }

  window.BuddySprite = { W, H, draw, LOOKS: ['robot', ...Object.keys(LOOKS)] };
})();
