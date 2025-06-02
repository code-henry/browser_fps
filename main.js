// main.js

import * as THREE from './three.module.js';
import { createScene } from './scene.js';
import { setupControls, handleMovement } from './controls.js';

// ----- 1. シーン・カメラ・レンダラーの初期化 -----
const { scene, camera, renderer } = createScene();

// ----- 2. PointerLockControls + WASD 移動 のセットアップ -----
const controls = setupControls(camera);

//
// 3. プレイヤー状態・物理パラメータ
//
let playerPos = new THREE.Vector3(0, 5, 0);
let playerVelocity = new THREE.Vector3(0, 0, 0);

// 重力ベクトル（毎フレーム必ず適用）
const gravity = new THREE.Vector3(0, -80.8, 0);

// 減衰係数（空気抵抗相当）
const dampingCoeff = 1.0;

//
// 4. ワイヤー関連 スピード・パワー調整パラメータ
//

// === 基本張力パラメータ ===
let grappleStrength = 10.0;          // 基本張力（デフォルト: 10）

// === スピード系パラメータ ===
let grappleSpeedMultiplier = 3.0;    // 全体的なスピード倍率（1.0 = 通常、2.0 = 2倍速）
let maxSwingSpeed = 35.0;            // 最高スイング速度（水平方向の速度制限）
let accelerationBoost = 1.0;         // 加速度ブースト倍率（より素早い加速）

// === ワイヤー物理パラメータ ===
let grappleRestLength = 2.0;         // ワイヤーの自然長（短いほど強く引っ張る）
let wireTension = 1.0;               // ワイヤーの張り具合（1.0 = 通常、2.0 = より張る）
let swingDamping = 0.8;              // スイング時の縦振動減衰（0.5-0.9推奨）

// === 高速移動用パラメータ ===
let turboMode = false;               // ターボモード（Shift押下で高速化）
let turboMultiplier = 2.5;           // ターボ時の速度倍率
let quickReleaseBoost = 1.5;         // ワイヤー解除時の慣性ブースト

// === 追従・カメラパラメータ ===
let grappleFollowFactor = 0.3;       // 画面追従速度（0.1=遅い, 0.9=速い）
let cameraStabilization = true;      // カメラ安定化ON/OFF

//
// 5. ワイヤー関連フラグ・状態
//
let isGrappleLeft = false;
let isGrappleRight = false;
const leftAnchor = new THREE.Vector3();
const rightAnchor = new THREE.Vector3();

// ※ skipMovementForFrames は廃止
let isInertiaMode = false;

const visiblePos = playerPos.clone();

// ワイヤー用表示ジオメトリ
let leftRope = null;
let rightRope = null;

// Raycastingのセットアップ
const raycaster = new THREE.Raycaster();
const rayDirection = new THREE.Vector3();

// シーン内のオブジェクトを取得（建物など）
let sceneObjects = [];
scene.traverse((child) => {
  if (child.isMesh && child.geometry.type === 'BoxGeometry') {
    sceneObjects.push(child);
  }
});

//
// 6. ワイヤー関連の関数
//
function createRopeLine(side, anchor) {
  const points = [playerPos.clone(), anchor.clone()];
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({
    color: side === 'left' ? 0x00ff00 : 0xff0000,
    linewidth: 3
  });
  const line = new THREE.Line(geometry, material);
  scene.add(line);
  return line;
}

function updateRopeLine(rope, anchor) {
  if (rope) {
    const points = [playerPos.clone(), anchor.clone()];
    rope.geometry.setFromPoints(points);
    rope.geometry.attributes.position.needsUpdate = true;
  }
}

function deployWire(isLeft) {
  // カメラの向いている方向にraycast
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  const intersects = raycaster.intersectObjects(sceneObjects);

  if (intersects.length > 0) {
    // 建物に当たった場合
    const hitPoint = intersects[0].point.clone();

    if (isLeft) {
      leftAnchor.copy(hitPoint);
      isGrappleLeft = true;
      leftRope = createRopeLine('left', leftAnchor);
      console.log('Left wire deployed to building at:', leftAnchor);
    } else {
      rightAnchor.copy(hitPoint);
      isGrappleRight = true;
      rightRope = createRopeLine('right', rightAnchor);
      console.log('Right wire deployed to building at:', rightAnchor);
    }
  } else {
    // 建物に当たらなかった場合は、適当な距離にアンカーを設定
    const rayOrigin = camera.position.clone();
    const rayDir = new THREE.Vector3(0, 0, -1);
    rayDir.applyQuaternion(camera.quaternion).normalize();

    const grappleDistance = 25;
    const anchor = rayOrigin.add(rayDir.multiplyScalar(grappleDistance));
    anchor.y = Math.max(anchor.y, 10); // 高さ調整

    if (isLeft) {
      leftAnchor.copy(anchor);
      isGrappleLeft = true;
      leftRope = createRopeLine('left', leftAnchor);
      console.log('Left wire deployed to air at:', leftAnchor);
    } else {
      rightAnchor.copy(anchor);
      isGrappleRight = true;
      rightRope = createRopeLine('right', rightAnchor);
      console.log('Right wire deployed to air at:', anchor);
    }
  }
}

