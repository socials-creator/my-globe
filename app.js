(() => {
  'use strict';

  /* ---------------- Config ---------------- */
  const GLOBE_RADIUS = 100; // three-globe's internal sphere radius, in world units
  const COLORS = {
    ocean:    '#0d1712',
    grid:     '#16241d',
    land:     '#F4F1EA',
    landEdge: 'rgba(20,18,16,0.55)',
    hover:    '#D97757',
    selected: '#D97757',
    labelCountry:  '#F4F1EA',
    labelContinent:'#D97757',
    labelOcean:    '#7FB6B0',
    labelSea:      '#6FA3A0',
    labelMountain: '#C7A46B',
    labelDesert:   '#D8B073',
    labelRiver:    '#7FB0C4',
    labelLake:     '#7FB0C4',
  };

  // Camera-distance tiers (world units from globe centre). Larger = further away.
  const TIER_FAR    = 250; // above this: continents + oceans only
  const TIER_MID    = 150; // between MID and FAR: + countries, seas
  // below TIER_MID: + terrain / hydro fine features (if their layer is active)

  const state = {
    tier: 'far',              // 'far' | 'mid' | 'near'
    layers: { countries: true, water: true, terrain: false, hydro: false },
    hoverD: null,
    selectedD: null,
    world: null,
    countries: [],
    countryLabels: [],
    userInteracted: false,
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
    requestAnimationFrame(drawStars);
  }

  /* ---------------- Procedural ocean texture (graticule) ---------------- */
  function buildOceanTexture() {
    const w = 1024, h = 512;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');

    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#122019');
    grad.addColorStop(0.5, COLORS.ocean);
    grad.addColorStop(1, '#122019');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    for (let lng = 0; lng <= w; lng += w / 12) { // every 30deg
      ctx.beginPath(); ctx.moveTo(lng, 0); ctx.lineTo(lng, h); ctx.stroke();
    }
    for (let lat = 0; lat <= h; lat += h / 12) { // every 15deg
      ctx.beginPath(); ctx.moveTo(0, lat); ctx.lineTo(w, lat); ctx.stroke();
    }
    // equator + prime meridian, slightly stronger
    ctx.strokeStyle = 'rgba(217,119,87,0.10)';
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

    const oceanTexture = buildOceanTexture();

    const world = Globe()(document.getElementById('globeViz'))
      .width(window.innerWidth)
      .height(window.innerHeight)
      .backgroundColor('rgba(0,0,0,0)')
      .globeImageUrl(oceanTexture)
      .showAtmosphere(true)
      .atmosphereColor('#D97757')
      .atmosphereAltitude(0.2)

      .polygonsData(state.countries)
      .polygonAltitude(d => (d === state.selectedD ? 0.045 : d === state.hoverD ? 0.02 : 0.006))
      .polygonCapColor(d => (d === state.selectedD || d === state.hoverD) ? COLORS.hover : COLORS.land)
      .polygonSideColor(() => 'rgba(20,18,16,0.35)')
      .polygonStrokeColor(() => COLORS.landEdge)
      .polygonsTransitionDuration(350)
      .onPolygonHover(d => {
        if (d === state.hoverD) return;
        state.hoverD = d;
        world
          .polygonAltitude(x => (x === state.selectedD ? 0.045 : x === state.hoverD ? 0.02 : 0.006))
          .polygonCapColor(x => (x === state.selectedD || x === state.hoverD) ? COLORS.hover : COLORS.land);
        document.body.style.cursor = d ? 'pointer' : 'default';
      })
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

    // Controls
    const controls = world.controls();
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.55;
    controls.zoomSpeed = 0.65;
    controls.minDistance = GLOBE_RADIUS + 1;   // maximum zoom-in: just above the surface
    controls.maxDistance = GLOBE_RADIUS * 5;   // maximum zoom-out
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.35;
    controls.addEventListener('start', () => {
      if (!state.userInteracted) {
        state.userInteracted = true;
        controls.autoRotate = false;
        fadeHint();
      }
    });

    // Intro camera fly-in
    world.pointOfView({ lat: 18, lng: 12, altitude: 3.4 }, 0);
    setTimeout(() => world.pointOfView({ lat: 18, lng: 12, altitude: 2.15 }, 2200), 250);

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
    state.selectedD = feat;
    state.world
      .polygonAltitude(x => (x === state.selectedD ? 0.045 : x === state.hoverD ? 0.02 : 0.006))
      .polygonCapColor(x => (x === state.selectedD || x === state.hoverD) ? COLORS.hover : COLORS.land);

    const c = d3.geoCentroid(feat);
    state.world.pointOfView({ lat: c[1], lng: c[0], altitude: 0.55 }, 1400);

    const { name, neighbors } = feat.properties;
    openPanel('Country', name, neighbors && neighbors.length ? `Borders ${neighbors.join(', ')}` : 'An island nation with no land borders.');
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

    // Zoom buttons
    const zoomBy = (factor) => {
      const controls = world.controls();
      const camera = world.camera();
      const dir = camera.position.clone().normalize();
      let dist = camera.position.length() * factor;
      dist = Math.max(controls.minDistance, Math.min(controls.maxDistance, dist));
      camera.position.copy(dir.multiplyScalar(dist));
      controls.update();
    };
    document.getElementById('zoom-in').addEventListener('click', () => zoomBy(0.72));
    document.getElementById('zoom-out').addEventListener('click', () => zoomBy(1.38));
    document.getElementById('recenter').addEventListener('click', () => {
      state.selectedD = null;
      closePanel();
      world.pointOfView({ lat: 18, lng: 12, altitude: 2.15 }, 1200);
    });

    // Panel close
    document.getElementById('panel-close').addEventListener('click', closePanel);

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

  function openPanel(kind, title, sub) {
    document.getElementById('panel-kind').textContent = kind;
    document.getElementById('panel-title').textContent = title;
    document.getElementById('panel-sub').textContent = sub;
    document.getElementById('panel').classList.add('open');
  }
  function closePanel() {
    document.getElementById('panel').classList.remove('open');
    state.selectedD = null;
    if (state.world) {
      state.world
        .polygonAltitude(x => (x === state.hoverD ? 0.02 : 0.006))
        .polygonCapColor(x => (x === state.hoverD ? COLORS.hover : COLORS.land));
    }
  }
  function fadeHint() {
    document.getElementById('hint').classList.add('faded');
  }

  function onResize() {
    initStars();
    if (state.world) state.world.width(window.innerWidth).height(window.innerHeight);
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
