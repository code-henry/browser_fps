import * as THREE from './three.module.js';

export function createScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffffff);

  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(0, 5, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  document.body.appendChild(renderer.domElement);

  // グリッド床
  const grid = new THREE.GridHelper(1000, 100, 0x444444, 0x444444);
  scene.add(grid);

  // 地面（影を落とす用）
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(1000, 1000),
    new THREE.ShadowMaterial({ opacity: 0.2 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // 光源
  const light = new THREE.DirectionalLight(0xffffff, 1);
  light.position.set(50, 100, 50);
  light.castShadow = true;
  light.shadow.mapSize.width = 1024;
  light.shadow.mapSize.height = 1024;
  light.shadow.camera.near = 0.5;
  light.shadow.camera.far = 500;
  scene.add(light);

  scene.add(new THREE.AmbientLight(0xffffff, 0.4));

  // 建物配置（白 + エッジ）
  const boxMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff });

  // 間隔を広げる（もとの20 → 40）
  const spacing = 40;
  const extent = 100;

  for (let x = -extent; x <= extent; x += spacing) {
    for (let z = -extent; z <= extent; z += spacing) {
      const height = 20 + Math.random() * 60;

      const geometry = new THREE.BoxGeometry(10, height, 10);
      const building = new THREE.Mesh(geometry, boxMaterial);
      building.position.set(x, height / 2, z);
      building.castShadow = true;
      building.receiveShadow = true;
      scene.add(building);

      // エッジ線（黒）
      const edges = new THREE.EdgesGeometry(geometry);
      const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x000000 }));
      line.position.copy(building.position);
      scene.add(line);
    }
  }

  return { scene, camera, renderer };
}
