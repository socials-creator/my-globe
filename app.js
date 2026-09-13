(() => {
  'use strict';

  /* ---------------- Config ---------------- */
  const GLOBE_RADIUS = 100; // three-globe's internal sphere radius, in world units
  const SATELLITE_TEXTURE_URL = 'https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg';

  const COLORS = {
    ocean:     '#04122B',   // electric-blue deep base
    oceanMid:  '#0A6CFF',   // electric blue
    grid:      '#1958C7',
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

  const state = {
    tier: 'far',              // 'far' | 'mid' | 'near'
    mode: 'map',               // 'map' | 'satellite'
    layers: { countries: true, water: true, terrain: false, hydro: false },
    selectedD: null,
    world: null,
    countries: [],
    countryLabels: [],
    userInteracted: false,
    mapTexture: null,
    rotateSpeed: '0.5',
    visible: true,
  };

  /* ---------------- Starfield (plain 2D canvas, behind the WebGL globe) ---------------- */
  const starCanvas = document.getElementById('stars');
  const starCtx = starCanvas.getContext('2d');
  let stars = [];

  function initStars() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    starCanvas.width = window.innerWidth * dpr;
    starCanvas.height = window.innerHeight * dpr;
    starCanvas.style.width = window.innerWidth + 'px';
    starCanvas.style.height = window.innerHeight + 'px';
    starCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const count = Math.round((window.innerWidth * window.innerHeight) / 3200);
    stars = Array.from({ length: count }, () => ({
      x: Math.random() * window.innerWidth,
      y: Math.random() * window.innerHeight,
      r: Math.random() * 1.1 + 0.15,
      base: Math.random() * 0.5 + 0.15,
      phase: Math.random() * Math.PI * 2,
      speed: Math.random() * 0.0006 + 0.0002,
    }));
  }

  function drawStars(t) {
    if (state.visible) {
      starCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
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

    // subtle radial glow band to keep the blue feeling electric, not flat
    const glow = ctx.createRadialGradient(w / 2, h / 2, h * 0.1, w / 2, h / 2, h * 0.9);
    glow.addColorStop(0, 'rgba(90,170,255,0.35)');
    glow.addColorStop(1, 'rgba(90,170,255,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(120,190,255,0.16)';
    ctx.lineWidth = 1;
    for (let lng = 0; lng <= w; lng += w / 12) { // every 30deg
      ctx.beginPath(); ctx.moveTo(lng, 0); ctx.lineTo(lng, h); ctx.stroke();
    }
    for (let lat = 0; lat <= h; lat += h / 12) { // every 15deg
      ctx.beginPath(); ctx.moveTo(0, lat); ctx.lineTo(w, lat); ctx.stroke();
    }
    // equator + prime meridian, slightly stronger
    ctx.strokeStyle = 'rgba(190,225,255,0.22)';
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h); ctx.stroke();

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
    if (cat === 'continent') return true;
    if (cat === 'ocean') return true;
    if (cat === 'sea') return state.tier !== 'far';
    if (cat === 'country') return state.tier !== 'far' && state.layers.countries;
    if (cat === 'mountain' || cat === 'desert') return state.tier === 'near' && state.layers.terrain;
    if (cat === 'river' || cat === 'lake') return state.tier === 'near' && state.layers.hydro;
    return false;
  }
  function categoryLayerActive(cat) {
    if (cat === 'ocean' || cat === 'sea') return state.layers.water;
    if (cat === 'country' || cat === 'continent') return true;
    if (cat === 'mountain' || cat === 'desert') return state.layers.terrain;
    if (cat === 'river' || cat === 'lake') return state.layers.hydro;
    return true;
  }

  function currentLabels() {
    const all = state.countryLabels.concat(EARTH_FEATURES);
    return all.filter(d => categoryLayerActive(d.category) && visibleForTier(d.category));
  }

  function refreshLabels() {
    state.world.labelsData(currentLabels());
  }

  /* ---------------- Polygon styling (mode + single-selection aware) ---------------- */
  function polygonAltitudeFn(d) {
    return d === state.selectedD ? 0.05 : 0.006;
  }
  function polygonCapColorFn(d) {
    if (d === state.selectedD) {
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

  function smoothZoomBy(factor, duration = 480) {
    const controls = state.world.controls();
    const camera = state.world.camera();
    const dir = camera.position.clone().normalize();
    const startDist = camera.position.length();
    let targetDist = startDist * factor;
    targetDist = Math.max(controls.minDistance, Math.min(controls.maxDistance, targetDist));
    const t0 = performance.now();
    controls.enabled = false;
    (function step(now) {
      const p = Math.min(1, (now - t0) / duration);
      const eased = easeOutCubic(p);
      const dist = startDist + (targetDist - startDist) * eased;
      camera.position.copy(dir.clone().multiplyScalar(dist));
      controls.update();
      if (p < 1) requestAnimationFrame(step);
      else controls.enabled = true;
    })(t0);
  }

  /* ---------------- Auto-rotate: ease out instead of a hard stop ---------------- */
  function easeOutAutoRotate() {
    const controls = state.world.controls();
    const startSpeed = controls.autoRotateSpeed;
    const t0 = performance.now();
    const duration = 700;
    (function step(now) {
      const p = Math.min(1, (now - t0) / duration);
      controls.autoRotateSpeed = startSpeed * (1 - easeOutCubic(p));
      if (p < 1) requestAnimationFrame(step);
      else controls.autoRotate = false;
    })(t0);
  }

  /* ---------------- Init ---------------- */
  async function init() {
    initStars();
    requestAnimationFrame(drawStars);
    window.addEventListener('resize', onResize);

    const geo = await fetch('data/world.geojson').then(r => r.json());
    state.countries = geo.features;

    state.countryLabels = geo.features.map(f => {
      const c = d3.geoCentroid(f);
      return { name: f.properties.name, lat: c[1], lng: c[0], category: 'country', feature: f };
    });

    state.mapTexture = buildOceanTexture();

    const world = Globe({
      rendererConfig: { antialias: true, alpha: true, powerPreference: 'high-performance' }
    })(document.getElementById('globeViz'))
      .width(window.innerWidth)
      .height(window.innerHeight)
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
    controls.autoRotateSpeed = ROTATE_SPEEDS[state.rotateSpeed];
    controls.addEventListener('start', () => {
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
    world.pointOfView({ lat: 18, lng: 12, altitude: 3.4 }, 0);
    setTimeout(() => world.pointOfView({ lat: 18, lng: 12, altitude: 2.15 }, 2400), 250);

    // LOD watcher
    (function tick() {
      const dist = world.camera().position.length();
      const nextTier = dist > TIER_FAR ? 'far' : dist > TIER_MID ? 'mid' : 'near';
      if (nextTier !== state.tier) {
        state.tier = nextTier;
        refreshLabels();
      }
      requestAnimationFrame(tick);
    })();

    setupUI(world);
    revealApp();
  }

  function selectCountry(feat) {
    if (!feat) return;
    // Tapping the already-selected country deselects it; otherwise it becomes the sole selection.
    state.selectedD = (state.selectedD === feat) ? null : feat;
    refreshPolygonStyle();

    if (!state.selectedD) { closePanel(); return; }

    const c = d3.geoCentroid(feat);
    state.world.pointOfView({ lat: c[1], lng: c[0], altitude: 0.55 }, 1500);

    const { name, neighbors } = feat.properties;
    openPanel('Country', name, neighbors && neighbors.length ? `Borders ${neighbors.join(', ')}` : 'An island nation with no land borders.');
  }

  /* ---------------- Layer bar: auto-hide so idle rotation stays clean ---------------- */
  let layersHideTimer = null;
  function scheduleHideLayers(delay = 4000) {
    clearTimeout(layersHideTimer);
    layersHideTimer = setTimeout(() => {
      document.getElementById('layers').classList.add('is-hidden');
    }, delay);
  }
  function showLayersBar() {
    document.getElementById('layers').classList.remove('is-hidden');
    scheduleHideLayers();
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
        scheduleHideLayers();
      });
    });

    // Tap anywhere outside the layer bar to bring it back
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.layers')) showLayersBar();
    });
    scheduleHideLayers();

    // Map / Satellite mode switch
    document.querySelectorAll('.mode-btn').forEach(btn => {
      btn.addEventListener('click', () => setMode(btn.dataset.mode));
    });

    // Rotation speed switch
    document.querySelectorAll('.speed-btn').forEach(btn => {
      btn.addEventListener('click', () => setRotateSpeed(btn.dataset.speed, world));
    });

    // Zoom buttons — smooth, eased dolly
    document.getElementById('zoom-in').addEventListener('click', () => smoothZoomBy(0.7));
    document.getElementById('zoom-out').addEventListener('click', () => smoothZoomBy(1.4));
    document.getElementById('recenter').addEventListener('click', () => {
      state.selectedD = null;
      refreshPolygonStyle();
      closePanel();
      world.pointOfView({ lat: 18, lng: 12, altitude: 2.15 }, 1300);
    });

    // Panel close
    document.getElementById('panel-close').addEventListener('click', () => {
      state.selectedD = null;
      refreshPolygonStyle();
      closePanel();
    });

    // Search
    const input = document.getElementById('search');
    const results = document.getElementById('search-results');
    input.addEventListener('input', () => {
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
          state.selectedD = null; // ensure the new pick becomes the sole selection
          selectCountry(f);
          results.classList.remove('open');
          input.value = f.properties.name;
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
    state.rotateSpeed = val;
    document.querySelectorAll('.speed-btn').forEach(b => {
      const active = b.dataset.speed === val;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-selected', String(active));
    });
    const controls = world.controls();
    controls.autoRotateSpeed = ROTATE_SPEEDS[val];
    controls.autoRotate = true; // picking a speed resumes/keeps the globe spinning
  }

  function openPanel(kind, title, sub) {
    document.getElementById('panel-kind').textContent = kind;
    document.getElementById('panel-title').textContent = title;
    document.getElementById('panel-sub').textContent = sub;
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
        state.world.width(window.innerWidth).height(window.innerHeight);
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
