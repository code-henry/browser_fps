import * as THREE from './three.module.js';
import { createScene } from './scene.js';
import { setupControls, handleMovement } from './controls.js';

//
// 1. シーンまわりはそのまま
//
const { scene, camera, renderer } = createScene();

//
// 2. Controls／WASD セットアップ
//
const controls = setupControls(camera);

//
// 3. 疑似物理用のプレイヤー位置／速度
//
let playerPos = new THREE.Vector3(0, 5, 0);
let playerVelocity = new THREE.Vector3(0, 0, 0);

const gravity = new THREE.Vector3(0, -9.8, 0);
const dampingCoeff = 2.0;

let isGrappleLeft = false;
let isGrappleRight = false;
const leftAnchor = new THREE.Vector3();
const rightAnchor = new THREE.Vector3();

const tensionStrength = 50.0;
const restLength = 2.0;

const raycaster = new THREE.Raycaster();
const screenCenter = new THREE.Vector2(0, 0);

let leftRope = null;
let rightRope = null;

function createRopeLine(anchorPos, ropeName) {
  const points = [playerPos.clone(), anchorPos.clone()];
  const ropeGeo = new THREE.BufferGeometry().setFromPoints(points);
  const ropeMat = new THREE.LineBasicMaterial({ color: 0x00ff00 });
  const rope = new THREE.Line(ropeGeo, ropeMat);
  rope.name = ropeName;
  return rope;
}

function updateRopeLine(rope, anchorPos) {
  if (!rope) return;
  const posArr = rope.geometry.attributes.position.array;
  posArr[0] = playerPos.x;
  posArr[1] = playerPos.y;
  posArr[2] = playerPos.z;
  posArr[3] = anchorPos.x;
  posArr[4] = anchorPos.y;
  posArr[5] = anchorPos.z;
  rope.geometry.attributes.position.needsUpdate = true;
}

//
// 4. Q/E トグル式ワイヤー
//
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyQ') {
    if (!isGrappleLeft) {
      raycaster.setFromCamera(screenCenter, camera);
      const intersects = raycaster.intersectObjects(scene.children, true);
      if (intersects.length > 0) {
        isGrappleLeft = true;
        leftAnchor.copy(intersects[0].point);
        leftRope = createRopeLine(leftAnchor, 'leftRope');
        scene.add(leftRope);
      }
    } else {
      isGrappleLeft = false;
      if (leftRope) {
        scene.remove(leftRope);
        leftRope.geometry.dispose();
        leftRope.material.dispose();
        leftRope = null;
      }
    }
  }

  if (e.code === 'KeyE') {
    if (!isGrappleRight) {
      raycaster.setFromCamera(screenCenter, camera);
      const intersects = raycaster.intersectObjects(scene.children, true);
      if (intersects.length > 0) {
        isGrappleRight = true;
        rightAnchor.copy(intersects[0].point);
        rightRope = createRopeLine(rightAnchor, 'rightRope');
        scene.add(rightRope);
      }
    } else {
      isGrappleRight = false;
      if (rightRope) {
        scene.remove(rightRope);
        rightRope.geometry.dispose();
        rightRope.material.dispose();
        rightRope = null;
      }
    }
  }
});

//
// 5. アニメーションループ
//
let prevTime = performance.now();

function animate() {
  requestAnimationFrame(animate);

  const time = performance.now();
  const delta = (time - prevTime) / 1000; // 秒
  prevTime = time;

  // ----- (A) まず WASD 移動を反映させる -----
  handleMovement(controls);

  // (B) WASD で動かされたカメラ位置を playerPos に取り込む
  playerPos.copy(controls.getObject().position);

  // ----- (C) 疑似物理：重力＋ワイヤー＋ダンピングを合成 -----
  let totalForce = gravity.clone();

  if (isGrappleLeft) {
    const dirLeft = leftAnchor.clone().sub(playerPos).normalize();
    const distLeft = playerPos.distanceTo(leftAnchor);
    const stretchLeft = Math.max(distLeft - restLength, 0);
    const forceLeft = dirLeft.multiplyScalar(tensionStrength * stretchLeft);
    totalForce.add(forceLeft);
    updateRopeLine(leftRope, leftAnchor);
  }

  if (isGrappleRight) {
    const dirRight = rightAnchor.clone().sub(playerPos).normalize();
    const distRight = playerPos.distanceTo(rightAnchor);
    const stretchRight = Math.max(distRight - restLength, 0);
    const forceRight = dirRight.multiplyScalar(tensionStrength * stretchRight);
    totalForce.add(forceRight);
    updateRopeLine(rightRope, rightAnchor);
  }

  // ダンピング (抵抗相当)
  const dampingForce = playerVelocity.clone().multiplyScalar(-dampingCoeff);
  totalForce.add(dampingForce);

  // ----- (D) 速度・位置を更新 (Euler) -----
  const acceleration = totalForce.clone(); // 質量＝1
  playerVelocity.add(acceleration.multiplyScalar(delta));
  playerPos.add(playerVelocity.clone().multiplyScalar(delta));

  // 地面あたり判定 (y=1.5 以下には行かない)
  const minY = 1.5;
  if (playerPos.y < minY) {
    playerPos.y = minY;
    playerVelocity.y = 0;
  }

  // ----- (E) カメラ／Controls に playerPos を反映 -----
  camera.position.copy(playerPos);
  controls.getObject().position.copy(playerPos);

  // レンダリング
  renderer.render(scene, camera);
}

animate();

//
// 6. リサイズ対応
//
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
