(() => {
  console.log("[terrain] terrain_viewer.js loaded");

  const state = {
    renderer: null,
    scene: null,
    camera: null,
    root: null,
    data: null,
    pendingRetry: null,
    azimuth: Math.PI / 4,
    dragging: false,
    dragStartX: 0,
    dragStartAzimuth: 0,
    viewMode: "isometric",
    dragInstalled: false,
    focusIndex: 0,
    cutoutRadius: 1200,
    minCutoutRadius: 450,
    maxCutoutRadius: 1200,
  };

  const SHADE_LIGHT = new THREE.Vector3(-0.45, 0.72, -0.52).normalize();

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
    const point = state.data.flightPath[Math.min(state.focusIndex, state.data.flightPath.length - 1)];
    return [point[0], point[1]];
  }

  function viewRadius() {
    return Math.max(state.minCutoutRadius, Math.min(state.maxCutoutRadius, state.cutoutRadius));
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
      rebuildGeometry();
    }, { passive: false });
  }

  function installScrubber() {
    const scrubber = document.getElementById("scrub");
    if (!scrubber || !state.data) return;
    scrubber.max = String(Math.max(0, state.data.flightPath.length - 1));
    scrubber.value = String(state.focusIndex);
    scrubber.addEventListener("input", () => {
      state.focusIndex = Number(scrubber.value);
      rebuildGeometry();
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
    if (state.root) {
      state.scene.remove(state.root);
    }
    state.root = new THREE.Group();
    state.scene.add(state.root);
    buildTerrain(state.data);
    buildOverlays(state.data);
    setCamera(state.viewMode);
    setStatus(`Cutout ${Math.round(viewRadius())} m · point ${state.focusIndex + 1}/${state.data.flightPath.length}`);
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
    state.focusIndex = 0;
    state.maxCutoutRadius = data.circle.radius;
    state.minCutoutRadius = Math.max(250, Math.min(700, data.circle.radius * 0.08));
    state.cutoutRadius = Math.max(state.minCutoutRadius, data.circle.radius * 0.24);
    state.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10000, 50000);
    installScrubber();

    rebuildGeometry();
    setStatus(viewMode === "isometric" ? "Isometric WebGL terrain" : "Top-down WebGL terrain");
  }

  window.renderTerrainViewer = render;
  window.addEventListener("resize", () => setCamera(state.viewMode));
  window.addEventListener("DOMContentLoaded", () => {
    if (window.TERRAIN_PAYLOAD) {
      render(window.TERRAIN_PAYLOAD, window.TERRAIN_VIEW_MODE || "isometric");
    } else {
      setStatus("No embedded terrain payload");
    }
  });
})();
