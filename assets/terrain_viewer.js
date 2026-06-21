(() => {
  console.log("[terrain] terrain_viewer.js loaded");

  const state = {
    renderer: null,
    scene: null,
    camera: null,
    root: null,
    data: null,
    meta: null,
    overviewData: null,
    pendingRetry: null,
    pendingRequest: null,
    abortController: null,
    requestSerial: 0,
    terrainCache: new Map(),
    tileCache: new Map(),
    azimuth: Math.PI / 4,
    dragging: false,
    dragStartX: 0,
    dragStartAzimuth: 0,
    viewMode: "isometric",
    dragInstalled: false,
    scrubInstalled: false,
    focusIndex: 0,
    cutoutRadius: 1200,
    minCutoutRadius: 450,
    maxCutoutRadius: 1200,
  };

  const SHADE_LIGHT = new THREE.Vector3(-0.45, 0.72, -0.52).normalize();
  const TILE_SIZE = 1000;

  function setStatus(message) {
    const status = document.getElementById("terrain-status");
    if (status) status.textContent = message;
    console.log(`[terrain] ${message}`);
  }

  function mapAngleFromAzimuth(azimuth) {
    return -(azimuth + Math.PI / 2);
  }

  function colorForNormal(normal) {
    const exposure = Math.max(0, normal.dot(SHADE_LIGHT));
    const shade = 0.26 + exposure * 0.74;
    return new THREE.Color(0x8ca071).multiplyScalar(shade);
  }

  function terrainNormalAt(terrain, ix, iy) {
    const x0 = Math.max(0, ix - 1);
    const x1 = Math.min(terrain.width - 1, ix + 1);
    const y0 = Math.max(0, iy - 1);
    const y1 = Math.min(terrain.height - 1, iy + 1);
    const dzdx = (terrain.z[iy * terrain.width + x1] - terrain.z[iy * terrain.width + x0]) / Math.max(terrain.dx, (x1 - x0) * terrain.dx);
    const dzdy = (terrain.z[y1 * terrain.width + ix] - terrain.z[y0 * terrain.width + ix]) / Math.max(terrain.dy, (y1 - y0) * terrain.dy);
    return new THREE.Vector3(-dzdx, 1, dzdy).normalize();
  }

  function terrainNormalAtPoint(terrain, x, y) {
    const step = Math.max(terrain.dx, terrain.dy);
    const dzdx = (sampleHeight(terrain, x + step, y) - sampleHeight(terrain, x - step, y)) / (2 * step);
    const dzdy = (sampleHeight(terrain, x, y + step) - sampleHeight(terrain, x, y - step)) / (2 * step);
    return new THREE.Vector3(-dzdx, 1, dzdy).normalize();
  }

  function localX(x, center) {
    return x - center[0];
  }

  function localY(y, center) {
    return -(y - center[1]);
  }

  function viewCenter() {
    return state.data.circle.center;
  }

  function viewRadius() {
    return Math.max(state.minCutoutRadius, Math.min(state.maxCutoutRadius, state.cutoutRadius));
  }

  function clampedCenterFor(point, radius) {
    const full = state.meta.fullCircle;
    const fullCenter = full.center;
    const maxDistance = Math.max(0, full.radius - radius);
    const dx = point[0] - fullCenter[0];
    const dy = point[1] - fullCenter[1];
    const distance = Math.hypot(dx, dy);
    if (distance <= maxDistance || distance === 0) return [point[0], point[1]];
    return [fullCenter[0] + dx / distance * maxDistance, fullCenter[1] + dy / distance * maxDistance];
  }

  function overviewFor(index, radius) {
    if (!state.overviewData || !state.meta) return null;
    const point = state.meta.flightPath[Math.max(0, Math.min(state.meta.flightPath.length - 1, index))];
    return {
      ...state.overviewData,
      circle: {
        center: clampedCenterFor(point, radius),
        radius,
      },
      fullCircle: state.meta.fullCircle,
      flightPath: state.meta.flightPath,
      focusIndex: index,
      minRadius: state.minCutoutRadius,
      maxRadius: state.maxCutoutRadius,
      resolution: state.overviewData.resolution,
      preview: true,
    };
  }

  function resolutionForRadius(radius) {
    if (radius >= 6000) return 25;
    if (radius >= 3000) return 15;
    return 5;
  }

  function tileKey(tile) {
    return `${tile.resolution}:${tile.x0}:${tile.y0}`;
  }

  function tileIntersectsCircle(x0, y0, center, radius) {
    const nearestX = Math.max(x0, Math.min(center[0], x0 + TILE_SIZE));
    const nearestY = Math.max(y0, Math.min(center[1], y0 + TILE_SIZE));
    const dx = nearestX - center[0];
    const dy = nearestY - center[1];
    return dx * dx + dy * dy <= radius * radius;
  }

  function neededTiles(center, radius, resolution) {
    const tiles = [];
    const minX = Math.floor((center[0] - radius) / TILE_SIZE) * TILE_SIZE;
    const maxX = Math.floor((center[0] + radius) / TILE_SIZE) * TILE_SIZE;
    const minY = Math.floor((center[1] - radius) / TILE_SIZE) * TILE_SIZE;
    const maxY = Math.floor((center[1] + radius) / TILE_SIZE) * TILE_SIZE;
    for (let x0 = minX; x0 <= maxX; x0 += TILE_SIZE) {
      for (let y0 = minY; y0 <= maxY; y0 += TILE_SIZE) {
        if (tileIntersectsCircle(x0, y0, center, radius)) {
          tiles.push({ x0, y0, resolution });
        }
      }
    }
    return tiles;
  }

  function assembleTerrainFromTiles(tiles, circle, focusIndex, resolution) {
    const tilePayloads = tiles.map((tile) => state.tileCache.get(tileKey(tile)).tile);
    const minX = Math.min(...tilePayloads.map((tile) => tile.x0));
    const minY = Math.min(...tilePayloads.map((tile) => tile.y0));
    const maxX = Math.max(...tilePayloads.map((tile) => tile.x0 + tile.size));
    const maxY = Math.max(...tilePayloads.map((tile) => tile.y0 + tile.size));
    const width = Math.round((maxX - minX) / resolution) + 1;
    const height = Math.round((maxY - minY) / resolution) + 1;
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
      resolution,
      minRadius: state.minCutoutRadius,
      maxRadius: state.maxCutoutRadius,
    };
  }

  function sampleHeight(terrain, x, y) {
    const gx = Math.max(0, Math.min(terrain.width - 1, (x - terrain.x0) / terrain.dx));
    const gy = Math.max(0, Math.min(terrain.height - 1, (y - terrain.y0) / terrain.dy));
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
    return z00 * (1 - tx) * (1 - ty) + z10 * tx * (1 - ty) + z01 * (1 - tx) * ty + z11 * tx * ty;
  }

  function resetScene(container) {
    console.log("[terrain] reset scene", { width: container.clientWidth, height: container.clientHeight });
    if (state.renderer) {
      state.renderer.dispose();
      container.replaceChildren();
    }

    state.scene = new THREE.Scene();
    state.scene.background = new THREE.Color(0x0b1020);
    state.renderer = new THREE.WebGLRenderer({ antialias: true });
    state.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    container.appendChild(state.renderer.domElement);

    const ambient = new THREE.AmbientLight(0xffffff, 0.74);
    const directional = new THREE.DirectionalLight(0xfff1c2, 1.4);
    directional.position.set(-0.7, 0.45, 1.0);
    state.scene.add(ambient, directional);
  }

  function installDrag(container) {
    if (state.dragInstalled) return;
    state.dragInstalled = true;

    container.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      state.dragging = true;
      state.dragStartX = event.clientX;
      state.dragStartAzimuth = state.azimuth;
      container.setPointerCapture(event.pointerId);
    });

    container.addEventListener("pointermove", (event) => {
      if (!state.dragging) return;
      const dx = event.clientX - state.dragStartX;
      state.azimuth = state.dragStartAzimuth - dx * 0.008;
      setCamera(state.viewMode);
    });

    container.addEventListener("pointerup", (event) => {
      state.dragging = false;
      container.releasePointerCapture(event.pointerId);
    });

    container.addEventListener("pointercancel", () => {
      state.dragging = false;
    });

    container.addEventListener("wheel", (event) => {
      event.preventDefault();
      const factor = Math.exp(event.deltaY * 0.0012);
      state.cutoutRadius = Math.max(state.minCutoutRadius, Math.min(state.maxCutoutRadius, state.cutoutRadius * factor));
      requestTerrain();
    }, { passive: false });
  }

  function installScrubber() {
    if (state.scrubInstalled) return;
    const scrubber = document.getElementById("scrub");
    const path = state.meta?.flightPath || state.data?.flightPath;
    if (!scrubber || !path) return;
    state.scrubInstalled = true;
    scrubber.max = String(Math.max(0, path.length - 1));
    scrubber.value = String(state.focusIndex);
    scrubber.addEventListener("input", () => {
      state.focusIndex = Number(scrubber.value);
      requestTerrain();
    });
  }

  function buildTerrain(data) {
    console.time("[terrain] build terrain mesh");
    const terrain = data.terrain;
    const center = viewCenter();
    const radius = viewRadius();
    const baseHeight = terrain.zMin - Math.max(100, (terrain.zMax - terrain.zMin) * 0.14);
    const positions = [];
    const colors = [];
    const indexByGrid = new Int32Array(terrain.width * terrain.height).fill(-1);

    for (let iy = 0; iy < terrain.height; iy += 1) {
      const y = terrain.y0 + iy * terrain.dy;
      for (let ix = 0; ix < terrain.width; ix += 1) {
        const x = terrain.x0 + ix * terrain.dx;
        const dx = x - center[0];
        const dy = y - center[1];
        if (dx * dx + dy * dy > radius * radius) continue;

        const z = terrain.z[iy * terrain.width + ix];
        indexByGrid[iy * terrain.width + ix] = positions.length / 3;
        positions.push(localX(x, center), z, localY(y, center));
        const color = colorForNormal(terrainNormalAt(terrain, ix, iy));
        colors.push(color.r, color.g, color.b);
      }
    }

    const indices = [];
    for (let iy = 0; iy < terrain.height - 1; iy += 1) {
      for (let ix = 0; ix < terrain.width - 1; ix += 1) {
        const a = indexByGrid[iy * terrain.width + ix];
        const b = indexByGrid[iy * terrain.width + ix + 1];
        const c = indexByGrid[(iy + 1) * terrain.width + ix];
        const d = indexByGrid[(iy + 1) * terrain.width + ix + 1];
        if (a >= 0 && b >= 0 && c >= 0) indices.push(a, c, b);
        if (b >= 0 && c >= 0 && d >= 0) indices.push(b, c, d);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    state.root.add(new THREE.Mesh(geometry, material));

    buildEdgeFill(data);
    buildCylinderWall(data, baseHeight);
    console.timeEnd("[terrain] build terrain mesh");
    console.log("[terrain] terrain mesh ready", { vertices: positions.length / 3, triangles: indices.length / 3 });
  }

  function buildEdgeFill(data) {
    console.time("[terrain] build edge fill");
    const terrain = data.terrain;
    const center = viewCenter();
    const radius = viewRadius();
    const innerRadius = Math.max(1, radius - Math.max(terrain.dx, terrain.dy) * 2.2);
    const segments = 256;
    const positions = [];
    const colors = [];
    const indices = [];

    for (let i = 0; i <= segments; i += 1) {
      const angle = (i / segments) * Math.PI * 2;
      for (const r of [innerRadius, radius]) {
        const x = center[0] + Math.cos(angle) * r;
        const y = center[1] + Math.sin(angle) * r;
        const z = sampleHeight(terrain, x, y);
        positions.push(localX(x, center), z + 1, localY(y, center));
        const color = colorForNormal(terrainNormalAtPoint(terrain, x, y));
        colors.push(color.r, color.g, color.b);
      }
    }

    for (let i = 0; i < segments; i += 1) {
      const inner0 = i * 2;
      const outer0 = inner0 + 1;
      const inner1 = inner0 + 2;
      const outer1 = inner0 + 3;
      indices.push(inner0, outer0, inner1, inner1, outer0, outer1);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    state.root.add(new THREE.Mesh(geometry, material));
    console.timeEnd("[terrain] build edge fill");
  }

  function buildCylinderWall(data, baseHeight) {
    console.time("[terrain] build cylinder wall");
    const terrain = data.terrain;
    const center = viewCenter();
    const radius = viewRadius();
    const segments = 192;
    const positions = [];
    const colors = [];
    const indices = [];

    for (let i = 0; i <= segments; i += 1) {
      const angle = (i / segments) * Math.PI * 2;
      const x = center[0] + Math.cos(angle) * radius;
      const y = center[1] + Math.sin(angle) * radius;
      const z = sampleHeight(terrain, x, y);
      positions.push(localX(x, center), z, localY(y, center));
      positions.push(localX(x, center), baseHeight, localY(y, center));
      colors.push(0.32, 0.27, 0.18, 0.13, 0.10, 0.08);
    }

    for (let i = 0; i < segments; i += 1) {
      const top0 = i * 2;
      const bottom0 = top0 + 1;
      const top1 = top0 + 2;
      const bottom1 = top0 + 3;
      indices.push(top0, bottom0, top1, top1, bottom0, bottom1);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    state.root.add(new THREE.Mesh(geometry, material));
    console.timeEnd("[terrain] build cylinder wall");
  }

  function buildLine(points, color, width) {
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    return new THREE.Line(geometry, new THREE.LineBasicMaterial({ color, linewidth: width }));
  }

  function buildOverlays(data) {
    console.time("[terrain] build overlays");
    const center = viewCenter();
    const terrain = data.terrain;
    const circleRadius = viewRadius();
    const topLift = 26;

    const pathPoints = data.flightPath
      .filter((point) => {
        const dx = point[0] - center[0];
        const dy = point[1] - center[1];
        return dx * dx + dy * dy <= circleRadius * circleRadius * 1.8;
      })
      .map((point) => new THREE.Vector3(localX(point[0], center), point[2] + topLift, localY(point[1], center)));
    state.root.add(buildLine(pathPoints, 0xffffff, 3));

    const focusPoint = data.flightPath[Math.min(state.focusIndex, data.flightPath.length - 1)];
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(Math.max(18, circleRadius * 0.018), 24, 12),
      new THREE.MeshBasicMaterial({ color: 0xf97316 })
    );
    marker.position.set(localX(focusPoint[0], center), focusPoint[2] + topLift + 28, localY(focusPoint[1], center));
    state.root.add(marker);

    const rim = [];
    for (let i = 0; i <= 192; i += 1) {
      const angle = (i / 192) * Math.PI * 2;
      const x = center[0] + Math.cos(angle) * circleRadius;
      const y = center[1] + Math.sin(angle) * circleRadius;
      rim.push(new THREE.Vector3(localX(x, center), sampleHeight(terrain, x, y) + 18, localY(y, center)));
    }
    state.root.add(buildLine(rim, 0xdde7f3, 1));

    const start = mapAngleFromAzimuth(data.sun.startAzimuth);
    let end = mapAngleFromAzimuth(data.sun.endAzimuth);
    while (end - start > Math.PI) end -= Math.PI * 2;
    while (end - start < -Math.PI) end += Math.PI * 2;

    const arc = [];
    const arcRadius = circleRadius * 1.065;
    const arcHeight = terrain.zMax + 120;
    for (let i = 0; i <= 80; i += 1) {
      const angle = start + (end - start) * (i / 80);
      const x = Math.cos(angle) * arcRadius;
      const y = -Math.sin(angle) * arcRadius;
      arc.push(new THREE.Vector3(x, arcHeight, y));
    }
    state.root.add(buildLine(arc, 0xf59e0b, 5));
    console.timeEnd("[terrain] build overlays");
  }

  function setCamera(viewMode) {
    const container = document.getElementById("terrain-viewer");
    if (!container || !state.camera || !state.renderer || !state.data) return;

    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    const radius = viewRadius();
    const terrain = state.data.terrain;
    const aspect = width / height;
    const frustum = radius * 2.55;
    state.camera.left = (-frustum * aspect) / 2;
    state.camera.right = (frustum * aspect) / 2;
    state.camera.top = frustum / 2;
    state.camera.bottom = -frustum / 2;
    state.camera.near = -10000;
    state.camera.far = 50000;

    const midHeight = (terrain.zMin + terrain.zMax) / 2;
    const directionX = Math.cos(state.azimuth);
    const directionZ = Math.sin(state.azimuth);
    if (viewMode === "isometric") {
      const distance = radius * 1.55;
      state.camera.position.set(directionX * distance, terrain.zMax + radius * 1.15, directionZ * distance);
      state.camera.up.set(0, 1, 0);
      state.camera.lookAt(0, midHeight, 0);
    } else {
      state.camera.position.set(0, terrain.zMax + radius * 2.2, 0.001);
      state.camera.up.set(-directionZ, 0, -directionX);
      state.camera.lookAt(0, midHeight, 0);
    }
    state.camera.updateProjectionMatrix();
    state.renderer.setSize(width, height, false);
    state.renderer.render(state.scene, state.camera);
    updateScaleBar(width);
    console.log("[terrain] rendered frame", { viewMode, width, height });
  }

  function updateScaleBar(width) {
    const bar = document.getElementById("scale-bar");
    if (!bar || !state.camera || !state.data) return;

    const terrain = state.data.terrain;
    const midHeight = (terrain.zMin + terrain.zMax) / 2;
    const start = new THREE.Vector3(0, midHeight, 0).project(state.camera);
    const end = new THREE.Vector3(1000, midHeight, 0).project(state.camera);
    const pixels = Math.abs(end.x - start.x) * width / 2;
    bar.style.width = `${Math.max(8, pixels)}px`;
  }

  function rebuildGeometry() {
    if (!state.scene || !state.data) return;
    const start = performance.now();
    if (state.root) {
      state.scene.remove(state.root);
    }
    state.root = new THREE.Group();
    state.scene.add(state.root);
    buildTerrain(state.data);
    buildOverlays(state.data);
    setCamera(state.viewMode);
    const label = state.data.preview ? "Preview" : "Cutout";
    setStatus(`${label} ${Math.round(viewRadius())} m · point ${state.focusIndex + 1}/${state.data.flightPath.length}`);
    console.log("[terrain] rebuild geometry timing", {
      preview: !!state.data.preview,
      totalMs: Math.round(performance.now() - start),
      grid: `${state.data.terrain.width}x${state.data.terrain.height}`,
      radius: Math.round(state.data.circle.radius),
      resolution: state.data.resolution,
    });
  }

  function requestTerrain() {
    if (!state.meta) return;
    const radius = Math.max(state.minCutoutRadius, Math.min(state.maxCutoutRadius, state.cutoutRadius));
    const index = Math.max(0, Math.min(state.meta.flightPath.length - 1, state.focusIndex));
    const focusPoint = state.meta.flightPath[index];
    const center = clampedCenterFor(focusPoint, radius);
    const circle = { center, radius };
    const resolution = resolutionForRadius(radius);
    const tiles = neededTiles(center, radius, resolution);
    const missingTiles = tiles.filter((tile) => !state.tileCache.has(tileKey(tile)));
    const serial = ++state.requestSerial;
    if (state.abortController) {
      state.abortController.abort();
      state.abortController = null;
    }

    if (missingTiles.length === 0) {
      window.clearTimeout(state.pendingRequest);
      render(assembleTerrainFromTiles(tiles, circle, index, resolution), state.viewMode);
      return;
    }

    const preview = overviewFor(index, radius);
    if (preview) {
      render(preview, state.viewMode);
      setStatus(`Preview ${Math.round(radius * 2 / 1000)} km terrain...`);
    }

    window.clearTimeout(state.pendingRequest);
    state.pendingRequest = window.setTimeout(async () => {
      if (serial !== state.requestSerial) return;

      setStatus(`Loading ${missingTiles.length}/${tiles.length} terrain tiles...`);
      state.abortController = new AbortController();
      const fetchStart = performance.now();
      let tileResponses;
      try {
        tileResponses = await Promise.all(missingTiles.map(async (tile) => {
          const response = await fetch(
            `/terrain-tile?x0=${tile.x0}&y0=${tile.y0}&resolution=${tile.resolution}`,
            { signal: state.abortController.signal }
          );
          if (!response.ok) throw new Error(`tile ${tileKey(tile)} failed: ${response.status}`);
          const jsonStart = performance.now();
          const payload = await response.json();
          return { tile, payload, jsonMs: performance.now() - jsonStart };
        }));
      } catch (error) {
        if (error.name !== "AbortError") {
          setStatus(`Terrain request failed: ${error.message}`);
        }
        return;
      }
      const responseMs = performance.now() - fetchStart;
      if (serial !== state.requestSerial) return;
      for (const { tile, payload } of tileResponses) {
        state.tileCache.set(tileKey(tile), payload);
      }
      const data = assembleTerrainFromTiles(tiles, circle, index, resolution);
      const renderStart = performance.now();
      render(data, state.viewMode);
      console.log("[terrain] tile request timing", {
        responseMs: Math.round(responseMs),
        jsonMs: Math.round(tileResponses.reduce((total, item) => total + item.jsonMs, 0)),
        renderMs: Math.round(performance.now() - renderStart),
        missingTiles: missingTiles.length,
        totalTiles: tiles.length,
        grid: `${data.terrain.width}x${data.terrain.height}`,
        resolution: data.resolution,
      });
    }, 180);
  }

  function render(data, viewMode) {
    const container = document.getElementById("terrain-viewer");
    console.log("[terrain] render called", { hasData: !!data, viewMode, hasContainer: !!container, hasThree: !!window.THREE });
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
    state.maxCutoutRadius = data.maxRadius ?? state.maxCutoutRadius;
    state.minCutoutRadius = data.minRadius ?? state.minCutoutRadius;
    state.cutoutRadius = data.circle.radius;
    state.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10000, 50000);
    installScrubber();

    rebuildGeometry();
    setStatus(viewMode === "isometric" ? "Isometric WebGL terrain" : "Top-down WebGL terrain");
  }

  window.renderTerrainViewer = render;
  window.addEventListener("resize", () => setCamera(state.viewMode));
  window.addEventListener("DOMContentLoaded", () => {
    if (window.TERRAIN_META) {
      state.meta = window.TERRAIN_META;
      state.overviewData = window.TERRAIN_OVERVIEW || null;
      state.viewMode = window.TERRAIN_VIEW_MODE || "isometric";
      state.minCutoutRadius = state.meta.minRadius;
      state.maxCutoutRadius = state.meta.maxRadius;
      state.cutoutRadius = state.maxCutoutRadius;
      installScrubber();
      requestTerrain();
    } else {
      setStatus("No embedded terrain metadata");
    }
  });
})();
