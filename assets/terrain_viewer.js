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
    pendingTileRequests: new Map(),
    textureCache: new Map(),
    pendingTextureRequests: new Map(),
    azimuth: Math.PI / 4,
    dragging: false,
    dragStartX: 0,
    dragStartAzimuth: 0,
    viewMode: "isometric",
    dragInstalled: false,
    scrubInstalled: false,
    focusIndex: 0,
    directionalLight: null,
    cutoutRadius: 1200,
    minCutoutRadius: 450,
    maxCutoutRadius: 1200,
  };

  function setStatus(message) {
    const status = document.getElementById("terrain-status");
    if (status) status.textContent = message;
    console.log(`[terrain] ${message}`);
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

  function lodForRadius(radius) {
    if (radius >= 10000) return { tileSize: 10000, resolution: 50 };
    if (radius >= 5000) return { tileSize: 5000, resolution: 25 };
    if (radius >= 2500) return { tileSize: 2000, resolution: 10 };
    return { tileSize: 1000, resolution: 5 };
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

  function assembleTerrainFromTiles(tiles, circle, focusIndex, resolution) {
    const tilePayloads = tiles.map((tile) => state.tileCache.get(tileKey(tile)).tile);
    const minX = Math.min(...tilePayloads.map((tile) => tile.x0));
    const minY = Math.min(...tilePayloads.map((tile) => tile.y0));
    const maxX = Math.max(...tilePayloads.map((tile) => tile.x0 + tile.resolution * tile.width));
    const maxY = Math.max(...tilePayloads.map((tile) => tile.y0 + tile.resolution * tile.height));
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
      resolution,
      minRadius: state.minCutoutRadius,
      maxRadius: state.maxCutoutRadius,
    };
  }

  function ensureTile(tile) {
    const key = tileKey(tile);
    if (state.tileCache.has(key)) {
      return Promise.resolve({ tile, payload: state.tileCache.get(key), cached: true, jsonMs: 0 });
    }
    if (state.pendingTileRequests.has(key)) {
      return state.pendingTileRequests.get(key);
    }

    const promise = (async () => {
      const response = await fetch(`/terrain-tile?x0=${tile.x0}&y0=${tile.y0}&resolution=${tile.resolution}&size=${tile.size}`);
      if (!response.ok) throw new Error(`tile ${key} failed: ${response.status}`);
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

  function meshStride(terrain, radius) {
    const estimatedVertices = Math.PI * radius * radius / Math.max(1, terrain.dx * terrain.dy);
    if (estimatedVertices > 600000) return 4;
    if (estimatedVertices > 300000) return 3;
    if (estimatedVertices > 120000) return 2;
    return 1;
  }

  function resetScene(container) {
    console.log("[terrain] reset scene", { width: container.clientWidth, height: container.clientHeight });
    if (state.renderer) {
      state.renderer.dispose();
      container.replaceChildren();
    }

    state.scene = new THREE.Scene();
    state.scene.background = null;
    state.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    state.renderer.shadowMap.enabled = true;
    state.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    state.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    container.appendChild(state.renderer.domElement);

    const ambient = new THREE.AmbientLight(0xffffff, 0.35);
    state.directionalLight = new THREE.DirectionalLight(0xfff1c2, 1.6);
    state.directionalLight.castShadow = true;
    state.directionalLight.shadow.mapSize.set(2048, 2048);
    state.directionalLight.shadow.bias = -0.0005;
    state.directionalLight.shadow.normalBias = 0.02;
    state.directionalLight.shadow.radius = 2;
    state.directionalLight.position.set(-0.7, 0.45, 1.0);
    state.scene.add(ambient, state.directionalLight, state.directionalLight.target);
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

    let wheelTimeout = 0;
    container.addEventListener("wheel", (event) => {
      event.preventDefault();
      const factor = Math.exp(event.deltaY * 0.0012);
      state.cutoutRadius = Math.max(state.minCutoutRadius, Math.min(state.maxCutoutRadius, state.cutoutRadius * factor));
      if (state.data) setCamera(state.viewMode);
      clearTimeout(wheelTimeout);
      wheelTimeout = setTimeout(() => requestTerrain(), 120);
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
      updateSunLight(state.focusIndex);
      requestTerrain();
    });
  }

  function buildTerrain(data) {
    console.time("[terrain] build terrain mesh");
    const terrain = data.terrain;
    const center = viewCenter();
    const radius = viewRadius();
    const baseHeight = terrain.zMin - Math.max(100, (terrain.zMax - terrain.zMin) * 0.14);
    const stride = meshStride(terrain, radius);
    const positions = [];
    const sampledWidth = Math.ceil(terrain.width / stride);
    const sampledHeight = Math.ceil(terrain.height / stride);
    const indexByGrid = new Int32Array(sampledWidth * sampledHeight).fill(-1);

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
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    // Slope-based coloring: flat = darker/warmer, steep = lighter/colder
    const normals = geometry.attributes.normal.array;
    const colors = new Float32Array(normals.length);
    for (let i = 0; i < normals.length; i += 3) {
      const ny = normals[i + 1]; // Y is up
      const flatness = THREE.MathUtils.clamp(ny, 0, 1);
      // Use power curve for stronger contrast: flat→warm brown #7a5c3a, steep→cool pale #c8d0e8
      const t = Math.pow(1 - flatness, 0.6);
      const r = THREE.MathUtils.lerp(122 / 255, 200 / 255, t);
      const g = THREE.MathUtils.lerp(92 / 255, 208 / 255, t);
      const b = THREE.MathUtils.lerp(58 / 255, 232 / 255, t);
      colors[i] = r;
      colors[i + 1] = g;
      colors[i + 2] = b;
    }
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    state.root.add(mesh);

    buildEdgeFill(data);
    buildCylinderWall(data, baseHeight);
    console.timeEnd("[terrain] build terrain mesh");
    console.log("[terrain] terrain mesh ready", { vertices: positions.length / 3, triangles: indices.length / 3, stride });
  }

  function buildEdgeFill(data) {
    console.time("[terrain] build edge fill");
    const terrain = data.terrain;
    const center = viewCenter();
    const radius = viewRadius();
    const innerRadius = Math.max(1, radius - Math.max(terrain.dx, terrain.dy) * 2.2);
    const segments = 256;
    const positions = [];
    const indices = [];

    for (let i = 0; i <= segments; i += 1) {
      const angle = (i / segments) * Math.PI * 2;
      for (const r of [innerRadius, radius]) {
        const x = center[0] + Math.cos(angle) * r;
        const y = center[1] + Math.sin(angle) * r;
        const z = sampleHeight(terrain, x, y);
        positions.push(localX(x, center), z + 1, localY(y, center));
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
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const material = new THREE.MeshLambertMaterial({ color: 0xc8c0b0, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    state.root.add(mesh);
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
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    state.root.add(mesh);

    // Strongly blurred shadow disc under cylinder (multiple concentric rings)
    for (let i = 0; i < 6; i++) {
      const inner = radius * (0.85 + i * 0.05);
      const outer = radius * (1.15 - i * 0.05);
      const opacity = 0.08 * (1 - i / 6);
      const ringGeo = new THREE.RingGeometry(inner, outer, 64);
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0x000000,
        opacity,
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(0, baseHeight + 0.5, 0);
      ring.receiveShadow = true;
      state.root.add(ring);
    }

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

    // Shadow camera frustum covers the visible terrain circle
    const shadowCam = state.directionalLight.shadow.camera;
    const pad = radius * 0.1;
    shadowCam.left = -radius - pad;
    shadowCam.right = radius + pad;
    shadowCam.top = radius + pad;
    shadowCam.bottom = -radius - pad;
    shadowCam.near = terrain.zMin - 500;
    shadowCam.far = terrain.zMax + 500;
    shadowCam.updateProjectionMatrix();

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
    const radius = viewRadius();
    setStatus(`${label} ${Math.round(radius)} m · point ${state.focusIndex + 1}/${state.data.flightPath.length}`);
    console.log("[terrain] rebuild geometry timing", {
      preview: !!state.data.preview,
      totalMs: Math.round(performance.now() - start),
      grid: `${state.data.terrain.width}x${state.data.terrain.height}`,
      radius: Math.round(radius),
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
    const lod = lodForRadius(radius);
    const resolution = lod.resolution;
    const tiles = neededTiles(center, radius, lod);
    const missingTiles = tiles.filter((tile) => !state.tileCache.has(tileKey(tile)));
    const serial = ++state.requestSerial;
    const renderAvailableTiles = (previewAllowed = true) => {
      const availableTiles = tiles.filter((tile) => state.tileCache.has(tileKey(tile)));
      if (availableTiles.length > 0) {
        render(assembleTerrainFromTiles(availableTiles, circle, index, resolution), state.viewMode);
        setStatus(`Tiles ${availableTiles.length}/${tiles.length} · ${lod.tileSize / 1000} km @ ${resolution} m · point ${index + 1}/${state.meta.flightPath.length}`);
        return true;
      }
      if (previewAllowed) {
        const preview = overviewFor(index, radius);
        if (preview) {
          render(preview, state.viewMode);
          setStatus(`Preview while loading ${tiles.length} terrain tiles...`);
          return true;
        }
      }
      return false;
    };

    if (missingTiles.length === 0) {
      window.clearTimeout(state.pendingRequest);
      renderAvailableTiles(false);
      return;
    }

    const isFirstLoad = !state.data;
    renderAvailableTiles(isFirstLoad);

    window.clearTimeout(state.pendingRequest);
    state.pendingRequest = window.setTimeout(async () => {
      if (serial !== state.requestSerial) return;

      setStatus(`Loading ${missingTiles.length}/${tiles.length} terrain tiles (${lod.tileSize / 1000} km @ ${resolution} m)...`);
      const fetchStart = performance.now();

      if (isFirstLoad) {
        let completedTiles = 0;
        for (const tile of missingTiles) {
          ensureTile(tile)
            .then(({ cached, jsonMs }) => {
              completedTiles += 1;
              if (serial !== state.requestSerial) return;
              const renderStart = performance.now();
              renderAvailableTiles(false);
              console.log("[terrain] tile arrived", {
                tile: tileKey(tile),
                cached,
                jsonMs: Math.round(jsonMs),
                completedTiles,
                missingTiles: missingTiles.length,
                elapsedMs: Math.round(performance.now() - fetchStart),
                renderMs: Math.round(performance.now() - renderStart),
              });
            })
            .catch((error) => {
              if (serial === state.requestSerial) {
                setStatus(`Terrain tile failed: ${error.message}`);
              }
            });
        }
      } else {
        const promises = missingTiles.map((tile) =>
          ensureTile(tile).catch(() => {})
        );
        await Promise.allSettled(promises);
        if (serial === state.requestSerial) {
          renderAvailableTiles(false);
        }
      }

      console.log("[terrain] tile requests started", {
        missingTiles: missingTiles.length,
        totalTiles: tiles.length,
        tileSize: lod.tileSize,
        resolution,
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

    updateSunLight(state.focusIndex);
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
      // Don't fetch tiles yet — overview preview shows full zoom-out view.
      // Tiles load on first interaction (zoom/scrub/drag).
    } else {
      setStatus("No embedded terrain metadata");
    }
  });
})();
