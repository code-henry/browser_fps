import * as THREE from './three.module.js';
import {
  PLAYER_HEIGHT,
  CITY_EXTENT,
  CITY_SPACING,
  TREE_JITTER_FACTOR,
  TREE_BASE_THICKNESS,
  TREE_THICKNESS_VARIANCE,
  ROBOT_SPAWNS,
  ROBOT_DIM
} from './config.js';

export function createScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffffff);

  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(0, PLAYER_HEIGHT, 0);

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

  // 予約領域（ロボットの占有半径）を事前に計算
  const torsoHalfDiag = Math.sqrt(3) * (ROBOT_DIM.torso / 2);
  const reserveRadius = torsoHalfDiag + ROBOT_DIM.reserveMargin; // XZ平面の円形近似
  const reserves = ROBOT_SPAWNS.map(p => ({ x: p.x, z: p.z, r: reserveRadius }));

  // 建物配置（白 + エッジ）
  const boxMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff });

  const spacing = CITY_SPACING;
  const extent = CITY_EXTENT; // より広いエリアに拡張
  const jitterRange = spacing * TREE_JITTER_FACTOR; // 列/行が一直線にならないように位置を微オフセット

  // 衝突用のコライダー配列
  const colliders = [];

  for (let x = -extent; x <= extent; x += spacing) {
    for (let z = -extent; z <= extent; z += spacing) {
      // 位置ジッターを適用
      const jx = (Math.random() * 2 - 1) * jitterRange;
      const jz = (Math.random() * 2 - 1) * jitterRange;
      const px = x + jx;
      const pz = z + jz;

      // 予約領域内なら建物を置かない
      let blocked = false;
      for (const rv of reserves) {
        const dx = px - rv.x;
        const dz = pz - rv.z;
        if (dx * dx + dz * dz < rv.r * rv.r) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;

      const height = 20 + Math.random() * 60;

      // 太さ（幅・奥行）のランダム化
      const baseThickness = TREE_BASE_THICKNESS;
      const variance = TREE_THICKNESS_VARIANCE;
      const thicknessX = baseThickness + (Math.random() * 2 * variance - variance);
      const thicknessZ = baseThickness + (Math.random() * 2 * variance - variance);

      const geometry = new THREE.BoxGeometry(thicknessX, height, thicknessZ);
      const building = new THREE.Mesh(geometry, boxMaterial);
      building.position.set(px, height / 2, pz);
      building.castShadow = true;
      building.receiveShadow = true;
      scene.add(building);

      // コライダー（XZのAABB）を登録
      colliders.push({
        minX: px - thicknessX / 2,
        maxX: px + thicknessX / 2,
        minZ: pz - thicknessZ / 2,
        maxZ: pz + thicknessZ / 2,
        maxY: height
      });

      // エッジ線（黒）
      const edges = new THREE.EdgesGeometry(geometry);
      const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x000000 }));
      line.position.copy(building.position);
      scene.add(line);
    }
  }

  // ロボット生成（仕様書準拠）
  function createRobot() {
    const group = new THREE.Group();

    const color = 0xdddddd;
    const edgeColor = 0x000000;

    // 胴体
    const torsoSize = ROBOT_DIM.torso;
    const torsoGeo = new THREE.BoxGeometry(torsoSize, torsoSize, torsoSize);
    const torsoMat = new THREE.MeshStandardMaterial({ color });
    const torso = new THREE.Mesh(torsoGeo, torsoMat);
    torso.castShadow = true;
    torso.receiveShadow = true;
    group.add(torso);

    const torsoEdges = new THREE.EdgesGeometry(torsoGeo);
    const torsoLine = new THREE.LineSegments(torsoEdges, new THREE.LineBasicMaterial({ color: edgeColor }));
    group.add(torsoLine);

    // 頭
    const headSize = ROBOT_DIM.head;
    const headGeo = new THREE.BoxGeometry(headSize, headSize, headSize);
    const headMat = new THREE.MeshStandardMaterial({ color });
    const head = new THREE.Mesh(headGeo, headMat);
    head.castShadow = true;
    head.receiveShadow = true;
    head.position.y = (torsoSize / 2) + 1 + (headSize / 2);
    group.add(head);
    const headEdges = new THREE.EdgesGeometry(headGeo);
    const headLine = new THREE.LineSegments(headEdges, new THREE.LineBasicMaterial({ color: edgeColor }));
    headLine.position.copy(head.position);
    group.add(headLine);

    // 腕（左右）
    const { w: armW, h: armH, d: armD } = ROBOT_DIM.arm;
    const armGeo = new THREE.BoxGeometry(armW, armH, armD);
    const armMat = new THREE.MeshStandardMaterial({ color });
    const armY = (ROBOT_DIM.armHeightRatio * torsoSize) - (torsoSize / 2); // 胴体中心基準の相対位置

    const armL = new THREE.Mesh(armGeo, armMat);
    armL.castShadow = true;
    armL.receiveShadow = true;
    armL.position.set(-(torsoSize / 2) - (armW / 2), armY, 0);
    group.add(armL);
    const armLEdges = new THREE.EdgesGeometry(armGeo);
    const armLLine = new THREE.LineSegments(armLEdges, new THREE.LineBasicMaterial({ color: edgeColor }));
    armLLine.position.copy(armL.position);
    group.add(armLLine);

    const armR = new THREE.Mesh(armGeo, armMat);
    armR.castShadow = true;
    armR.receiveShadow = true;
    armR.position.set((torsoSize / 2) + (armW / 2), armY, 0);
    group.add(armR);
    const armREdges = new THREE.EdgesGeometry(armGeo);
    const armRLine = new THREE.LineSegments(armREdges, new THREE.LineBasicMaterial({ color: edgeColor }));
    armRLine.position.copy(armR.position);
    group.add(armRLine);

    return group;
  }

  // ロボットを配置
  for (const spawn of ROBOT_SPAWNS) {
    const robot = createRobot();
    // 胴体中心が原点なので、地面に乗せるよう全体を上に持ち上げる
    robot.position.set(spawn.x, ROBOT_DIM.torso / 2, spawn.z);
    scene.add(robot);
  }

  return { scene, camera, renderer, colliders };
}
