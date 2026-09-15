(() => {
  'use strict';

  /* ---------------- Config ---------------- */
  const GLOBE_RADIUS = 100; // three-globe's internal sphere radius, in world units
  const SATELLITE_TEXTURE_URL = 'https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg';

  const COLORS = {
    ocean:     '#04122B',   // deep base
    oceanMid:  '#2E6690',   // calm, muted blue — easy on the eyes
    grid:      '#2C4F73',
    land:      '#232226',   // dark land
    landEdgeMap: 'rgba(244,241,234,0.30)',
    landEdgeSat: 'rgba(244,241,234,0.85)',
    highlight: '#F7F4EC',   // significantly lighter than land, for the single selected country
    highlightSat: 'rgba(247,244,236,0.55)',
    labelCountry:  '#F4F1EA',
    labelContinent:'#D97757',
    labelOcean:    '#8FD0FF',
    labelSea:      '#6FB6E6',
    labelMountain: '#C7A46B',
    labelDesert:   '#D8B073',
    labelRiver:    '#7FD0E6',
    labelLake:     '#7FD0E6',
  };

  // Camera-distance tiers (world units from globe centre). Larger = further away.
  const TIER_FAR = 250; // above this: continents + oceans only
  const TIER_MID = 150; // between MID and FAR: + countries, seas
  // below TIER_MID: + terrain / hydro fine features (if their layer is active)

  // Rotation speed tiers. 0.35 was the app's original/default speed — that is
  // now the "0.5x" tier, with 1x and 2x scaled up from it.
  const ROTATE_SPEEDS = { '0.5': 0.35, '1': 0.7, '2': 1.4 };
  // Fun easter-egg tier: a lightweight "toy globe" that spins way past 10x.
  const TURBO_ROTATE_SPEED = 35;     // ~100x the original 0.35 baseline
  const TURBO_ALTITUDE = 3.4;        // zoomed well out, so it reads as a small distant planet

  const state = {
    tier: 'far',              // 'far' | 'mid' | 'near'
    mode: 'map',               // 'map' | 'satellite'
    layers: { countries: true, water: true, terrain: false, hydro: false },
    selected: [],       // up to MAX_SELECTED country features, in pick order
    world: null,
    countries: [],
    countryLabels: [],
    userInteracted: false,
    mapTexture: null,
    turboTexture: null,
    rotateSpeed: '0.5',
    baseRotateSpeed: 0.35,
    prevRotateSpeed: '0.5',
    turbo: false,
    prevPOV: null,
    visible: true,
  };

  /* ---------------- Starfield (plain 2D canvas, behind the WebGL globe) ---------------- */
  const starCanvas = document.getElementById('stars');
  const starCtx = starCanvas.getContext('2d');
  let stars = [];

  // iOS Safari's collapsing address/tab bar means window.innerHeight can briefly
  // under-report the true visible area (leaving a gap at the bottom). visualViewport
  // tracks the real, current visible size, so prefer it wherever we size full-bleed layers.
  function vw() { return window.visualViewport ? window.visualViewport.width : window.innerWidth; }
  function vh() { return window.visualViewport ? window.visualViewport.height : window.innerHeight; }

  function initStars() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = vw(), h = vh();
    starCanvas.width = w * dpr;
    starCanvas.height = h * dpr;
    starCanvas.style.width = w + 'px';
    starCanvas.style.height = h + 'px';
    starCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const count = Math.round((w * h) / 3200);
    stars = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: Math.random() * 1.1 + 0.15,
      base: Math.random() * 0.5 + 0.15,
      phase: Math.random() * Math.PI * 2,
      speed: Math.random() * 0.0006 + 0.0002,
    }));
  }

  function drawStars(t) {
    if (state.visible) {
      starCtx.clearRect(0, 0, vw(), vh());
      starCtx.fillStyle = '#F4F1EA';
      for (const s of stars) {
        const tw = s.base + Math.sin(t * s.speed + s.phase) * 0.18;
        starCtx.globalAlpha = Math.max(0, tw);
        starCtx.beginPath();
        starCtx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        starCtx.fill();
      }
      starCtx.globalAlpha = 1;
    }
    requestAnimationFrame(drawStars);
  }

  /* ---------------- Procedural ocean texture (graticule), electric blue ---------------- */
  function buildOceanTexture() {
    const w = 1024, h = 512;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');

    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#030F26');
    grad.addColorStop(0.5, COLORS.oceanMid);
    grad.addColorStop(1, '#030F26');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // subtle radial glow band — soft, not electric
    const glow = ctx.createRadialGradient(w / 2, h / 2, h * 0.1, w / 2, h / 2, h * 0.9);
    glow.addColorStop(0, 'rgba(110,150,185,0.22)');
    glow.addColorStop(1, 'rgba(110,150,185,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(140,175,205,0.12)';
    ctx.lineWidth = 1;
    for (let lng = 0; lng <= w; lng += w / 12) { // every 30deg
      ctx.beginPath(); ctx.moveTo(lng, 0); ctx.lineTo(lng, h); ctx.stroke();
    }
    for (let lat = 0; lat <= h; lat += h / 12) { // every 15deg
      ctx.beginPath(); ctx.moveTo(0, lat); ctx.lineTo(w, lat); ctx.stroke();
    }
    // equator + prime meridian, slightly stronger
    ctx.strokeStyle = 'rgba(190,210,225,0.18)';
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h); ctx.stroke();

    return c.toDataURL('image/png');
  }

  /* ---------------- Turbo mode: tiny, cheap, cartoon "toy globe" texture ----------------
     Deliberately low-res, no coastlines/borders — a handful of soft blob shapes on a
     flat blue base. It's a fraction of the weight of the real ocean texture, and with
     polygons/labels stripped out entirely, it's light enough to spin very fast smoothly. */
  function buildCartoonTexture() {
    const w = 64, h = 32;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');

    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#1D66D6');
    grad.addColorStop(0.5, '#2F8CF0');
    grad.addColorStop(1, '#1D66D6');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Loose, rounded "continent" blobs — playful shapes, not real coastlines
    const blobs = [
      { x: 0.16, y: 0.40, r: 0.085 }, { x: 0.22, y: 0.27, r: 0.055 }, { x: 0.19, y: 0.60, r: 0.06 },
      { x: 0.47, y: 0.26, r: 0.07 },  { x: 0.50, y: 0.40, r: 0.065 }, { x: 0.60, y: 0.58, r: 0.075 },
      { x: 0.74, y: 0.30, r: 0.095 }, { x: 0.85, y: 0.42, r: 0.055 }, { x: 0.86, y: 0.66, r: 0.05 },
    ];
    ctx.fillStyle = '#57B653';
    blobs.forEach(b => {
      ctx.beginPath();
      ctx.ellipse(b.x * w, b.y * h, b.r * w, b.r * h * 0.85, 0, 0, Math.PI * 2);
      ctx.fill();
    });

    // A soft highlight sheen — gives it a glossy toy-globe feel
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.ellipse(w * 0.32, h * 0.22, w * 0.28, h * 0.14, 0, 0, Math.PI * 2);
    ctx.fill();

    return c.toDataURL('image/png');
  }

  /* ---------------- Label sizing / visibility helpers ---------------- */
  const SIZE_BY_CATEGORY = {
    continent: 3.1, ocean: 1.55, sea: 1.05,
    country: 0.85, mountain: 0.72, desert: 0.72, river: 0.68, lake: 0.66,
  };
  const COLOR_BY_CATEGORY = {
    continent: COLORS.labelContinent, ocean: COLORS.labelOcean, sea: COLORS.labelSea,
    country: COLORS.labelCountry, mountain: COLORS.labelMountain, desert: COLORS.labelDesert,
    river: COLORS.labelRiver, lake: COLORS.labelLake,
  };

  function visibleForTier(cat) {
    if (cat === 'continent') return state.layers.countries;
    if (cat === 'ocean') return true;
    if (cat === 'sea') return state.tier !== 'far';
    if (cat === 'country') return state.tier !== 'far' && state.layers.countries;
    if (cat === 'mountain' || cat === 'desert') return state.tier === 'near' && state.layers.terrain;
    if (cat === 'river' || cat === 'lake') return state.tier === 'near' && state.layers.hydro;
    return false;
  }
  function categoryLayerActive(cat) {
    if (cat === 'ocean' || cat === 'sea') return state.layers.water;
    if (cat === 'country' || cat === 'continent') return state.layers.countries;
    if (cat === 'mountain' || cat === 'desert') return state.layers.terrain;
    if (cat === 'river' || cat === 'lake') return state.layers.hydro;
    return true;
  }

  function currentLabels() {
    const all = state.countryLabels.concat(EARTH_FEATURES);
    return all.filter(d => categoryLayerActive(d.category) && visibleForTier(d.category));
  }

  function refreshLabels() {
    if (state.turbo) { state.world.labelsData([]); return; }
    state.world.labelsData(currentLabels());
  }

  // A comfortable ceiling for how many countries can be pinned at once — enough to
  // compare a handful side by side without the panel turning into an endless strip.
  const MAX_SELECTED = 7;
  function isSelected(feat) { return state.selected.includes(feat); }

  /* ---------------- Polygon styling (mode + multi-selection aware) ---------------- */
  function polygonAltitudeFn(d) {
    return isSelected(d) ? 0.05 : 0.006;
  }
  function polygonCapColorFn(d) {
    if (isSelected(d)) {
      return state.mode === 'satellite' ? COLORS.highlightSat : COLORS.highlight;
    }
    return state.mode === 'satellite' ? 'rgba(0,0,0,0)' : COLORS.land;
  }
  function polygonStrokeColorFn() {
    return state.mode === 'satellite' ? COLORS.landEdgeSat : COLORS.landEdgeMap;
  }
  function polygonSideColorFn() {
    return state.mode === 'satellite' ? 'rgba(0,0,0,0)' : 'rgba(10,9,8,0.4)';
  }
  function refreshPolygonStyle() {
    state.world
      .polygonAltitude(polygonAltitudeFn)
      .polygonCapColor(polygonCapColorFn)
      .polygonSideColor(polygonSideColorFn)
      .polygonStrokeColor(polygonStrokeColorFn);
  }

  /* ---------------- Smooth camera dolly (for +/- buttons) ---------------- */
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  function easeOutBack(t) {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }

  function animateAutoRotateSpeed(target, duration, easing) {
    const start = state.baseRotateSpeed;
    const t0 = performance.now();
    (function step(now) {
      const p = Math.min(1, (now - t0) / duration);
      state.baseRotateSpeed = start + (target - start) * easing(p);
      if (p < 1) requestAnimationFrame(step);
    })(t0);
  }

  function smoothZoomToDistance(targetDist, duration = 550) {
    const controls = state.world.controls();
    const camera = state.world.camera();
    const dir = camera.position.clone().normalize();
    const startDist = camera.position.length();
    const clamped = Math.max(controls.minDistance, Math.min(controls.maxDistance, targetDist));
    const t0 = performance.now();
    controls.enabled = false;
    (function step(now) {
      const p = Math.min(1, (now - t0) / duration);
      const eased = easeOutCubic(p);
      const dist = startDist + (clamped - startDist) * eased;
      camera.position.copy(dir.clone().multiplyScalar(dist));
      controls.update();
      if (p < 1) requestAnimationFrame(step);
      else controls.enabled = true;
    })(t0);
  }

  // Continuous zoom — each +/- tap scales the current distance smoothly,
  // same direction the camera is already pointing.
  function smoothZoomBy(factor, duration = 480) {
    clearGlobeShift();
    const camera = state.world.camera();
    const startDist = camera.position.length();
    smoothZoomToDistance(startDist * factor, duration);
  }

  // Nudges the rendered globe down on-screen, clear of a notch/Dynamic Island that
  // would otherwise sit right over the top of it at this wide-open zoom level.
  // A plain CSS shift of the canvas — the 3D projection itself is untouched, the
  // whole rendered frame just moves down — so nothing about the globe distorts.
  function shiftGlobeForNotch() {
    document.getElementById('globeViz').classList.add('notch-shift');
  }
  function clearGlobeShift() {
    document.getElementById('globeViz').classList.remove('notch-shift');
  }

  // A single dedicated "sweet spot" distance: close enough that every country
  // (and continent) name is visible — sits just inside the 'mid' LOD tier — while
  // staying far enough out that the whole globe, both poles included, still fits
  // on screen (and clear of any notch/Dynamic Island up top).
  const LABELS_VIEW_DISTANCE = 240;
  function snapToLabelsView() {
    shiftGlobeForNotch();
    smoothZoomToDistance(LABELS_VIEW_DISTANCE, 650);
  }

  /* ---------------- Auto-rotate: ease out instead of a hard stop ---------------- */
  function easeOutAutoRotate() {
    const controls = state.world.controls();
    const startSpeed = state.baseRotateSpeed;
    const t0 = performance.now();
    const duration = 700;
    (function step(now) {
      const p = Math.min(1, (now - t0) / duration);
      state.baseRotateSpeed = startSpeed * (1 - easeOutCubic(p));
      if (p < 1) requestAnimationFrame(step);
      else controls.autoRotate = false;
    })(t0);
  }

  /* ---------------- Init ---------------- */
  async function init() {
    initStars();
    requestAnimationFrame(drawStars);
    window.addEventListener('resize', onResize);
    if (window.visualViewport) {
      // Catches iOS Safari's address/tab-bar collapsing, which changes the true
      // visible height without always firing a plain window 'resize'.
      window.visualViewport.addEventListener('resize', onResize);
      window.visualViewport.addEventListener('scroll', onResize);
    }
    // Re-check shortly after load too — on first paint iOS sometimes reports
    // the chrome-expanded (shorter) height before settling to its real size.
    setTimeout(onResize, 400);
    setTimeout(onResize, 1200);

    const geo = await fetch('data/world.geojson').then(r => r.json());
    state.countries = geo.features;

    state.countryLabels = geo.features.map(f => {
      const c = d3.geoCentroid(f);
      return { name: f.properties.name, lat: c[1], lng: c[0], category: 'country', feature: f };
    });

    state.mapTexture = buildOceanTexture();
    state.turboTexture = buildCartoonTexture();

    const world = Globe({
      rendererConfig: { antialias: true, alpha: true, powerPreference: 'high-performance' }
    })(document.getElementById('globeViz'))
      .width(vw())
      .height(vh())
      .backgroundColor('rgba(0,0,0,0)')
      .globeImageUrl(state.mapTexture)
      .showAtmosphere(true)
      .atmosphereColor('#D97757')
      .atmosphereAltitude(0.2)

      .polygonsData(state.countries)
      .polygonAltitude(polygonAltitudeFn)
      .polygonCapColor(polygonCapColorFn)
      .polygonSideColor(polygonSideColorFn)
      .polygonStrokeColor(polygonStrokeColorFn)
      .polygonsTransitionDuration(420)
      .onPolygonHover(d => { document.body.style.cursor = d ? 'pointer' : 'default'; })
      .onPolygonClick(d => selectCountry(d))
      .onGlobeClick(() => { if (state.turbo) exitTurbo(); })

      .labelsData([])
      .labelLat(d => d.lat)
      .labelLng(d => d.lng)
      .labelText(d => d.name)
      .labelSize(d => SIZE_BY_CATEGORY[d.category] || 0.8)
      .labelColor(d => COLOR_BY_CATEGORY[d.category] || COLORS.labelCountry)
      .labelDotRadius(d => d.category === 'country' ? 0.28 : 0.2)
      .labelAltitude(0.012)
      .labelResolution(3)
      .labelIncludeDot(true)
      .onLabelClick(d => { if (d.feature) selectCountry(d.feature); });

    state.world = world;

    // Cap device pixel ratio — uncapped DPR on high-density phone screens is
    // the single biggest cause of dropped frames on a full-bleed WebGL canvas.
    world.renderer().setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    // Controls — tuned for seamless, inertial rotation & zoom
    const controls = world.controls();
    controls.enableDamping = true;
    controls.dampingFactor = 0.045;
    controls.rotateSpeed = 0.5;
    controls.zoomSpeed = 0.55;
    controls.minDistance = GLOBE_RADIUS + 1;   // maximum zoom-in: just above the surface
    controls.maxDistance = GLOBE_RADIUS * 5;   // maximum zoom-out
    controls.autoRotate = true;
    state.baseRotateSpeed = ROTATE_SPEEDS[state.rotateSpeed];
    controls.autoRotateSpeed = state.baseRotateSpeed;
    controls.addEventListener('start', () => {
      clearGlobeShift(); // a manual drag/pinch means the user is repositioning it themselves
      if (!state.userInteracted) {
        state.userInteracted = true;
        easeOutAutoRotate();
        fadeHint();
      }
    });

    // Pause WebGL rendering entirely while the tab/app isn't visible —
    // saves battery and avoids a pile-up of missed frames on return.
    document.addEventListener('visibilitychange', () => {
      state.visible = !document.hidden;
      if (document.hidden) world.pauseAnimation();
      else world.resumeAnimation();
    });

    // Intro camera fly-in
    world.pointOfView({ lat: 23.48, lng: 80.12, altitude: 3.4 }, 0);
    setTimeout(() => world.pointOfView({ lat: 23.48, lng: 80.12, altitude: 2.15 }, 2400), 250);

    // LOD watcher + frame-rate-independent auto-rotate.
    // three.js's OrbitControls.autoRotate assumes a fixed 60fps and advances by a
    // constant angle every update() call — so on a 90Hz or 120Hz display it just spins
    // faster (and can look uneven if frames aren't perfectly even). Instead we treat
    // state.baseRotateSpeed as the *intended* speed and rescale autoRotateSpeed every
    // frame by the real elapsed time, so the globe turns at the same true angular
    // speed — smoothly — on any refresh rate.
    let lastTickTime = null;
    function tick(now) {
      if (lastTickTime !== null) {
        const dt = Math.min(Math.max((now - lastTickTime) / 1000, 0), 0.1); // clamp: guards a stalled/backgrounded tab
        controls.autoRotateSpeed = state.baseRotateSpeed * dt * 60;
      }
      lastTickTime = now;

      const dist = world.camera().position.length();
      const nextTier = dist > TIER_FAR ? 'far' : dist > TIER_MID ? 'mid' : 'near';
      if (nextTier !== state.tier) {
        state.tier = nextTier;
        refreshLabels();
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);

    setupUI(world);
    revealApp();
  }

  function selectCountry(feat) {
    if (!feat) return;
    const idx = state.selected.indexOf(feat);
    if (idx !== -1) {
      // Tapping an already-selected country just deselects that one.
      state.selected.splice(idx, 1);
    } else {
      state.selected.push(feat);
      if (state.selected.length > MAX_SELECTED) state.selected.shift(); // drop the oldest pick
    }
    refreshPolygonStyle();
    renderPanel();

    if (!state.selected.length) { closePanel(); return; }
    flyToSelection();
  }

  // Frames the camera around every selected country. A single pick zooms in close;
  // multiple picks average their centroids and zoom out enough — based on how spread
  // out they are — to keep all of them on screen together.
  function flyToSelection() {
    clearGlobeShift();
    const centroids = state.selected.map(f => d3.geoCentroid(f)); // [lng, lat]
    if (centroids.length === 1) {
      const c = centroids[0];
      state.world.pointOfView({ lat: c[1], lng: c[0], altitude: 0.55 }, 1500);
      return;
    }
    const avgLng = centroids.reduce((s, c) => s + c[0], 0) / centroids.length;
    const avgLat = centroids.reduce((s, c) => s + c[1], 0) / centroids.length;
    let maxSpread = 0;
    centroids.forEach(c => {
      const d = Math.hypot(c[0] - avgLng, c[1] - avgLat);
      if (d > maxSpread) maxSpread = d;
    });
    const altitude = Math.min(3.2, Math.max(0.6, 0.45 + maxSpread * 0.028));
    state.world.pointOfView({ lat: avgLat, lng: avgLng, altitude }, 1500);
  }

  /* ---------------- Idle UI: layers / dock / search all fade together so
     rotation stays clean, and come back with a tap ---------------- */
  const FADE_SELECTOR = '#layers, .control-dock, .search-wrap';
  let uiHideTimer = null;
  function scheduleHideUI(delay = 4000) {
    clearTimeout(uiHideTimer);
    uiHideTimer = setTimeout(() => {
      // Don't hide out from under someone actively searching
      if (document.activeElement && document.activeElement.id === 'search') {
        scheduleHideUI();
        return;
      }
      document.querySelectorAll(FADE_SELECTOR).forEach(el => el.classList.add('is-hidden'));
    }, delay);
  }
  function showUI() {
    document.querySelectorAll(FADE_SELECTOR).forEach(el => el.classList.remove('is-hidden'));
    scheduleHideUI();
  }

  /* ---------------- UI wiring ---------------- */
  function setupUI(world) {
    // Layer chips
    document.querySelectorAll('.chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const layer = btn.dataset.layer;
        state.layers[layer] = !state.layers[layer];
        btn.classList.toggle('is-active', state.layers[layer]);
        refreshLabels();
      });
    });

    // Tap anywhere outside the fading UI to bring it back; tapping inside
    // any of it just keeps it visible a while longer.
    document.addEventListener('click', (e) => {
      if (e.target.closest(FADE_SELECTOR)) scheduleHideUI();
      else showUI();
    });
    scheduleHideUI();

    // Map / Satellite mode switch
    document.querySelectorAll('.mode-btn').forEach(btn => {
      btn.addEventListener('click', () => setMode(btn.dataset.mode));
    });

    // Rotation speed switch
    document.querySelectorAll('.speed-btn').forEach(btn => {
      btn.addEventListener('click', () => setRotateSpeed(btn.dataset.speed, world));
    });

    // Zoom buttons — smooth, eased dolly
    document.getElementById('zoom-in').addEventListener('click', () => { if (state.turbo) exitTurbo(); smoothZoomBy(0.7); });
    document.getElementById('zoom-out').addEventListener('click', () => { if (state.turbo) exitTurbo(); smoothZoomBy(1.4); });
    document.getElementById('zoom-labels').addEventListener('click', () => { if (state.turbo) exitTurbo(); snapToLabelsView(); });
    document.getElementById('recenter').addEventListener('click', () => {
      if (state.turbo) exitTurbo();
      clearGlobeShift();
      state.selected = [];
      refreshPolygonStyle();
      closePanel();
      world.pointOfView({ lat: 23.48, lng: 80.12, altitude: 2.15 }, 1300);
    });

    // Panel: clear every pinned country at once
    document.getElementById('panel-clear').addEventListener('click', () => {
      state.selected = [];
      refreshPolygonStyle();
      closePanel();
    });

    // Search
    const input = document.getElementById('search');
    const results = document.getElementById('search-results');
    input.addEventListener('focus', () => showUI());
    input.addEventListener('input', () => {
      scheduleHideUI(); // keep the bar up while actively typing
      const q = input.value.trim().toLowerCase();
      results.innerHTML = '';
      if (!q) { results.classList.remove('open'); return; }
      const matches = state.countries
        .filter(f => f.properties.name.toLowerCase().includes(q))
        .slice(0, 7);
      if (!matches.length) { results.classList.remove('open'); return; }
      matches.forEach(f => {
        const item = document.createElement('div');
        item.className = 'search-item';
        item.textContent = f.properties.name;
        item.addEventListener('click', () => {
          if (state.turbo) exitTurbo();
          selectCountry(f); // adds to the current pin selection (tap again elsewhere to remove)
          results.classList.remove('open');
          input.value = '';
          input.blur();
        });
        results.appendChild(item);
      });
      results.classList.add('open');
    });
    input.addEventListener('focus', () => { if (results.children.length) results.classList.add('open'); });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.search-wrap')) results.classList.remove('open');
    });
  }

  /* ---------------- Map / Satellite mode ---------------- */
  function setMode(mode) {
    if (state.turbo) exitTurbo();
    if (mode === state.mode) return;
    state.mode = mode;

    document.querySelectorAll('.mode-btn').forEach(b => {
      const active = b.dataset.mode === mode;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-selected', String(active));
    });

    const globeEl = document.getElementById('globeViz');
    globeEl.classList.add('crossfade');
    setTimeout(() => {
      state.world.globeImageUrl(mode === 'satellite' ? SATELLITE_TEXTURE_URL : state.mapTexture);
      refreshPolygonStyle();
      requestAnimationFrame(() => globeEl.classList.remove('crossfade'));
    }, 260);
  }

  /* ---------------- Rotation speed ---------------- */
  function setRotateSpeed(val, world) {
    if (val === 'turbo') { enterTurbo(world); return; }
    if (state.turbo) { exitTurbo(); }

    state.rotateSpeed = val;
    state.prevRotateSpeed = val;
    document.querySelectorAll('.speed-btn').forEach(b => {
      const active = b.dataset.speed === val;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-selected', String(active));
    });
    const controls = world.controls();
    state.baseRotateSpeed = ROTATE_SPEEDS[val];
    controls.autoRotate = true; // picking a speed resumes/keeps the globe spinning
  }

  /* ---------------- Turbo: fun, lightweight, cartoon "toy globe" mode ----------------
     Strips out the country polygons and every label (the app's actual "weight"),
     swaps in a tiny low-res texture, zooms out, and spins fast with a bouncy,
     cartoon-ish speed ramp. Any real interaction (mode switch, zoom, search,
     recenter, or just tapping the globe) eases it back to normal. */
  function enterTurbo(world) {
    if (state.turbo) return;
    state.prevRotateSpeed = state.rotateSpeed;
    state.rotateSpeed = 'turbo';
    state.turbo = true;
    state.prevPOV = world.pointOfView();

    document.querySelectorAll('.speed-btn').forEach(b => {
      const active = b.dataset.speed === 'turbo';
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-selected', String(active));
    });

    clearTimeout(uiHideTimer);
    document.getElementById('layers').classList.add('is-hidden');
    clearGlobeShift();
    state.selected = [];
    refreshPolygonStyle();
    closePanel();

    const globeEl = document.getElementById('globeViz');
    document.body.classList.add('turbo');
    globeEl.classList.add('crossfade');
    setTimeout(() => {
      world.globeImageUrl(state.turboTexture);
      world.polygonsData([]);
      world.showAtmosphere(false);
      world.renderer().setPixelRatio(1); // extra headroom for a very fast spin
      refreshLabels();
      requestAnimationFrame(() => globeEl.classList.remove('crossfade'));
    }, 260);

    world.pointOfView({ lat: state.prevPOV.lat, lng: state.prevPOV.lng, altitude: TURBO_ALTITUDE }, 900);

    const controls = world.controls();
    controls.autoRotate = true;
    animateAutoRotateSpeed(TURBO_ROTATE_SPEED, 900, easeOutBack);

    globeEl.classList.add('turbo-pop');
    setTimeout(() => globeEl.classList.remove('turbo-pop'), 650);
  }

  function exitTurbo() {
    if (!state.turbo) return;
    state.turbo = false;
    state.rotateSpeed = state.prevRotateSpeed;

    document.querySelectorAll('.speed-btn').forEach(b => {
      const active = b.dataset.speed === state.rotateSpeed;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-selected', String(active));
    });

    document.body.classList.remove('turbo');

    const world = state.world;
    const globeEl = document.getElementById('globeViz');
    globeEl.classList.add('crossfade');
    setTimeout(() => {
      world.globeImageUrl(state.mode === 'satellite' ? SATELLITE_TEXTURE_URL : state.mapTexture);
      world.polygonsData(state.countries);
      world.showAtmosphere(true);
      world.renderer().setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      refreshPolygonStyle();
      refreshLabels();
      requestAnimationFrame(() => globeEl.classList.remove('crossfade'));
    }, 260);

    if (state.prevPOV) world.pointOfView(state.prevPOV, 900);

    const controls = world.controls();
    controls.autoRotate = true;
    animateAutoRotateSpeed(ROTATE_SPEEDS[state.rotateSpeed] ?? ROTATE_SPEEDS['0.5'], 700, easeOutCubic);

    scheduleHideUI();
  }

  function renderPanel() {
    const kindEl = document.getElementById('panel-kind');
    const cardsEl = document.getElementById('panel-cards');
    kindEl.textContent = state.selected.length > 1 ? `${state.selected.length} countries` : 'Country';
    cardsEl.innerHTML = '';
    state.selected.forEach(feat => {
      const { name, neighbors } = feat.properties;
      const card = document.createElement('div');
      card.className = 'panel-card';

      const closeBtn = document.createElement('button');
      closeBtn.className = 'panel-card-close';
      closeBtn.setAttribute('aria-label', `Deselect ${name}`);
      closeBtn.textContent = '×';
      closeBtn.addEventListener('click', (e) => { e.stopPropagation(); selectCountry(feat); });

      const h3 = document.createElement('h3');
      h3.textContent = name;

      const p = document.createElement('p');
      p.className = 'panel-card-borders';
      p.textContent = neighbors && neighbors.length ? `Borders ${neighbors.join(', ')}` : 'An island nation with no land borders.';

      card.append(closeBtn, h3, p);
      cardsEl.appendChild(card);

      // Only every neighbor already fits within the 3-line clamp for some cards;
      // for the rest, offer a tap to read the full list instead of just cutting it off.
      requestAnimationFrame(() => {
        if (p.scrollHeight > p.clientHeight + 1) {
          const more = document.createElement('button');
          more.className = 'panel-card-more';
          more.type = 'button';
          more.textContent = 'More';
          more.addEventListener('click', (e) => {
            e.stopPropagation();
            const expanded = p.classList.toggle('expanded');
            more.textContent = expanded ? 'Less' : 'More';
          });
          card.appendChild(more);
        }
      });
    });
    document.getElementById('panel').classList.add('open');
  }
  function closePanel() {
    document.getElementById('panel').classList.remove('open');
  }
  function fadeHint() {
    document.getElementById('hint').classList.add('faded');
  }

  let resizeRAF = null;
  function onResize() {
    // Coalesce rapid-fire resize/orientation events into one update per frame.
    if (resizeRAF) cancelAnimationFrame(resizeRAF);
    resizeRAF = requestAnimationFrame(() => {
      initStars();
      if (state.world) {
        state.world.width(vw()).height(vh());
        state.world.renderer().setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      }
      resizeRAF = null;
    });
  }

  function revealApp() {
    const loader = document.getElementById('loader');
    const app = document.getElementById('app');
    setTimeout(() => {
      loader.classList.add('hidden');
      app.classList.add('visible');
      app.removeAttribute('aria-hidden');
      setTimeout(() => fadeHint(), 6000);
    }, 350);
  }

  init();
})();
