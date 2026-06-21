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

  function localX(x, center) {
    return x - center[0];
  }

  function localY(y, center) {
    return -(y - center[1]);
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
  }

  function buildTerrain(data) {
    console.time("[terrain] build terrain mesh");
    const terrain = data.terrain;
    const center = data.circle.center;
    const radius = data.circle.radius;
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

    buildCylinderWall(data, baseHeight);
    console.timeEnd("[terrain] build terrain mesh");
    console.log("[terrain] terrain mesh ready", { vertices: positions.length / 3, triangles: indices.length / 3 });
  }

  function buildCylinderWall(data, baseHeight) {
    console.time("[terrain] build cylinder wall");
    const terrain = data.terrain;
    const center = data.circle.center;
    const radius = data.circle.radius;
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
    const center = data.circle.center;
    const terrain = data.terrain;
    const circleRadius = data.circle.radius;
    const topLift = 26;

    const pathPoints = data.flightPath.map((point) => new THREE.Vector3(localX(point[0], center), point[2] + topLift, localY(point[1], center)));
    state.root.add(buildLine(pathPoints, 0xffffff, 3));

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
    const radius = state.data.circle.radius;
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
    console.log("[terrain] rendered frame", { viewMode, width, height });
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
    state.root = new THREE.Group();
    state.scene.add(state.root);
    state.data = data;
    state.viewMode = viewMode;
    state.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10000, 50000);

    buildTerrain(data);
    buildOverlays(data);
    setCamera(viewMode);
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
