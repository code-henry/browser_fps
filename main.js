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
let playerPos      = new THREE.Vector3(0, 5, 0);
let playerVelocity = new THREE.Vector3(0, 0, 0);

// 重力ベクトル（毎フレーム必ず適用）
const gravity = new THREE.Vector3(0, -9.8, 0);

// 減衰係数（空気抵抗相当）
const dampingCoeff = 2.0;

//
// 4. ワイヤー関連 スピード・パワー調整パラメータ
//

// === 基本張力パラメータ ===
let grappleStrength = 50.0;          // 基本張力（デフォルト: 50）

// === スピード系パラメータ ===
let grappleSpeedMultiplier = 1.0;    // 全体的なスピード倍率（1.0 = 通常、2.0 = 2倍速）
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
let isGrappleLeft  = false;
let isGrappleRight = false;
const leftAnchor   = new THREE.Vector3();
const rightAnchor  = new THREE.Vector3();

// ワイヤー解除直後に「１フレームだけキーボード入力をブロック」するフラグ
let skipMovementForFrames = 0;

// visiblePos（表示用カメラ位置）を定義
const visiblePos = playerPos.clone();

let isInertiaMode = false;

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
      console.log('Right wire deployed to air at:', rightAnchor);
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
      // 左ワイヤーを解除（解除時にブーストを適用）
      isGrappleLeft = false;
      skipMovementForFrames = 1;
      
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
      console.log('Left wire released with boost:', quickReleaseBoost);
    }
  }

  if (e.code === 'KeyE') {
    if (!isGrappleRight) {
      deployWire(false); // 右ワイヤーを張る
    } else {
      // 右ワイヤーを解除（解除時にブーストを適用）
      isGrappleRight = false;
      skipMovementForFrames = 1;
      
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
      console.log('Right wire released with boost:', quickReleaseBoost);
    }
  }

  // === スピードパラメータ調整ショートカット ===
  
  // 数字キー 1-5: プリセット設定
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
    // 張力アップ
    grappleStrength += 10;
    console.log('Grapple Strength:', grappleStrength);
  }
  
  if (e.code === 'KeyG') {
    // 張力ダウン
    grappleStrength = Math.max(10, grappleStrength - 10);
    console.log('Grapple Strength:', grappleStrength);
  }
  
  if (e.code === 'KeyY') {
    // スピード倍率アップ
    grappleSpeedMultiplier += 0.2;
    console.log('Speed Multiplier:', grappleSpeedMultiplier.toFixed(1));
  }
  
  if (e.code === 'KeyH') {
    // スピード倍率ダウン
    grappleSpeedMultiplier = Math.max(0.2, grappleSpeedMultiplier - 0.2);
    console.log('Speed Multiplier:', grappleSpeedMultiplier.toFixed(1));
  }
  
  if (e.code === 'KeyU') {
    // 最高速度アップ
    maxSwingSpeed += 5;
    console.log('Max Swing Speed:', maxSwingSpeed);
  }
  
  if (e.code === 'KeyJ') {
    // 最高速度ダウン
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
// 8. アニメーションループ（強化版）
//
let prevTime = performance.now();

function animate() {
  requestAnimationFrame(animate);

  const time  = performance.now();
  const delta = (time - prevTime) / 1000;
  prevTime = time;

  // ターボモード時の倍率適用
  const currentSpeedMult = turboMode ? 
    grappleSpeedMultiplier * turboMultiplier : 
    grappleSpeedMultiplier;

  // ──────────────────────────────────────────────────
  // (A) 移動制御の切り分け（慣性移動モードを追加）
  // ──────────────────────────────────────────────────
  if (isGrappleLeft || isGrappleRight) {
    // ワイヤー中：物理演算のみ
    isInertiaMode = false;
  } else if (skipMovementForFrames > 0) {
    // ワイヤー解除直後：慣性移動開始
    skipMovementForFrames--;
    isInertiaMode = true;
  } else {
    // 通常移動
    handleMovement(controls);
    playerPos.copy(controls.getObject().position);
    isInertiaMode = false;
  }

  // 慣性移動モードの場合は物理演算を適用
  if (isInertiaMode) {
    // 物理演算を適用した位置更新
    playerPos.add(playerVelocity.clone().multiplyScalar(delta));
  }

  // ──────────────────────────────────────────────────
  // (B) 常に適用する物理演算（重力・減衰）
  // ──────────────────────────────────────────────────
  let totalForce = gravity.clone();
  const eps = 0.1;

  // 左ワイヤーの張力計算（強化版）
  if (isGrappleLeft) {
    const dirLeft = leftAnchor.clone().sub(playerPos).normalize();
    const distLeft = playerPos.distanceTo(leftAnchor);
    const effectiveRestLength = grappleRestLength / wireTension;
    
    if (distLeft > effectiveRestLength + eps) {
      const stretchLeft = distLeft - effectiveRestLength;
      // スピード倍率と加速度ブーストを適用
      const forceLeft = dirLeft.multiplyScalar(
        grappleStrength * stretchLeft * currentSpeedMult * accelerationBoost
      );
      totalForce.add(forceLeft);
    }
    updateRopeLine(leftRope, leftAnchor);
  }

  // 右ワイヤーの張力計算（強化版）
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

  // 減衰力（スピード倍率に応じて調整）
  const dampingForce = playerVelocity.clone().multiplyScalar(-dampingCoeff / currentSpeedMult);
  totalForce.add(dampingForce);

  // ──────────────────────────────────────────────────
  // (C) 速度・位置更新（慣性移動モード対応）
  // ──────────────────────────────────────────────────
  const acceleration = totalForce.clone();
  playerVelocity.add(acceleration.multiplyScalar(delta));

  // Y方向の振動減衰（可変）
  if (isGrappleLeft || isGrappleRight || isInertiaMode) {
    playerVelocity.y *= swingDamping;
  }

  // 水平方向の速度制限（動的）
  const horiz = new THREE.Vector3(playerVelocity.x, 0, playerVelocity.z);
  const currentMaxSpeed = maxSwingSpeed * currentSpeedMult;
  if (horiz.lengthSq() > currentMaxSpeed * currentMaxSpeed) {
    const scale = currentMaxSpeed / horiz.length();
    playerVelocity.x *= scale;
    playerVelocity.z *= scale;
  }

  // 物理位置更新（慣性移動モード時は既に適用済み）
  if (!isInertiaMode) {
    playerPos.add(playerVelocity.clone().multiplyScalar(delta));
  }

  // 地面スナップ
  const groundY = 1.5;
  if (playerPos.y < groundY) {
    playerPos.y = groundY;
    playerVelocity.y = 0;
  }

  // ──────────────────────────────────────────────────
  // (D) カメラ追従（慣性移動モード対応）
  // ──────────────────────────────────────────────────
  if (isGrappleLeft || isGrappleRight || isInertiaMode) {
    // ワイヤー中/慣性移動中の追従
    const followSpeed = cameraStabilization ? 
      grappleFollowFactor * (1 + currentSpeedMult * 0.1) : 
      grappleFollowFactor;
      
    visiblePos.x = THREE.MathUtils.lerp(visiblePos.x, playerPos.x, followSpeed);
    visiblePos.z = THREE.MathUtils.lerp(visiblePos.z, playerPos.z, followSpeed);
    visiblePos.y = playerPos.y;
  } else {
    // 通常時は同期
    visiblePos.copy(playerPos);
  }

  // カメラ位置更新
  camera.position.copy(visiblePos);
  controls.getObject().position.copy(visiblePos);

  // 描画
  renderer.render(scene, camera);
}

animate();