//
// 7. リアルタイムパラメータ調整用キーボードショートカット
//
window.addEventListener('keydown', (e) => {
  // ワイヤー操作
  if (e.code === 'KeyQ') {
    if (!isGrappleLeft) {
      deployWire(true); // 左ワイヤーを張る
    } else {
      // 左ワイヤーを解除（解除時に慣性モードを開始）
      isGrappleLeft = false;
      // 慣性モード開始
      isInertiaMode = true;
      // 解除時の慣性ブースト
      if (playerVelocity.lengthSq() > 0) {
        playerVelocity.multiplyScalar(quickReleaseBoost);
      }
      if (leftRope) {
        scene.remove(leftRope);
        leftRope.geometry.dispose();
        leftRope.material.dispose();
        leftRope = null;
      }
      console.log('Left wire released → inertia started (boost:', quickReleaseBoost, ')');
    }
  }

  if (e.code === 'KeyE') {
    if (!isGrappleRight) {
      deployWire(false); // 右ワイヤーを張る
    } else {
      // 右ワイヤーを解除（解除時に慣性モードを開始）
      isGrappleRight = false;
      isInertiaMode = true;
      // 解除時の慣性ブースト
      if (playerVelocity.lengthSq() > 0) {
        playerVelocity.multiplyScalar(quickReleaseBoost);
      }
      if (rightRope) {
        scene.remove(rightRope);
        rightRope.geometry.dispose();
        rightRope.material.dispose();
        rightRope = null;
      }
      console.log('Right wire released → inertia started (boost:', quickReleaseBoost, ')');
    }
  }

  // === スピードパラメータ調整ショートカット ===

  if (e.code === 'Digit1') {
    // 通常モード
    grappleStrength = 50.0;
    grappleSpeedMultiplier = 1.0;
    maxSwingSpeed = 35.0;
    console.log('Mode: Normal');
  }

  if (e.code === 'Digit2') {
    // 高速モード
    grappleStrength = 75.0;
    grappleSpeedMultiplier = 1.5;
    maxSwingSpeed = 50.0;
    console.log('Mode: Fast');
  }

  if (e.code === 'Digit3') {
    // 超高速モード
    grappleStrength = 100.0;
    grappleSpeedMultiplier = 2.0;
    maxSwingSpeed = 70.0;
    console.log('Mode: Super Fast');
  }

  if (e.code === 'Digit4') {
    // 精密モード（低速、高精度）
    grappleStrength = 30.0;
    grappleSpeedMultiplier = 0.7;
    maxSwingSpeed = 20.0;
    grappleFollowFactor = 0.8;
    console.log('Mode: Precision');
  }

  if (e.code === 'Digit5') {
    // 極限モード
    grappleStrength = 150.0;
    grappleSpeedMultiplier = 3.0;
    maxSwingSpeed = 100.0;
    quickReleaseBoost = 2.0;
    console.log('Mode: Extreme');
  }

  // 個別調整
  if (e.code === 'KeyT') {
    grappleStrength += 10;
    console.log('Grapple Strength:', grappleStrength);
  }

  if (e.code === 'KeyG') {
    grappleStrength = Math.max(10, grappleStrength - 10);
    console.log('Grapple Strength:', grappleStrength);
  }

  if (e.code === 'KeyY') {
    grappleSpeedMultiplier += 0.2;
    console.log('Speed Multiplier:', grappleSpeedMultiplier.toFixed(1));
  }

  if (e.code === 'KeyH') {
    grappleSpeedMultiplier = Math.max(0.2, grappleSpeedMultiplier - 0.2);
    console.log('Speed Multiplier:', grappleSpeedMultiplier.toFixed(1));
  }

  if (e.code === 'KeyU') {
    maxSwingSpeed += 5;
    console.log('Max Swing Speed:', maxSwingSpeed);
  }

  if (e.code === 'KeyJ') {
    maxSwingSpeed = Math.max(10, maxSwingSpeed - 5);
    console.log('Max Swing Speed:', maxSwingSpeed);
  }

  // ターボモード切り替え
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
    turboMode = true;
  }
});

window.addEventListener('keyup', (e) => {
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
    turboMode = false;
  }
});

//
// 8. アニメーションループ（慣性追加版）
//
let prevTime = performance.now();

