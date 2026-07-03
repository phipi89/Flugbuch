(() => {
  console.log("[terrain] terrain_viewer.js loaded");

  const COLORS = {
    slopeFlat: 0xfcf8f3,
    slopeSteep: 0xb8d0f0,
    path: 0x111827,
    marker: 0xf97316,
    rim: 0xdbe7f3,
    wallTop: [0x52 / 255, 0x45 / 255, 0x2e / 255],
    wallBottom: [0x21 / 255, 0x1a / 255, 0x14 / 255],
    contour: 0x111827,
  };
  const SLOPE_MAX_RADIANS = Math.PI / 2;
  const SLOPE_GAMMA = 0.8;
  const CONTOUR_INTERVAL_M = 100;
  const CONTOUR_OPACITY = 0.16;
  const CONTOUR_LIFT_M = 1.5;
  const IDLE_REFINE_DELAY_MS = 500;
  const VIEW_DRAG_DEADZONE_PX = 12;
  const VIEW_DRAG_THRESHOLD_PX = 90;

  const state = {
    renderer: null,
    scene: null,
    camera: null,
    root: null,
    overlayRoot: null,
    currentMarker: null,
    data: null,
    meta: null,
    overviewData: null,
    pendingRetry: null,
    pendingRequest: null,
    abortController: null,
    requestSerial: 0,
    terrainCache: new Map(),
    tileCache: new Map(),
    pendingTileRequests: new Map(),
    textureCache: new Map(),
    pendingTextureRequests: new Map(),
    overlayTextureCache: new Map(),
    pendingOverlayRequests: new Map(),
    activeOverlay: null,
    wallTexture: null,
    flightOptions: null,
    flightLabel: null,
    loadingFlight: false,
    showLandcover: true,
    terrainLayer: "slope",
    qualityMode: "idle",
    idleTimer: null,
    azimuth: Math.PI / 4,
    dragging: false,
    dragStartX: 0,
    dragStartY: 0,
    dragStartAzimuth: 0,
    dragStartIndex: 0,
    dragGesture: null,
    dragStartViewMode: "isometric",
    dragStartCameraTarget: null,
    dragPreviewTarget: null,
    dragTargetViewMode: null,
    dragViewSettled: false,
    dragRequestTimer: null,
    viewMode: "isometric",
    cameraAnimation: null,
    dragInstalled: false,
    scrubInstalled: false,
    focusIndex: 0,
    centerIndex: 0,
    directionalLight: null,
    cutoutRadius: 1200,
    minCutoutRadius: 450,
    maxCutoutRadius: 1200,
    playTimer: null,
  };

  function setStatus(message) {
    const status = document.getElementById("terrain-status");
    if (status) status.textContent = message;
    console.log(`[terrain] ${message}`);
  }

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function formatSigned(value, digits = 1) {
    if (!Number.isFinite(value)) return "-";
    return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
  }

  function updateInfoPanel() {
    const meta = state.meta;
    if (!meta?.flightPath?.length) return;
    const index = Math.max(0, Math.min(meta.flightPath.length - 1, state.focusIndex));
    const point = meta.flightPath[index];
    const asl = point?.[2];
    const agl = meta.heightAboveGround?.[index];
    const speedMs = meta.groundSpeedMs?.[index];
    const varioMs = meta.verticalSpeedMs?.[index];

    setText("info-asl", Number.isFinite(asl) ? `${Math.round(asl)} m` : "-");
    setText("info-agl", Number.isFinite(agl) ? `${Math.round(agl)} m` : "-");
    setText("info-speed", Number.isFinite(speedMs) ? `${Math.round(speedMs * 3.6)} km/h` : "-");
    setText("info-vario", Number.isFinite(varioMs) ? `${formatSigned(varioMs)} m/s` : "-");
  }

  function mapAngleFromAzimuth(azimuth) {
    return -(azimuth + Math.PI / 2);
  }

  function localX(x, center) {
    return x - center[0];
  }

  function localY(y, center) {
    return -(y - center[1]);
  }

  function viewCenter() {
    const point =
      state.data.flightPath[
        Math.min(state.centerIndex, state.data.flightPath.length - 1)
      ];
    return clampedCenterFor(point, viewRadius());
  }

  function viewRadius() {
    return Math.max(
      state.minCutoutRadius,
      Math.min(state.maxCutoutRadius, state.cutoutRadius),
    );
  }

  function clampedCenterFor(point, radius) {
    const full = state.meta.fullCircle;
    const fullCenter = full.center;
    const maxDistance = Math.max(0, full.radius - radius);
    const dx = point[0] - fullCenter[0];
    const dy = point[1] - fullCenter[1];
    const distance = Math.hypot(dx, dy);
    if (distance <= maxDistance || distance === 0) return [point[0], point[1]];
    return [
      fullCenter[0] + (dx / distance) * maxDistance,
      fullCenter[1] + (dy / distance) * maxDistance,
    ];
  }

  function overviewFor(centerIndex, radius) {
    if (!state.overviewData || !state.meta) return null;
    const point =
      state.meta.flightPath[
        Math.max(0, Math.min(state.meta.flightPath.length - 1, centerIndex))
      ];
    return {
      ...state.overviewData,
      circle: {
        center: clampedCenterFor(point, radius),
        radius,
      },
      fullCircle: state.meta.fullCircle,
      flightPath: state.meta.flightPath,
      focusIndex: state.focusIndex,
      centerIndex,
      minRadius: state.minCutoutRadius,
      maxRadius: state.maxCutoutRadius,
      resolution: state.overviewData.resolution,
      preview: true,
    };
  }

  function baseLodForRadius(radius) {
    if (radius >= 5000) return { tileSize: 5000, resolution: 18 };
    if (radius >= 2500) return { tileSize: 2000, resolution: 6 };
    return { tileSize: 1000, resolution: 2 };
  }

  function coarserLod(lod) {
    if (lod.resolution <= 2) return { tileSize: 2000, resolution: 6 };
    if (lod.resolution <= 6) return { tileSize: 5000, resolution: 18 };
    return lod;
  }

  function lodForRadius(radius, qualityMode = state.qualityMode) {
    const lod = baseLodForRadius(radius);
    return qualityMode === "interactive" ? coarserLod(lod) : lod;
  }

  function tileKey(tile) {
    return `${tile.resolution}:${tile.size}:${tile.x0}:${tile.y0}`;
  }

  function tileIntersectsCircle(x0, y0, size, center, radius) {
    const nearestX = Math.max(x0, Math.min(center[0], x0 + size));
    const nearestY = Math.max(y0, Math.min(center[1], y0 + size));
    const dx = nearestX - center[0];
    const dy = nearestY - center[1];
    return dx * dx + dy * dy <= radius * radius;
  }

  function neededTiles(center, radius, lod) {
    const tiles = [];
    const size = lod.tileSize;
    const minX = Math.floor((center[0] - radius) / size) * size;
    const maxX = Math.floor((center[0] + radius) / size) * size;
    const minY = Math.floor((center[1] - radius) / size) * size;
    const maxY = Math.floor((center[1] + radius) / size) * size;
    for (let x0 = minX; x0 <= maxX; x0 += size) {
      for (let y0 = minY; y0 <= maxY; y0 += size) {
        if (tileIntersectsCircle(x0, y0, size, center, radius)) {
          tiles.push({ x0, y0, size, resolution: lod.resolution });
        }
      }
    }
    return tiles;
  }

  function assembleTerrainFromTiles(tiles, circle, focusIndex, centerIndex, resolution) {
    const tilePayloads = tiles.map(
      (tile) => state.tileCache.get(tileKey(tile)).tile,
    );
    const minX = Math.min(...tilePayloads.map((tile) => tile.x0));
    const minY = Math.min(...tilePayloads.map((tile) => tile.y0));
    const maxX = Math.max(
      ...tilePayloads.map((tile) => tile.x0 + tile.resolution * tile.width),
    );
    const maxY = Math.max(
      ...tilePayloads.map((tile) => tile.y0 + tile.resolution * tile.height),
    );
    const width = Math.round((maxX - minX) / resolution);
    const height = Math.round((maxY - minY) / resolution);
    const z = new Array(width * height).fill(NaN);

    for (const tile of tilePayloads) {
      const xOffset = Math.round((tile.x0 - minX) / resolution);
      const yOffset = Math.round((tile.y0 - minY) / resolution);
      for (let y = 0; y < tile.height; y += 1) {
        for (let x = 0; x < tile.width; x += 1) {
          z[(yOffset + y) * width + xOffset + x] = tile.z[y * tile.width + x];
        }
      }
    }

    let zMin = Infinity;
    let zMax = -Infinity;
    let sum = 0;
    let count = 0;
    for (const value of z) {
      if (!Number.isNaN(value)) {
        zMin = Math.min(zMin, value);
        zMax = Math.max(zMax, value);
        sum += value;
        count += 1;
      }
    }
    const fill = count ? sum / count : 0;
    for (let i = 0; i < z.length; i += 1) {
      if (Number.isNaN(z[i])) z[i] = fill;
    }

    return {
      terrain: {
        x0: minX,
        y0: minY,
        dx: resolution,
        dy: resolution,
        width,
        height,
        z,
        zMin,
        zMax,
      },
      circle,
      fullCircle: state.meta.fullCircle,
      flightPath: state.meta.flightPath,
      sun: state.meta.sun,
      focusIndex,
      centerIndex,
      resolution,
      minRadius: state.minCutoutRadius,
      maxRadius: state.maxCutoutRadius,
    };
  }

  function ensureTile(tile) {
    const key = tileKey(tile);
    if (state.tileCache.has(key)) {
      return Promise.resolve({
        tile,
        payload: state.tileCache.get(key),
        cached: true,
        jsonMs: 0,
      });
    }
    if (state.pendingTileRequests.has(key)) {
      return state.pendingTileRequests.get(key);
    }

    const promise = (async () => {
      const response = await fetch(
        `/terrain-tile?x0=${tile.x0}&y0=${tile.y0}&resolution=${tile.resolution}&size=${tile.size}`,
      );
      if (!response.ok)
        throw new Error(`tile ${key} failed: ${response.status}`);
      const jsonStart = performance.now();
      const payload = await response.json();
      const jsonMs = performance.now() - jsonStart;
      state.tileCache.set(key, payload);
      return { tile, payload, cached: false, jsonMs };
    })().finally(() => {
      state.pendingTileRequests.delete(key);
    });

    state.pendingTileRequests.set(key, promise);
    return promise;
  }

  function overlayKey(terrain) {
    const spec = overlaySpec(terrain);
    return `${spec.x0}:${spec.y0}:${spec.width}:${spec.height}:${spec.resolution}`;
  }

  function overlaySpec(terrain) {
    const resolution = Math.max(terrain.dx, 20);
    const width = Math.round(((terrain.width - 1) * terrain.dx) / resolution) + 1;
    const height = Math.round(((terrain.height - 1) * terrain.dy) / resolution) + 1;
    return { x0: terrain.x0, y0: terrain.y0, width, height, resolution };
  }

  function ensureOverlayTexture(terrain) {
    const spec = overlaySpec(terrain);
    const key = overlayKey(terrain);
    if (state.overlayTextureCache.has(key)) {
      return Promise.resolve({ texture: state.overlayTextureCache.get(key), spec });
    }
    if (state.pendingOverlayRequests.has(key)) return state.pendingOverlayRequests.get(key);

    const url = `/terrain-overlay?x0=${spec.x0}&y0=${spec.y0}&width=${spec.width}&height=${spec.height}&resolution=${spec.resolution}`;
    const promise = new Promise((resolve, reject) => {
      new THREE.TextureLoader().load(
        url,
        (texture) => {
          if (THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
          texture.minFilter = THREE.LinearFilter;
          texture.magFilter = THREE.LinearFilter;
          state.overlayTextureCache.set(key, texture);
          resolve({ texture, spec });
        },
        undefined,
        reject,
      );
    }).finally(() => {
      state.pendingOverlayRequests.delete(key);
    });

    state.pendingOverlayRequests.set(key, promise);
    return promise;
  }

  function terrainTextureSpec(terrain, layer = state.terrainLayer) {
    if (layer === "slope") return null;
    const resolution = Math.max(terrain.dx, 2.5);
    const width = Math.max(1, Math.round((terrain.width - 1) * terrain.dx));
    const height = Math.max(1, Math.round((terrain.height - 1) * terrain.dy));
    return { x0: terrain.x0, y0: terrain.y0, width, height, resolution, layer };
  }

  function terrainTextureKey(spec) {
    return `${spec.layer}:${spec.x0}:${spec.y0}:${spec.width}:${spec.height}:${spec.resolution}`;
  }

  function ensureTerrainTexture(terrain, layer = state.terrainLayer) {
    const spec = terrainTextureSpec(terrain, layer);
    if (!spec) return Promise.resolve(null);
    const key = terrainTextureKey(spec);
    if (state.textureCache.has(key)) return Promise.resolve(state.textureCache.get(key));
    if (state.pendingTextureRequests.has(key)) return state.pendingTextureRequests.get(key);

    const url = `/terrain-texture?x0=${spec.x0}&y0=${spec.y0}&width=${spec.width}&height=${spec.height}&resolution=${spec.resolution}&layer=${spec.layer}`;
    const promise = new Promise((resolve, reject) => {
      new THREE.TextureLoader().load(
        url,
        (texture) => {
          if (THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
          texture.minFilter = THREE.LinearFilter;
          texture.magFilter = THREE.LinearFilter;
          state.textureCache.set(key, texture);
          resolve(texture);
        },
        undefined,
        reject,
      );
    }).finally(() => {
      state.pendingTextureRequests.delete(key);
    });

    state.pendingTextureRequests.set(key, promise);
    return promise;
  }

  function applyTerrainTexture(data, material, root, layer) {
    if (layer === "slope") return;
    ensureTerrainTexture(data.terrain, layer)
      .then((texture) => {
        if (!texture || state.root !== root || state.data !== data || state.terrainLayer !== layer) return;
        material.map = texture;
        material.vertexColors = false;
        material.color.setHex(0xffffff);
        material.needsUpdate = true;
        if (state.renderer && state.scene && state.camera) {
          state.renderer.render(state.scene, state.camera);
        }
      })
      .catch((error) => {
        console.warn("[terrain] terrain texture failed", error);
      });
  }

  function sampleHeight(terrain, x, y) {
    const gx = Math.max(
      0,
      Math.min(terrain.width - 1, (x - terrain.x0) / terrain.dx),
    );
    const gy = Math.max(
      0,
      Math.min(terrain.height - 1, (y - terrain.y0) / terrain.dy),
    );
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const x1 = Math.min(terrain.width - 1, x0 + 1);
    const y1 = Math.min(terrain.height - 1, y0 + 1);
    const tx = gx - x0;
    const ty = gy - y0;
    const z00 = terrain.z[y0 * terrain.width + x0];
    const z10 = terrain.z[y0 * terrain.width + x1];
    const z01 = terrain.z[y1 * terrain.width + x0];
    const z11 = terrain.z[y1 * terrain.width + x1];
    return (
      z00 * (1 - tx) * (1 - ty) +
      z10 * tx * (1 - ty) +
      z01 * (1 - tx) * ty +
      z11 * tx * ty
    );
  }

  function applySlopeColors(geometry) {
    const normals = geometry.attributes.normal.array;
    const flatColor = COLORS.slopeFlat,
      steepColor = COLORS.slopeSteep;
    const fr = ((flatColor >> 16) & 0xff) / 255,
      fg = ((flatColor >> 8) & 0xff) / 255,
      fb = (flatColor & 0xff) / 255;
    const sr = ((steepColor >> 16) & 0xff) / 255,
      sg = ((steepColor >> 8) & 0xff) / 255,
      sb = (steepColor & 0xff) / 255;
    const colors = new Float32Array(normals.length);
    for (let i = 0; i < normals.length; i += 3) {
      const ny = -1 * normals[i + 1];
      const slopeRadians = Math.acos(THREE.MathUtils.clamp(ny, 0, 1));
      const t = Math.pow(
        THREE.MathUtils.clamp(slopeRadians / SLOPE_MAX_RADIANS, 0, 1),
        SLOPE_GAMMA,
      );
      colors[i] = THREE.MathUtils.lerp(fr, sr, t);
      colors[i + 1] = THREE.MathUtils.lerp(fg, sg, t);
      colors[i + 2] = THREE.MathUtils.lerp(fb, sb, t);
    }
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  }

  function wallGrainTexture() {
    if (state.wallTexture) return state.wallTexture;
    const size = 96;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    const image = ctx.createImageData(size, size);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const i = (y * size + x) * 4;
        const grain = 175 + Math.random() * 70 + Math.sin((x + y * 0.35) * 0.55) * 10;
        image.data[i] = grain;
        image.data[i + 1] = grain;
        image.data[i + 2] = grain;
        image.data[i + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    state.wallTexture = texture;
    return texture;
  }

  function meshStride(terrain, radius) {
    const estimatedVertices =
      (Math.PI * radius * radius) / Math.max(1, terrain.dx * terrain.dy);
    let stride = 1;
    if (estimatedVertices > 600000) stride = 4;
    else if (estimatedVertices > 300000) stride = 3;
    else if (estimatedVertices > 120000) stride = 2;
    return state.qualityMode === "interactive" ? stride + 1 : stride;
  }

  function terrainCoversCurrentView(data) {
    const terrain = data.terrain;
    const center = viewCenter();
    const radius = viewRadius();
    const pad = Math.max(terrain.dx, terrain.dy) * 2;
    const minX = terrain.x0;
    const minY = terrain.y0;
    const maxX = terrain.x0 + (terrain.width - 1) * terrain.dx;
    const maxY = terrain.y0 + (terrain.height - 1) * terrain.dy;
    return (
      center[0] - radius >= minX - pad &&
      center[0] + radius <= maxX + pad &&
      center[1] - radius >= minY - pad &&
      center[1] + radius <= maxY + pad
    );
  }

  function useOverviewIfCurrentTerrainIsTooSmall() {
    if (!state.data || state.data.preview || terrainCoversCurrentView(state.data)) return;
    const preview = overviewFor(state.centerIndex, viewRadius());
    if (preview) state.data = preview;
  }

  function enterInteractiveMode(rebuild = true) {
    window.clearTimeout(state.idleTimer);
    if (state.qualityMode !== "interactive") {
      state.qualityMode = "interactive";
      if (rebuild && state.data) rebuildGeometry();
    }
  }

  function scheduleIdleRefine() {
    window.clearTimeout(state.idleTimer);
    state.idleTimer = window.setTimeout(() => {
      if (state.qualityMode !== "idle") {
        state.qualityMode = "idle";
        if (state.data) rebuildGeometry();
      }
      requestTerrain();
    }, IDLE_REFINE_DELAY_MS);
  }

  function resetScene(container) {
    console.log("[terrain] reset scene", {
      width: container.clientWidth,
      height: container.clientHeight,
    });
    if (state.renderer) {
      state.renderer.dispose();
      container.replaceChildren();
    }

    state.scene = new THREE.Scene();
    state.scene.background = null;
    state.overlayRoot = null;
    state.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    state.renderer.shadowMap.enabled = true;
    state.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    state.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    container.appendChild(state.renderer.domElement);

    const ambient = new THREE.AmbientLight(0xffffff, 0.85);
    state.directionalLight = new THREE.DirectionalLight(0xffffff, 1.6);
    state.directionalLight.castShadow = true;
    state.directionalLight.shadow.mapSize.set(2048, 2048);
    state.directionalLight.shadow.bias = -0.0005;
    state.directionalLight.shadow.normalBias = 0.02;
    state.directionalLight.shadow.radius = 2;
    state.directionalLight.position.set(-0.7, 0.45, 1.0);
    state.scene.add(
      ambient,
      state.directionalLight,
      state.directionalLight.target,
    );
  }

  function installDrag(container) {
    if (state.dragInstalled) return;
    state.dragInstalled = true;

    container.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      state.dragging = true;
      state.dragStartX = event.clientX;
      state.dragStartY = event.clientY;
      state.dragStartAzimuth = state.azimuth;
      state.dragStartIndex = state.focusIndex;
      state.dragGesture = null;
      state.dragStartViewMode = state.viewMode;
      state.dragStartCameraTarget = cameraTargetFor(state.viewMode);
      state.dragPreviewTarget = null;
      state.dragTargetViewMode = null;
      state.dragViewSettled = false;
      if (state.cameraAnimation) {
        cancelAnimationFrame(state.cameraAnimation);
        state.cameraAnimation = null;
      }
      enterInteractiveMode(false);
      container.setPointerCapture(event.pointerId);
    });

    container.addEventListener("pointermove", (event) => {
      if (!state.dragging) return;
      const dx = event.clientX - state.dragStartX;
      const dy = event.clientY - state.dragStartY;
      if (!state.dragGesture) {
        const absX = Math.abs(dx);
        const absY = Math.abs(dy);
        if (Math.max(absX, absY) < VIEW_DRAG_DEADZONE_PX) return;
        state.dragGesture = absY > absX * 1.15 ? "vertical" : "horizontal";
      }

      if (state.dragGesture === "vertical") {
        if (state.dragViewSettled) return;
        previewVerticalViewDrag(dy);
        const targetMode = verticalDragTargetMode(dy);
        if (targetMode !== state.dragStartViewMode && Math.abs(dy) >= VIEW_DRAG_THRESHOLD_PX) {
          state.dragViewSettled = true;
          finishVerticalViewDrag(dy);
        }
        return;
      }

      if (state.viewMode === "top") {
        const path = state.meta?.flightPath || state.data?.flightPath;
        if (!path) return;
        const nextIndex = Math.max(
          0,
          Math.min(path.length - 1, state.dragStartIndex + Math.round(dx / 4)),
        );
        if (nextIndex === state.focusIndex) return;
        state.focusIndex = nextIndex;
        state.centerIndex = nextIndex;
        const scrubber = document.getElementById("scrub");
        if (scrubber) scrubber.value = state.focusIndex;
        updateSunLight(state.focusIndex);
        if (state.data) rebuildGeometry();
        window.clearTimeout(state.dragRequestTimer);
        state.dragRequestTimer = window.setTimeout(() => requestTerrain(), 90);
        scheduleIdleRefine();
        return;
      }
      state.azimuth = state.dragStartAzimuth + dx * 0.008;
      setCamera(state.viewMode);
      scheduleIdleRefine();
    });

    container.addEventListener("pointerup", (event) => {
      const dy = event.clientY - state.dragStartY;
      const wasVertical = state.dragGesture === "vertical";
      const wasSettled = state.dragViewSettled;
      state.dragging = false;
      container.releasePointerCapture(event.pointerId);
      window.clearTimeout(state.dragRequestTimer);
      if (wasVertical && !wasSettled) {
        finishVerticalViewDrag(dy);
      } else if (!wasVertical && state.viewMode === "top") {
        requestTerrain();
      }
      state.dragGesture = null;
      state.dragStartCameraTarget = null;
      state.dragViewSettled = false;
      scheduleIdleRefine();
    });

    container.addEventListener("pointercancel", () => {
      state.dragging = false;
      window.clearTimeout(state.dragRequestTimer);
      if (state.dragGesture === "vertical" && !state.dragViewSettled) {
        animateViewMode(state.dragStartViewMode, state.dragPreviewTarget || state.dragStartCameraTarget);
        setViewModeControl(state.dragStartViewMode);
      }
      state.dragGesture = null;
      state.dragStartCameraTarget = null;
      state.dragPreviewTarget = null;
      state.dragViewSettled = false;
      scheduleIdleRefine();
    });

    let wheelTimeout = 0;
    container.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        enterInteractiveMode(false);
        const factor = Math.exp(event.deltaY * 0.0012);
        state.cutoutRadius = Math.max(
          state.minCutoutRadius,
          Math.min(state.maxCutoutRadius, state.cutoutRadius * factor),
        );
        if (state.data) rebuildGeometry();
        clearTimeout(wheelTimeout);
        wheelTimeout = setTimeout(() => requestTerrain(), 120);
        scheduleIdleRefine();
      },
      { passive: false },
    );
  }

  function installScrubber() {
    if (state.scrubInstalled) return;
    const scrubber = document.getElementById("scrub");
    const path = state.meta?.flightPath || state.data?.flightPath;
    if (!scrubber || !path) return;
    scrubber.max = String(Math.max(0, path.length - 1));
    scrubber.value = String(state.focusIndex);
    if (state.scrubInstalled) return;
    state.scrubInstalled = true;
    scrubber.addEventListener("input", () => {
      enterInteractiveMode(false);
      state.focusIndex = Number(scrubber.value);
      state.centerIndex = state.focusIndex;
      updateSunLight(state.focusIndex);
      if (state.data) rebuildGeometry();
      clearTimeout(state.playTimer);
      scheduleNext();
      requestTerrain();
      scheduleIdleRefine();
    });
  }

  function setFlightLabel(label) {
    state.flightLabel = label;
    const el = document.getElementById("flight-label");
    if (el) el.textContent = label || "";
  }

  function showFlightOptions(list, flights) {
    list.replaceChildren();
    for (const flight of flights) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "flight-option";
      button.textContent = flight.label;
      button.addEventListener("click", () => selectFlight(flight.value));
      list.appendChild(button);
    }
  }

  async function loadFlightOptions(list) {
    if (state.flightOptions) {
      showFlightOptions(list, state.flightOptions);
      return;
    }
    list.textContent = "Loading flights...";
    const response = await fetch("/flights");
    if (!response.ok) throw new Error(`flights failed: ${response.status}`);
    const payload = await response.json();
    state.flightOptions = payload.flights || [];
    showFlightOptions(list, state.flightOptions);
  }

  async function selectFlight(label) {
    if (state.loadingFlight || label === state.flightLabel) return;
    state.loadingFlight = true;
    setStatus(`Loading ${label}...`);
    try {
      const response = await fetch(`/flight-payload?flight=${encodeURIComponent(label)}`);
      if (!response.ok) throw new Error(`flight payload failed: ${response.status}`);
      const payload = await response.json();
      clearTimeout(state.playTimer);
      clearTimeout(state.pendingRequest);
      state.requestSerial += 1;
      state.pendingRequest = null;
      state.activeOverlay = null;
      replaceOverlayRoot(null);
      state.meta = payload.metadata;
      state.overviewData = payload.overview;
      state.focusIndex = 0;
      state.centerIndex = 0;
      state.minCutoutRadius = state.meta.minRadius;
      state.maxCutoutRadius = state.meta.maxRadius;
      state.cutoutRadius = state.maxCutoutRadius;
      setFlightLabel(payload.label);
      installScrubber();
      const list = document.getElementById("flight-picker-list");
      if (list) list.classList.remove("open");
      const preview = overviewFor(0, state.maxCutoutRadius);
      if (preview) {
        render(preview, state.viewMode);
        scheduleNext();
      }
    } catch (error) {
      console.warn("[terrain] flight switch failed", error);
      setStatus(`Could not load ${label}`);
    } finally {
      state.loadingFlight = false;
    }
  }

  function installFlightPicker() {
    const button = document.getElementById("flight-picker-button");
    const list = document.getElementById("flight-picker-list");
    if (!button || !list) return;
    button.addEventListener("click", async () => {
      list.classList.toggle("open");
      if (!list.classList.contains("open")) return;
      try {
        await loadFlightOptions(list);
      } catch (error) {
        console.warn("[terrain] flight list failed", error);
        list.textContent = "Could not load flights";
      }
    });
  }

  function installSettingsPanel() {
    const button = document.getElementById("settings-button");
    const panel = document.getElementById("settings-panel");
    const landcover = document.getElementById("settings-landcover");
    const terrainLayer = document.getElementById("settings-terrain-layer");
    const viewMode = document.getElementById("settings-view-mode");
    if (!button || !panel) return;

    if (landcover) landcover.checked = state.showLandcover;
    if (terrainLayer) terrainLayer.value = state.terrainLayer;
    if (viewMode) viewMode.value = state.viewMode;

    button.addEventListener("click", () => {
      panel.classList.toggle("open");
    });

    landcover?.addEventListener("change", () => {
      state.showLandcover = landcover.checked;
      if (!state.showLandcover) replaceOverlayRoot(null);
      if (state.data) rebuildGeometry();
    });

    terrainLayer?.addEventListener("change", () => {
      state.terrainLayer = terrainLayer.value;
      if (state.terrainLayer !== "slope" && landcover) {
        state.showLandcover = false;
        landcover.checked = false;
        replaceOverlayRoot(null);
      }
      if (state.data) rebuildGeometry();
    });

    viewMode?.addEventListener("change", () => {
      animateViewMode(viewMode.value);
    });
  }

  function overlayCoversCurrentView(spec) {
    const center = viewCenter();
    const radius = viewRadius();
    const pad = spec.resolution * 2;
    const maxX = spec.x0 + (spec.width - 1) * spec.resolution;
    const maxY = spec.y0 + (spec.height - 1) * spec.resolution;
    return (
      center[0] - radius >= spec.x0 - pad &&
      center[0] + radius <= maxX + pad &&
      center[1] - radius >= spec.y0 - pad &&
      center[1] + radius <= maxY + pad
    );
  }

  function overlayRootFor(data, terrainGeometry, overlay) {
    const center = viewCenter();
    const geometry = terrainGeometry.clone();
    const positions = geometry.attributes.position.array;
    const uvs = new Float32Array((positions.length / 3) * 2);
    const widthM = Math.max(1, (overlay.spec.width - 1) * overlay.spec.resolution);
    const heightM = Math.max(1, (overlay.spec.height - 1) * overlay.spec.resolution);

    for (let i = 0, j = 0; i < positions.length; i += 3, j += 2) {
      const worldX = positions[i] + center[0];
      const worldY = center[1] - positions[i + 2];
      positions[i + 1] += 0.8;
      uvs[j] = (worldX - overlay.spec.x0) / widthM;
      uvs[j + 1] = (worldY - overlay.spec.y0) / heightM;
    }

    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geometry.attributes.position.needsUpdate = true;

    const material = new THREE.MeshBasicMaterial({
      map: overlay.texture,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const root = new THREE.Group();
    root.add(new THREE.Mesh(geometry, material));
    return root;
  }

  function replaceOverlayRoot(root) {
    if (state.overlayRoot) state.scene.remove(state.overlayRoot);
    state.overlayRoot = root;
    if (root) state.scene.add(root);
  }

  function addTerrainOverlay(data, terrainGeometry) {
    if (data.preview || !state.showLandcover) {
      replaceOverlayRoot(null);
      return;
    }

    if (state.activeOverlay && overlayCoversCurrentView(state.activeOverlay.spec)) {
      replaceOverlayRoot(overlayRootFor(data, terrainGeometry, state.activeOverlay));
    } else {
      replaceOverlayRoot(null);
    }

    const root = state.root;
    ensureOverlayTexture(data.terrain)
      .then((overlay) => {
        if (state.root !== root || state.data !== data || !state.showLandcover) return;
        state.activeOverlay = overlay;
        replaceOverlayRoot(overlayRootFor(data, terrainGeometry, overlay));
        setCamera(state.viewMode);
      })
      .catch((error) => {
        console.warn("[terrain] overlay texture failed", error);
      });
  }

  function buildTerrain(data) {
    console.time("[terrain] build terrain mesh");
    const terrain = data.terrain;
    const center = viewCenter();
    const radius = viewRadius();
    const baseHeight = 0;
    const stride = meshStride(terrain, radius);
    const positions = [];
    const uvs = [];
    const sampledWidth = Math.ceil(terrain.width / stride);
    const sampledHeight = Math.ceil(terrain.height / stride);
    const indexByGrid = new Int32Array(sampledWidth * sampledHeight).fill(-1);
    const uvWidth = Math.max(1, (terrain.width - 1) * terrain.dx);
    const uvHeight = Math.max(1, (terrain.height - 1) * terrain.dy);

    for (let iy = 0; iy < terrain.height; iy += stride) {
      const y = terrain.y0 + iy * terrain.dy;
      const sy = Math.floor(iy / stride);
      for (let ix = 0; ix < terrain.width; ix += stride) {
        const x = terrain.x0 + ix * terrain.dx;
        const dx = x - center[0];
        const dy = y - center[1];
        if (dx * dx + dy * dy > radius * radius) continue;

        const z = terrain.z[iy * terrain.width + ix];
        const sx = Math.floor(ix / stride);
        indexByGrid[sy * sampledWidth + sx] = positions.length / 3;
        positions.push(localX(x, center), z, localY(y, center));
        uvs.push((x - terrain.x0) / uvWidth, (y - terrain.y0) / uvHeight);
      }
    }

    const indices = [];
    for (let sy = 0; sy < sampledHeight - 1; sy += 1) {
      for (let sx = 0; sx < sampledWidth - 1; sx += 1) {
        const a = indexByGrid[sy * sampledWidth + sx];
        const b = indexByGrid[sy * sampledWidth + sx + 1];
        const c = indexByGrid[(sy + 1) * sampledWidth + sx];
        const d = indexByGrid[(sy + 1) * sampledWidth + sx + 1];
        if (a >= 0 && b >= 0 && c >= 0) indices.push(a, c, b);
        if (b >= 0 && c >= 0 && d >= 0) indices.push(b, c, d);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    geometry.setIndex(indices);
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geometry.computeVertexNormals();
    applySlopeColors(geometry);

    const textureSpec = terrainTextureSpec(terrain);
    const cachedTexture = textureSpec ? state.textureCache.get(terrainTextureKey(textureSpec)) : null;
    const material = new THREE.MeshLambertMaterial({
      map: cachedTexture || null,
      vertexColors: !cachedTexture,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    state.root.add(mesh);
    applyTerrainTexture(data, material, state.root, state.terrainLayer);
    addTerrainOverlay(data, geometry);

    buildEdgeFill(data);
    buildContourLines(data);
    buildCylinderWall(data, baseHeight);
    console.timeEnd("[terrain] build terrain mesh");
    console.log("[terrain] terrain mesh ready", {
      vertices: positions.length / 3,
      triangles: indices.length / 3,
      stride,
    });
  }

  function buildEdgeFill(data) {
    console.time("[terrain] build edge fill");
    const terrain = data.terrain;
    const center = viewCenter();
    const radius = viewRadius();
    const effectiveSpacing = Math.max(terrain.dx, terrain.dy) * meshStride(terrain, radius);
    const innerRadius = Math.max(
      1,
      radius - Math.max(effectiveSpacing * 4.5, Math.max(terrain.dx, terrain.dy) * 3),
    );
    const segments = 256;
    const rings = 6;
    const positions = [];
    const indices = [];

    for (let i = 0; i <= segments; i += 1) {
      const angle = (i / segments) * Math.PI * 2;
      for (let ring = 0; ring < rings; ring += 1) {
        const t = ring / (rings - 1);
        const r = THREE.MathUtils.lerp(innerRadius, radius, t);
        const x = center[0] + Math.cos(angle) * r;
        const y = center[1] + Math.sin(angle) * r;
        const z = sampleHeight(terrain, x, y);
        positions.push(localX(x, center), z + 0.08, localY(y, center));
      }
    }

    for (let i = 0; i < segments; i += 1) {
      const row0 = i * rings;
      const row1 = (i + 1) * rings;
      for (let ring = 0; ring < rings - 1; ring += 1) {
        const inner0 = row0 + ring;
        const outer0 = inner0 + 1;
        const inner1 = row1 + ring;
        const outer1 = inner1 + 1;
        indices.push(inner0, outer0, inner1, inner1, outer0, outer1);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    applySlopeColors(geometry);
    const material = new THREE.MeshLambertMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    state.root.add(mesh);
    console.timeEnd("[terrain] build edge fill");
  }

  function contourPoint(x, y, level, center) {
    return [localX(x, center), level + CONTOUR_LIFT_M, localY(y, center)];
  }

  function maybeContourEdge(points, level, a, b, ax, ay, bx, by, center) {
    if (a === b) return;
    const crosses = (a < level && b >= level) || (b < level && a >= level);
    if (!crosses) return;
    const t = (level - a) / (b - a);
    points.push(contourPoint(ax + (bx - ax) * t, ay + (by - ay) * t, level, center));
  }

  function buildContourLines(data) {
    if (state.qualityMode === "interactive") return;
    console.time("[terrain] build contour lines");
    const terrain = data.terrain;
    const center = viewCenter();
    const radius = viewRadius();
    const stride = meshStride(terrain, radius);
    const minLevel = Math.ceil(terrain.zMin / CONTOUR_INTERVAL_M) * CONTOUR_INTERVAL_M;
    const maxLevel = Math.floor(terrain.zMax / CONTOUR_INTERVAL_M) * CONTOUR_INTERVAL_M;
    const positions = [];

    for (let level = minLevel; level <= maxLevel; level += CONTOUR_INTERVAL_M) {
      for (let iy = 0; iy < terrain.height - stride; iy += stride) {
        const y0 = terrain.y0 + iy * terrain.dy;
        const y1 = terrain.y0 + (iy + stride) * terrain.dy;
        for (let ix = 0; ix < terrain.width - stride; ix += stride) {
          const x0 = terrain.x0 + ix * terrain.dx;
          const x1 = terrain.x0 + (ix + stride) * terrain.dx;
          const cx = (x0 + x1) / 2;
          const cy = (y0 + y1) / 2;
          const dx = cx - center[0];
          const dy = cy - center[1];
          if (dx * dx + dy * dy > radius * radius) continue;

          const z00 = terrain.z[iy * terrain.width + ix];
          const z10 = terrain.z[iy * terrain.width + ix + stride];
          const z01 = terrain.z[(iy + stride) * terrain.width + ix];
          const z11 = terrain.z[(iy + stride) * terrain.width + ix + stride];
          const cellMin = Math.min(z00, z10, z01, z11);
          const cellMax = Math.max(z00, z10, z01, z11);
          if (level < cellMin || level > cellMax) continue;

          const points = [];
          maybeContourEdge(points, level, z00, z10, x0, y0, x1, y0, center);
          maybeContourEdge(points, level, z10, z11, x1, y0, x1, y1, center);
          maybeContourEdge(points, level, z01, z11, x0, y1, x1, y1, center);
          maybeContourEdge(points, level, z00, z01, x0, y0, x0, y1, center);

          if (points.length === 2) {
            positions.push(...points[0], ...points[1]);
          } else if (points.length === 4) {
            positions.push(...points[0], ...points[1], ...points[2], ...points[3]);
          }
        }
      }
    }

    if (positions.length === 0) {
      console.timeEnd("[terrain] build contour lines");
      return;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({
      color: COLORS.contour,
      transparent: true,
      opacity: CONTOUR_OPACITY,
      depthWrite: false,
    });
    const lines = new THREE.LineSegments(geometry, material);
    lines.renderOrder = 2;
    state.root.add(lines);
    console.timeEnd("[terrain] build contour lines");
  }

  function buildCylinderWall(data, baseHeight) {
    console.time("[terrain] build cylinder wall");
    const terrain = data.terrain;
    const center = viewCenter();
    const radius = viewRadius();
    const segments = 192;
    const positions = [];
    const colors = [];
    const uvs = [];
    const indices = [];
    const repeatU = Math.max(8, Math.round((2 * Math.PI * radius) / 350));

    for (let i = 0; i <= segments; i += 1) {
      const angle = (i / segments) * Math.PI * 2;
      const x = center[0] + Math.cos(angle) * radius;
      const y = center[1] + Math.sin(angle) * radius;
      const z = sampleHeight(terrain, x, y);
      positions.push(localX(x, center), z, localY(y, center));
      positions.push(localX(x, center), baseHeight, localY(y, center));
      colors.push(...COLORS.wallTop, ...COLORS.wallBottom);
      uvs.push((i / segments) * repeatU, (z - baseHeight) / 280);
      uvs.push((i / segments) * repeatU, 0);
    }

    for (let i = 0; i < segments; i += 1) {
      const top0 = i * 2;
      const bottom0 = top0 + 1;
      const top1 = top0 + 2;
      const bottom1 = top0 + 3;
      indices.push(top0, bottom0, top1, top1, bottom0, bottom1);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const material = new THREE.MeshLambertMaterial({
      map: wallGrainTexture(),
      vertexColors: true,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    state.root.add(mesh);

    // Soft blurred shadow disc under cylinder (canvas radial gradient)
    const shadowSize = 512;
    const shadowCanvas = document.createElement("canvas");
    shadowCanvas.width = shadowSize;
    shadowCanvas.height = shadowSize;
    const shadowCtx = shadowCanvas.getContext("2d");
    const grad = shadowCtx.createRadialGradient(
      shadowSize / 2,
      shadowSize / 2,
      0,
      shadowSize / 2,
      shadowSize / 2,
      shadowSize / 2,
    );
    grad.addColorStop(0, "rgba(0,0,0,0.5)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    shadowCtx.fillStyle = grad;
    shadowCtx.fillRect(0, 0, shadowSize, shadowSize);
    const shadowTexture = new THREE.CanvasTexture(shadowCanvas);
    const shadowGeo = new THREE.PlaneGeometry(
      radius * 2 * 0.92,
      radius * 2 * 0.92,
    );
    const shadowMat = new THREE.MeshBasicMaterial({
      map: shadowTexture,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const shadowMesh = new THREE.Mesh(shadowGeo, shadowMat);
    shadowMesh.rotation.x = -Math.PI / 2;
    shadowMesh.position.set(0, baseHeight - Math.max(2, radius * 0.25), 0);
    state.root.add(shadowMesh);

    console.timeEnd("[terrain] build cylinder wall");
  }

  function buildLine(points, color, width, opacity) {
    const material = new THREE.LineBasicMaterial({ color, linewidth: width });
    if (opacity !== undefined) {
      material.transparent = true;
      material.opacity = opacity;
    }
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    return new THREE.Line(geometry, material);
  }

  function updateCurrentMarker(render = true) {
    if (!state.currentMarker || !state.data) return false;
    const center = viewCenter();
    const radius = viewRadius();
    const focusPoint =
      state.data.flightPath[Math.min(state.focusIndex, state.data.flightPath.length - 1)];
    const dx = focusPoint[0] - center[0];
    const dy = focusPoint[1] - center[1];
    state.currentMarker.visible = dx * dx + dy * dy <= radius * radius;
    state.currentMarker.position.set(
      localX(focusPoint[0], center),
      focusPoint[2] + 54,
      localY(focusPoint[1], center),
    );
    if (render && state.renderer && state.scene && state.camera) {
      state.renderer.render(state.scene, state.camera);
    }
    updateInfoPanel();
    return true;
  }

  function buildOverlays(data) {
    console.time("[terrain] build overlays");
    const center = viewCenter();
    const terrain = data.terrain;
    const circleRadius = viewRadius();
    const topLift = 26;

    // Flight path: split into segments inside cylinder, dark with 67% opacity
    const pathSegments = [];
    let currentSegment = [];
    for (const point of data.flightPath) {
      const dx = point[0] - center[0];
      const dy = point[1] - center[1];
      if (dx * dx + dy * dy <= circleRadius * circleRadius) {
        currentSegment.push(
          new THREE.Vector3(
            localX(point[0], center),
            point[2] + topLift,
            localY(point[1], center),
          ),
        );
      } else {
        if (currentSegment.length > 1) pathSegments.push(currentSegment);
        currentSegment = [];
      }
    }
    if (currentSegment.length > 1) pathSegments.push(currentSegment);
    for (const seg of pathSegments) {
      if (seg.length < 2) continue;
      const curve = new THREE.CatmullRomCurve3(seg);
      const tubeGeo = new THREE.TubeGeometry(
        curve,
        seg.length * 2,
        Math.max(1.2, circleRadius * 0.003),
        6,
        false,
      );
      state.root.add(
        new THREE.Mesh(
          tubeGeo,
          new THREE.MeshBasicMaterial({
            color: COLORS.path,
            transparent: true,
            opacity: 0.85,
          }),
        ),
      );
    }

    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(Math.max(18, circleRadius * 0.018), 24, 12),
      new THREE.MeshBasicMaterial({ color: COLORS.marker }),
    );
    state.currentMarker = marker;
    state.root.add(marker);
    updateCurrentMarker(false);

    const rim = [];
    for (let i = 0; i <= 192; i += 1) {
      const angle = (i / 192) * Math.PI * 2;
      const x = center[0] + Math.cos(angle) * circleRadius;
      const y = center[1] + Math.sin(angle) * circleRadius;
      rim.push(
        new THREE.Vector3(
          localX(x, center),
          sampleHeight(terrain, x, y) + 18,
          localY(y, center),
        ),
      );
    }
    state.root.add(buildLine(rim, COLORS.rim, 1));

    const start = mapAngleFromAzimuth(data.sun.startAzimuth);
    let end = mapAngleFromAzimuth(data.sun.endAzimuth);
    while (end - start > Math.PI) end -= Math.PI * 2;
    while (end - start < -Math.PI) end += Math.PI * 2;

    const arc = [];
    const arcRadius = circleRadius * 1.065;
    const arcHeight = circleRadius * 1.5; //terrain.zMax + 120;
    for (let i = 0; i <= 80; i += 1) {
      const angle = start + (end - start) * (i / 80);
      const x = Math.cos(angle) * arcRadius;
      const y = -Math.sin(angle) * arcRadius;
      arc.push(new THREE.Vector3(x, arcHeight, y));
    }
    const arcCurve = new THREE.CatmullRomCurve3(arc);
    const arcGeo = new THREE.TubeGeometry(
      arcCurve,
      80,
      Math.max(2.5, circleRadius * 0.008),
      6,
      false,
    );
    state.root.add(
      new THREE.Mesh(
        arcGeo,
        new THREE.MeshBasicMaterial({
          color: 0xf59e0b,
          transparent: true,
          opacity: 0.35,
        }),
      ),
    );
    console.timeEnd("[terrain] build overlays");
  }

  function updateSunLight(index) {
    if (!state.directionalLight) return;
    const directions = state.meta?.sunDirections;
    const mean = state.meta?.meanSunDirection;
    const dir = (directions && directions[index]) || mean;
    if (!dir) return;
    state.directionalLight.position.set(dir[0], dir[2], -dir[1]);
    state.directionalLight.target.position.set(0, 0, 0);
    state.directionalLight.shadow.camera.lookAt(0, 0, 0);
  }

  function scheduleNext() {
    const secs = state.meta?.timeSeconds;
    if (!secs || state.focusIndex >= secs.length - 1) return;
    const dt = (secs[state.focusIndex + 1] - secs[state.focusIndex]) * 1000;
    clearTimeout(state.playTimer);
    state.playTimer = setTimeout(() => {
      state.focusIndex++;
      const scrubber = document.getElementById("scrub");
      if (scrubber) scrubber.value = state.focusIndex;
      updateSunLight(state.focusIndex);
      if (state.data && !updateCurrentMarker()) rebuildGeometry();
      setStatus(
        `${state.data?.preview ? "Preview" : "Cutout"} ${Math.round(viewRadius())} m · point ${state.focusIndex + 1}/${state.meta.flightPath.length}`,
      );
      scheduleNext();
    }, dt);
  }

  function cameraTargetFor(viewMode) {
    const container = document.getElementById("terrain-viewer");
    if (!container || !state.data) return null;

    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    const radius = viewRadius();
    const terrain = state.data.terrain;
    const aspect = width / height;
    const frustum = radius * 2;
    const lookAtY = frustum / 4;
    const directionX = Math.cos(state.azimuth);
    const directionZ = Math.sin(state.azimuth);
    let position;
    let up;
    const lookAt = new THREE.Vector3(0, lookAtY, 0);
    if (viewMode === "isometric") {
      const distance = radius * 1.55;
      const distY =
        terrain.zMax + radius * 1.15 - (terrain.zMin + terrain.zMax) / 2;
      position = new THREE.Vector3(
        directionX * distance,
        lookAtY + distY,
        directionZ * distance,
      );
      up = new THREE.Vector3(0, 1, 0);
    } else {
      const distY =
        terrain.zMax + radius * 2.2 - (terrain.zMin + terrain.zMax) / 2;
      position = new THREE.Vector3(0, lookAtY + distY, 0.001);
      up = new THREE.Vector3(0, 0, -1);
    }

    return {
      width,
      height,
      radius,
      terrain,
      left: (-frustum * aspect) / 2,
      right: (frustum * aspect) / 2,
      top: frustum / 2,
      bottom: -frustum / 2,
      near: -10000,
      far: 50000,
      position,
      up,
      lookAt,
      viewMode,
    };
  }

  function applyCameraTarget(target) {
    if (!target || !state.camera || !state.renderer || !state.directionalLight) return;
    state.camera.left = target.left;
    state.camera.right = target.right;
    state.camera.top = target.top;
    state.camera.bottom = target.bottom;
    state.camera.near = target.near;
    state.camera.far = target.far;
    state.camera.position.copy(target.position);
    state.camera.up.copy(target.up);
    state.camera.lookAt(target.lookAt);
    state.camera.updateProjectionMatrix();

    // Shadow camera frustum covers the visible terrain circle
    const shadowCam = state.directionalLight.shadow.camera;
    const pad = target.radius * 0.1;
    shadowCam.left = -target.radius - pad;
    shadowCam.right = target.radius + pad;
    shadowCam.top = target.radius + pad;
    shadowCam.bottom = -target.radius - pad;
    shadowCam.near = Math.min(target.terrain.zMin - 500, -500);
    shadowCam.far = target.terrain.zMax + 500;
    shadowCam.updateProjectionMatrix();

    state.renderer.setSize(target.width, target.height, false);
    state.renderer.render(state.scene, state.camera);
    updateScaleBar(target.width);
  }

  function setCamera(viewMode) {
    if (!state.camera || !state.renderer || !state.data) return;
    const target = cameraTargetFor(viewMode);
    applyCameraTarget(target);
    console.log("[terrain] rendered frame", { viewMode, width: target?.width, height: target?.height });
  }

  function blendCameraTargets(start, end, t) {
    return {
      ...end,
      left: THREE.MathUtils.lerp(start.left, end.left, t),
      right: THREE.MathUtils.lerp(start.right, end.right, t),
      top: THREE.MathUtils.lerp(start.top, end.top, t),
      bottom: THREE.MathUtils.lerp(start.bottom, end.bottom, t),
      position: start.position.clone().lerp(end.position, t),
      up: start.up.clone().lerp(end.up, t).normalize(),
      lookAt: start.lookAt.clone().lerp(end.lookAt, t),
    };
  }

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function animateViewMode(viewMode, startTarget = null) {
    if (!state.camera || !state.renderer || !state.data) {
      state.viewMode = viewMode;
      return;
    }
    const fromMode = state.viewMode;
    const start = startTarget || cameraTargetFor(fromMode);
    if (fromMode === "top" && viewMode === "isometric") {
      state.azimuth = Math.PI / 2;
    }
    state.viewMode = viewMode;
    const end = cameraTargetFor(viewMode);
    if (!start || !end) return;
    if (state.cameraAnimation) cancelAnimationFrame(state.cameraAnimation);

    const startedAt = performance.now();
    const duration = 450;
    const frame = (now) => {
      const t = easeInOutCubic(Math.min(1, (now - startedAt) / duration));
      applyCameraTarget(blendCameraTargets(start, end, t));
      if (t < 1) {
        state.cameraAnimation = requestAnimationFrame(frame);
      } else {
        state.cameraAnimation = null;
        setCamera(state.viewMode);
      }
    };
    state.cameraAnimation = requestAnimationFrame(frame);
  }

  function setViewModeControl(viewMode) {
    const select = document.getElementById("settings-view-mode");
    if (select) select.value = viewMode;
  }

  function verticalDragTargetMode(dy) {
    if (state.dragStartViewMode === "isometric" && dy > 0) return "top";
    if (state.dragStartViewMode === "top" && dy < 0) return "isometric";
    return state.dragStartViewMode;
  }

  function viewDragPreviewProgress(dy) {
    const raw = Math.abs(dy) / VIEW_DRAG_THRESHOLD_PX;
    if (raw < 1) return Math.min(0.42, Math.pow(raw, 0.8) * 0.42);
    return Math.min(0.82, 0.55 + (raw - 1) * 0.12);
  }

  function previewVerticalViewDrag(dy) {
    const targetMode = verticalDragTargetMode(dy);
    state.dragTargetViewMode = targetMode;
    if (targetMode === state.dragStartViewMode) {
      state.dragPreviewTarget = state.dragStartCameraTarget;
      applyCameraTarget(state.dragStartCameraTarget);
      return;
    }
    const savedAzimuth = state.azimuth;
    if (state.dragStartViewMode === "top" && targetMode === "isometric") {
      state.azimuth = Math.PI / 2;
    }
    const end = cameraTargetFor(targetMode);
    state.azimuth = savedAzimuth;
    if (!state.dragStartCameraTarget || !end) return;
    const progress = viewDragPreviewProgress(dy);
    state.dragPreviewTarget = blendCameraTargets(state.dragStartCameraTarget, end, progress);
    applyCameraTarget(state.dragPreviewTarget);
  }

  function finishVerticalViewDrag(dy) {
    const targetMode = verticalDragTargetMode(dy);
    const shouldSwitch = targetMode !== state.dragStartViewMode && Math.abs(dy) >= VIEW_DRAG_THRESHOLD_PX;
    if (shouldSwitch && state.dragStartViewMode === "top" && targetMode === "isometric") {
      state.azimuth = Math.PI / 2;
    }
    const finalMode = shouldSwitch ? targetMode : state.dragStartViewMode;
    animateViewMode(finalMode, state.dragPreviewTarget || state.dragStartCameraTarget);
    setViewModeControl(finalMode);
    state.dragPreviewTarget = null;
    state.dragTargetViewMode = null;
  }

  function updateScaleBar(width) {
    const bar = document.getElementById("scale-bar");
    if (!bar || !state.camera) return;

    const frustumWidth = state.camera.right - state.camera.left;
    const pixels = (1000 / frustumWidth) * width;
    bar.style.width = `${Math.max(8, Math.round(pixels))}px`;
  }

  function rebuildGeometry() {
    if (!state.scene || !state.data) return;
    useOverviewIfCurrentTerrainIsTooSmall();
    const start = performance.now();
    if (state.root) {
      state.scene.remove(state.root);
    }
    state.currentMarker = null;
    state.root = new THREE.Group();
    state.scene.add(state.root);

    buildTerrain(state.data);
    buildOverlays(state.data);
    setCamera(state.viewMode);
    const label = state.data.preview ? "Preview" : "Cutout";
    const radius = viewRadius();
    setStatus(
      `${label} ${Math.round(radius)} m · point ${state.focusIndex + 1}/${state.data.flightPath.length}`,
    );
    updateInfoPanel();
    const totalMs = performance.now() - start;
    console.log("[terrain] rebuild geometry timing", {
      preview: !!state.data.preview,
      totalMs: Math.round(totalMs),
      grid: `${state.data.terrain.width}x${state.data.terrain.height}`,
      radius: Math.round(radius),
      resolution: state.data.resolution,
      qualityMode: state.qualityMode,
    });
  }

  function showTerrainData(data, viewMode) {
    if (!state.scene || !state.renderer || !state.camera) {
      render(data, viewMode);
      return;
    }

    state.data = data;
    state.viewMode = viewMode;
    state.focusIndex = data.focusIndex ?? state.focusIndex;
    state.centerIndex = data.centerIndex ?? state.centerIndex;
    state.maxCutoutRadius = data.maxRadius ?? state.maxCutoutRadius;
    state.minCutoutRadius = data.minRadius ?? state.minCutoutRadius;
    state.cutoutRadius = data.circle.radius;
    updateSunLight(state.focusIndex);
    rebuildGeometry();
  }

  function requestTerrain() {
    if (!state.meta) return;
    const radius = Math.max(
      state.minCutoutRadius,
      Math.min(state.maxCutoutRadius, state.cutoutRadius),
    );
    const index = Math.max(
      0,
      Math.min(state.meta.flightPath.length - 1, state.focusIndex),
    );
    const centerIndex = Math.max(
      0,
      Math.min(state.meta.flightPath.length - 1, state.centerIndex),
    );
    const centerPoint = state.meta.flightPath[centerIndex];
    const center = clampedCenterFor(centerPoint, radius);
    const circle = { center, radius };
    const lod = lodForRadius(radius);
    const resolution = lod.resolution;
    const tiles = neededTiles(center, radius, lod);
    const missingTiles = tiles.filter(
      (tile) => !state.tileCache.has(tileKey(tile)),
    );
    const serial = ++state.requestSerial;

    // Show overview immediately if no tiles available yet
    const availableTiles = tiles.filter((tile) =>
      state.tileCache.has(tileKey(tile)),
    );
    if (availableTiles.length === 0 && !state.data) {
      const preview = overviewFor(centerIndex, radius);
      if (preview) {
        showTerrainData(preview, state.viewMode);
        setStatus(`Preview while loading ${tiles.length} terrain tiles...`);
      }
    }

    if (missingTiles.length === 0) {
      if (availableTiles.length > 0) {
        showTerrainData(
          assembleTerrainFromTiles(availableTiles, circle, index, centerIndex, resolution),
          state.viewMode,
        );
      }
      return;
    }

    window.clearTimeout(state.pendingRequest);
    state.pendingRequest = setTimeout(async () => {
      if (serial !== state.requestSerial) return;

      setStatus(
        `Loading ${missingTiles.length}/${tiles.length} terrain tiles (${lod.tileSize / 1000} km @ ${resolution} m)...`,
      );

      const promises = missingTiles.map((tile) =>
        ensureTile(tile).catch(() => {}),
      );
      await Promise.allSettled(promises);
      if (serial === state.requestSerial) {
        const updatedTiles = tiles.filter((tile) =>
          state.tileCache.has(tileKey(tile)),
        );
        if (updatedTiles.length > 0) {
          showTerrainData(
            assembleTerrainFromTiles(updatedTiles, circle, index, centerIndex, resolution),
            state.viewMode,
          );
        }
      }

      console.log("[terrain] tile requests started", {
        missingTiles: missingTiles.length,
        totalTiles: tiles.length,
        tileSize: lod.tileSize,
        resolution,
      });
    }, 0);
  }

  function render(data, viewMode) {
    const container = document.getElementById("terrain-viewer");
    console.log("[terrain] render called", {
      hasData: !!data,
      viewMode,
      hasContainer: !!container,
      hasThree: !!window.THREE,
    });
    if (!container) {
      console.warn("[terrain] terrain-viewer container is missing");
      return;
    }

    if (!window.THREE) {
      setStatus("Waiting for Three.js...");
      console.warn("[terrain] THREE is not loaded yet; retrying shortly");
      window.clearTimeout(state.pendingRetry);
      state.pendingRetry = window.setTimeout(() => render(data, viewMode), 250);
      return;
    }

    if (!data) {
      container.replaceChildren();
      setStatus("No terrain loaded");
      return;
    }

    setStatus("Building WebGL terrain...");
    console.log("[terrain] payload", {
      grid: `${data.terrain.width}x${data.terrain.height}`,
      zCount: data.terrain.z.length,
      flightPath: data.flightPath.length,
      circleRadius: data.circle.radius,
    });

    resetScene(container);
    installDrag(container);
    state.data = data;
    state.viewMode = viewMode;
    state.focusIndex = data.focusIndex ?? state.focusIndex;
    state.centerIndex = data.centerIndex ?? state.centerIndex;
    state.maxCutoutRadius = data.maxRadius ?? state.maxCutoutRadius;
    state.minCutoutRadius = data.minRadius ?? state.minCutoutRadius;
    state.cutoutRadius = data.circle.radius;
    state.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10000, 50000);
    installScrubber();

    updateSunLight(state.focusIndex);
    rebuildGeometry();
    setStatus(
      viewMode === "isometric"
        ? "Isometric WebGL terrain"
        : "Top-down WebGL terrain",
    );
  }

  window.renderTerrainViewer = render;
  window.addEventListener("resize", () => {
    if (state.data) setCamera(state.viewMode);
  });
  window.addEventListener("DOMContentLoaded", () => {
    if (window.TERRAIN_META) {
      state.meta = window.TERRAIN_META;
      state.overviewData = window.TERRAIN_OVERVIEW || null;
      state.viewMode = window.TERRAIN_VIEW_MODE || "isometric";
      setFlightLabel(window.TERRAIN_FLIGHT_LABEL || "");
      state.minCutoutRadius = state.meta.minRadius;
      state.maxCutoutRadius = state.meta.maxRadius;
      state.cutoutRadius = state.maxCutoutRadius;
      state.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10000, 50000);
      installFlightPicker();
      installSettingsPanel();
      installScrubber();
      // Show overview immediately so first interaction is instant
      const preview = overviewFor(0, state.maxCutoutRadius);
      if (preview) {
        render(preview, state.viewMode);
        scheduleNext();
      }
    } else {
      setStatus("No embedded terrain metadata");
    }
  });
})();