function animate() {
  requestAnimationFrame(animate);

  const time = performance.now();
  const delta = (time - prevTime) / 1000;
  prevTime = time;

  // ターボモード時の倍率適用
  const currentSpeedMult = turboMode ?
    grappleSpeedMultiplier * turboMultiplier :
    grappleSpeedMultiplier;

  // ──────────────────────────────────────────────────
  // (A) 移動モードの判定（慣性＝着地まで継続）
  // ──────────────────────────────────────────────────
  let handleMovementFlag;
  if (isGrappleLeft || isGrappleRight) {
    // ワイヤー接続中は常に「物理演算ベース」の移動
    isInertiaMode = false;    // ワイヤー中は慣性モードをオフ
    handleMovementFlag = false;
  } else if (isInertiaMode) {
    // 慣性モード（着地するまで継続）
    handleMovementFlag = false;
  } else {
    // 通常移動
    handleMovement(controls);
    playerPos.copy(controls.getObject().position);
    handleMovementFlag = true;
  }

  // ──────────────────────────────────────────────────
  // (B) 常に適用する物理演算（重力・減衰・ワイヤー張力・速度更新）
  // ──────────────────────────────────────────────────
  // 1) 合計力の初期化（重力）
  let totalForce = gravity.clone();
  const eps = 0.1;

  // 2) 左ワイヤー張力
  if (isGrappleLeft) {
    const dirLeft = leftAnchor.clone().sub(playerPos).normalize();
    const distLeft = playerPos.distanceTo(leftAnchor);
    const effectiveRestLength = grappleRestLength / wireTension;
    if (distLeft > effectiveRestLength + eps) {
      const stretchLeft = distLeft - effectiveRestLength;
      const forceLeft = dirLeft.multiplyScalar(
        grappleStrength * stretchLeft * currentSpeedMult * accelerationBoost
      );
      totalForce.add(forceLeft);
    }
    updateRopeLine(leftRope, leftAnchor);
  }

  // 3) 右ワイヤー張力
  if (isGrappleRight) {
    const dirRight = rightAnchor.clone().sub(playerPos).normalize();
    const distRight = playerPos.distanceTo(rightAnchor);
    const effectiveRestLength = grappleRestLength / wireTension;
    if (distRight > effectiveRestLength + eps) {
      const stretchRight = distRight - effectiveRestLength;
      const forceRight = dirRight.multiplyScalar(
        grappleStrength * stretchRight * currentSpeedMult * accelerationBoost
      );
      totalForce.add(forceRight);
    }
    updateRopeLine(rightRope, rightAnchor);
  }

  // 4) 減衰力（空気抵抗相当）
  // const dampingForce = playerVelocity.clone().multiplyScalar(-dampingCoeff / currentSpeedMult);
  // totalForce.add(dampingForce);

  const horizVel = new THREE.Vector3(playerVelocity.x, 0, playerVelocity.z);
  const dampingForceHoriz = horizVel.multiplyScalar(-dampingCoeff / currentSpeedMult);
  totalForce.add(dampingForceHoriz);

  // 5) 速度更新
  const acceleration = totalForce.clone();
  playerVelocity.add(acceleration.multiplyScalar(delta));

  // 6) Y方向（垂直）のスイング減衰
  // if (isGrappleLeft || isGrappleRight || isInertiaMode) {
  //   playerVelocity.y *= swingDamping;
  // }

  if (isGrappleLeft || isGrappleRight) {
    playerVelocity.y *= swingDamping;
  }



  // 7) 水平速度制限
  const horiz = new THREE.Vector3(playerVelocity.x, 0, playerVelocity.z);
  const currentMaxSpeed = maxSwingSpeed * currentSpeedMult;
  if (horiz.lengthSq() > currentMaxSpeed * currentMaxSpeed) {
    const scale = currentMaxSpeed / horiz.length();
    playerVelocity.x *= scale;
    playerVelocity.z *= scale;
  }

  // ──────────────────────────────────────────────────
  // (C) 位置更新（通常移動 or 慣性移動 or ワイヤー移動）
  // ──────────────────────────────────────────────────
  if (isGrappleLeft || isGrappleRight || isInertiaMode) {
    // ワイヤー中 or 慣性中は、「速度ベクトル」による移動
    playerPos.add(playerVelocity.clone().multiplyScalar(delta));
  }
  // 通常移動時はすでに handleMovement() が playerPos を書き換えているため、ここでは何もしない

  // ──────────────────────────────────────────────────
  // (D) 地面スナップ ＆ 着地判定
  // ──────────────────────────────────────────────────
  const groundY = 1.5;
  if (playerPos.y < groundY) {
    playerPos.y = groundY;
    playerVelocity.y = 0;
    // 着地したら慣性モードを終了
    if (isInertiaMode) {
      isInertiaMode = false;
    }
  }

  // ──────────────────────────────────────────────────
  // (E) カメラ追従（ワイヤー中/慣性中とも同様）
  // ──────────────────────────────────────────────────
  if (isGrappleLeft || isGrappleRight || isInertiaMode) {
    const followSpeed = cameraStabilization ?
      grappleFollowFactor * (1 + currentSpeedMult * 0.1) :
      grappleFollowFactor;
    visiblePos.x = THREE.MathUtils.lerp(visiblePos.x, playerPos.x, followSpeed);
    visiblePos.z = THREE.MathUtils.lerp(visiblePos.z, playerPos.z, followSpeed);
    visiblePos.y = playerPos.y;
  } else {
    visiblePos.copy(playerPos);
  }
  camera.position.copy(visiblePos);
  controls.getObject().position.copy(visiblePos);

  // ──────────────────────────────────────────────────
  // (F) レンダリング
  // ──────────────────────────────────────────────────
  renderer.render(scene, camera);
}

animate();
