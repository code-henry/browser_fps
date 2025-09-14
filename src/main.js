// main.js

import * as THREE from './three.module.js';
import { createScene } from './scene.js';
import { setupControls, handleMovement, handleMovementHorizontalOnly } from './controls.js';
import { PLAYER_HEIGHT, PLAYER_RADIUS, SHOOT_ENABLED } from './config.js';

// ----- 1. シーン・カメラ・レンダラーの初期化 -----
const { scene, camera, renderer, colliders } = createScene();

// ----- 2. PointerLockControls + WASD 移動 のセットアップ -----
const controls = setupControls(camera);

//
// 3. プレイヤー状態・物理パラメータ
//
let playerPos = new THREE.Vector3(0, PLAYER_HEIGHT, 0);
let playerVelocity = new THREE.Vector3(0, 0, 0);

// 重力ベクトル（毎フレーム必ず適用）
const gravity = new THREE.Vector3(0, -80.8, 0);
const gravitySmall = new THREE.Vector3(0, -4.8, 0);

// 減衰係数（空気抵抗相当）
const dampingCoeff = 1.0;





// ──────────── ここからスライディング用パラメータ ────────────
// スライディング中の摩擦係数（0.0～1.0）：1 に近いほど減衰が弱い
// let slideFriction = 0.9; // 元の設定（戻せるように保持）
let slideFriction = 0.85;   // 調整後：減速をやや強める

// スライディングを「終了」とみなす速度の下限値
let slideStopThreshold = 0.1;

// 着地（慣性→スライディング切替）時の水平速度低減係数
// const landingSpeedMultiplier = 1.0; // 元: 低減なし
const landingSpeedMultiplier = 0.8;     // 調整後：80%に減速
// ──────────── スライディング用パラメータここまで ────────────




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
// 旧ターボ機能は無効化（Shiftはダッシュ専用へ）
const turboMode = false;             // 互換のため残すが常にfalse
const turboMultiplier = 1.0;         // 効果なし
let quickReleaseBoost = 1.5;         // ワイヤー解除時の慣性ブースト

// === 追従・カメラパラメータ ===
let grappleFollowFactor = 0.3;       // 画面追従速度（0.1=遅い, 0.9=速い）
let cameraStabilization = true;      // カメラ安定化ON/OFF

//
// 5. ワイヤー関連フラグ・状態
//
let isGrappleLeft = false;
let isGrappleRight = false;
// アンカー（動的追従対応）
const leftAnchor = new THREE.Vector3();
let leftAnchorTarget = null;      // Object3D or null
let leftAnchorLocal = null;       // Vector3 (targetのローカル座標)
const rightAnchor = new THREE.Vector3();
let rightAnchorTarget = null;
let rightAnchorLocal = null;

// ※ skipMovementForFrames は廃止
let isInertiaMode = false;


let isSliding = false;

let slideJumped = false;


const visiblePos = playerPos.clone();
const hudEl = document.getElementById('hud');
const gameOverEl = document.getElementById('gameOver');
const toastEl = document.getElementById('toast');
const startOverlayEl = document.getElementById('startOverlay');
let gameStarted = false;

// ──────────────────────────────────────────────────
// プレイヤー武器（右手の棒）
// ──────────────────────────────────────────────────
let stickGroup = null;
let stickMesh = null;
let swingTimer = 0;
const swingDuration = 0.25; // 秒
initPlayerStick();
function updateStickPlacement() {
  if (!stickGroup) return;
  // カメラの近接平面上の可視幅・高さを計算し、画面比に応じて配置
  const near = camera.near;
  const v = 2 * near * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const h = v * camera.aspect;
  // 画面右下寄り（マイクラ風）: 画面比で位置を決定
  const fracX = 0.6;  // もう少し右寄りに
  const fracY = -0.5; // わずかに上へ
  const zMul = 1.8;    // 少しだけ遠ざけて近接クリップを回避
  stickGroup.position.set(h * fracX, v * fracY, -near * zMul);
}

// ワイヤー用表示ジオメトリ
let leftRope = null;
let rightRope = null;

// ダッシュ設定（クイッと方向へ上書きダッシュ）
let dashAvailable = false;                 // ワイヤーを張るとチャージ、使用で消費
const dashSpeed = 120.0;                   // 上書きダッシュの速度（大幅アップ）
const dashGraceTime = 0.5;                 // ダッシュ直後の速度クランプ/減衰無効時間
let dashGraceTimer = 0.0;                  // 残り時間

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

// ──────────────────────────────────────────────────
// 敵（細身ロボット）
// ──────────────────────────────────────────────────
const ENEMY_COUNT = 10;
const ENEMY_TOTAL = ENEMY_COUNT;
const ENEMY_SPEED = 7.0;
const ENEMY_TURN = Math.PI * 0.35; // 障害物ヒット時の回頭角
const ENEMY_RADIUS = 3.5;          // 当たり半径（AABBとの判定用）
const ENEMY_SIGHT_RANGE = 140.0;   // 視認/攻撃範囲
const ENEMY_FIRE_INTERVAL = 0.25;  // 連射間隔（秒）
const ENEMY_BULLET_SPEED = 45.0;   // 弾速度
const ENEMY_BULLET_RADIUS = 0.3;   // 弾の半径（当たり）

function createThinRobot() {
  const g = new THREE.Group();
  const color = 0x99ccff;
  const edgeColor = 0x000000;

  const torsoW = 4, torsoH = 16, torsoD = 4;
  const head = 6;
  const armLen = 8, armThick = 2, armDepth = 2; // 腕は前ならえ（地面と水平で前方へ）

  const torsoGeo = new THREE.BoxGeometry(torsoW, torsoH, torsoD);
  const mat = new THREE.MeshStandardMaterial({ color });
  const torso = new THREE.Mesh(torsoGeo, mat);
  torso.castShadow = true; torso.receiveShadow = true;
  torso.userData.enemy = true; torso.userData.part = 'torso';
  g.add(torso);
  const torsoEdges = new THREE.EdgesGeometry(torsoGeo);
  g.add(new THREE.LineSegments(torsoEdges, new THREE.LineBasicMaterial({ color: edgeColor })));

  const headGeo = new THREE.BoxGeometry(head, head, head);
  const headMesh = new THREE.Mesh(headGeo, mat);
  headMesh.castShadow = true; headMesh.receiveShadow = true;
  headMesh.position.y = (torsoH / 2) + (head / 2);
  headMesh.userData.enemy = true; headMesh.userData.part = 'head';
  g.add(headMesh);
  const headEdges = new THREE.EdgesGeometry(headGeo);
  const headLine = new THREE.LineSegments(headEdges, new THREE.LineBasicMaterial({ color: edgeColor }));
  headLine.position.copy(headMesh.position);
  g.add(headLine);

  // 腕（胴体の横に配置し、常にプレイヤーの方向へ向ける）。
  // 肩のピボットを作り、その+Z方向に腕メッシュを置く（回転で向けやすい）。
  const armGeo = new THREE.BoxGeometry(armThick, armThick, armLen);
  const armY = torsoH * 0.6 - torsoH / 2; // 胴体中心基準の高さ

  const shoulderL = new THREE.Group();
  shoulderL.position.set(-torsoW / 2, armY, 0);
  const armL = new THREE.Mesh(armGeo, mat);
  armL.castShadow = true; armL.receiveShadow = true;
  armL.position.set(0, 0, armLen / 2);
  armL.userData.enemy = true; armL.userData.part = 'arm';
  shoulderL.add(armL);
  g.add(shoulderL);
  const armLE = new THREE.EdgesGeometry(armGeo);
  const armLL = new THREE.LineSegments(armLE, new THREE.LineBasicMaterial({ color: edgeColor }));
  armLL.position.copy(armL.position);
  shoulderL.add(armLL);

  const shoulderR = new THREE.Group();
  shoulderR.position.set(torsoW / 2, armY, 0);
  const armR = new THREE.Mesh(armGeo, mat);
  armR.castShadow = true; armR.receiveShadow = true;
  armR.position.set(0, 0, armLen / 2);
  armR.userData.enemy = true; armR.userData.part = 'arm';
  shoulderR.add(armR);
  g.add(shoulderR);
  const armRE = new THREE.EdgesGeometry(armGeo);
  const armRL = new THREE.LineSegments(armRE, new THREE.LineBasicMaterial({ color: edgeColor }));
  armRL.position.copy(armR.position);
  shoulderR.add(armRL);

  // グループ配下の全Meshを sceneObjects に登録（ワイヤー対象にする）
  const meshes = [torso, headMesh, armL, armR];
  for (const m of meshes) sceneObjects.push(m);

  return { group: g, torsoH, meshes, shoulderL, shoulderR };
}

function aabbHit(x, z, r, aabbs) {
  for (const c of aabbs) {
    if (x > c.minX - r && x < c.maxX + r && z > c.minZ - r && z < c.maxZ + r) return true;
  }
  return false;
}

function spawnEnemies(count) {
  const arr = [];
  for (let i = 0; i < count; i++) {
    const { group, torsoH, meshes, shoulderL, shoulderR } = createThinRobot();
    // ランダムスポーン（木と被らないように試行）
    let px = 0, pz = 0; let tries = 0;
    do {
      px = (Math.random() * 2 - 1) * (300 - 20);
      pz = (Math.random() * 2 - 1) * (300 - 20);
      tries++;
      if (tries > 200) break;
    } while (aabbHit(px, pz, ENEMY_RADIUS, colliders));

    group.position.set(px, torsoH / 2, pz);
    scene.add(group);
    arr.push({ group, dir: Math.random() * Math.PI * 2, speed: ENEMY_SPEED, meshes, shoulderL, shoulderR, fireCooldown: Math.random()*ENEMY_FIRE_INTERVAL });
  }
  return arr;
}

const enemies = spawnEnemies(ENEMY_COUNT);

//
// 6. ワイヤー関連の関数
//
function createRopeLine(side, anchor) {
  // ここでは必ず playerPos を始点にする
  const p0 = playerPos.clone();
  const p1 = anchor.clone();
  const geometry = new THREE.BufferGeometry().setFromPoints([p0, p1]);
  const material = new THREE.LineBasicMaterial({
    color: side === 'left' ? 0x00ff00 : 0xff0000,
    linewidth: 3
  });
  const line = new THREE.Line(geometry, material);
  scene.add(line);
  return line;
}

function updateRopeLine(rope, anchor) {
  if (!rope) return;
  const p0 = playerPos.clone();
  const p1 = anchor.clone();
  rope.geometry.setFromPoints([p0, p1]);
  rope.geometry.attributes.position.needsUpdate = true;
}

function deployWire(isLeft) {
  // (1) playerPos を最新に同期
  playerPos.copy(controls.getObject().position);

  // (2) レイキャストを飛ばす
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  const intersects = raycaster.intersectObjects(sceneObjects);
  if (intersects.length === 0) return;

  const hit = intersects[0];
  const hitPoint = hit.point.clone();

  if (isLeft) {
    leftAnchor.copy(hitPoint);
    if (hit.object && hit.object.userData && hit.object.userData.enemy) {
      leftAnchorTarget = hit.object;
      leftAnchorLocal = hit.object.worldToLocal(hitPoint.clone());
    } else { leftAnchorTarget = null; leftAnchorLocal = null; }
    isGrappleLeft = true;

    // (3) 最初にラインを作成
    leftRope = createRopeLine('left', leftAnchor);

    // （ここで即座に updateRopeLine を呼んで、同じフレーム内で「playerPos→アンカー」に上書きする）
    updateRopeLine(leftRope, leftAnchor);

    console.log('Left wire deployed to building at:', leftAnchor);
  } else {
    rightAnchor.copy(hitPoint);
    if (hit.object && hit.object.userData && hit.object.userData.enemy) {
      rightAnchorTarget = hit.object;
      rightAnchorLocal = hit.object.worldToLocal(hitPoint.clone());
    } else { rightAnchorTarget = null; rightAnchorLocal = null; }
    isGrappleRight = true;

    rightRope = createRopeLine('right', rightAnchor);
    updateRopeLine(rightRope, rightAnchor);

    console.log('Right wire deployed to building at:', rightAnchor);
  }
  // ダッシュをリチャージ
  dashAvailable = true;
}


//
// 7. リアルタイムパラメータ調整用キーボードショートカット + ダッシュ
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

  // Shift: ワイヤー解除（右のみ）+ 空中限定の単発ダッシュ（旧ターボ一時適用）
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
    tryDash();
  }


  if (e.code === 'Space' && isSliding) {
    // 「まだスライド中」のまま、垂直だけ飛ぶ
    slideJumped = true;             // ジャンプ開始をマーク
    // isSliding はそのまま true のまま維持
    // isInertiaMode は使わない
  }


});

window.addEventListener('keyup', (e) => {
  // Shiftは単発動作のため、keyupでは何もしない
});

// レスポンシブ対応：ウィンドウサイズ変更でレンダラー/カメラ更新
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  updateStickPlacement();
});

//
// 8. アニメーションループ（慣性追加版）
//
let prevTime = performance.now();
let gameOver = false;


function animate() {
  if (!gameOver) requestAnimationFrame(animate);

  const time = performance.now();
  const delta = (time - prevTime) / 1000;
  prevTime = time;

  // 開始前は静止画レンダリングのみ
  if (!gameStarted) {
    renderer.render(scene, camera);
    return;
  }

  if (gameOver) {
    renderer.render(scene, camera);
    return;
  }


  // ターボ無効。ダッシュは瞬間上書き式なので倍率は一定
  const currentSpeedMult = grappleSpeedMultiplier;

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
  // アンカーを動的ターゲットに追従
  refreshAnchors();

  // 1) 合計力の初期化（重力をコピー）
  const totalForce = gravity.clone();
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
  // ダッシュ直後は減衰を無効化して初速を殺さない
  if (dashGraceTimer <= 0) {
    const dampingForceHoriz = horizVel.multiplyScalar(-dampingCoeff / currentSpeedMult);
    totalForce.add(dampingForceHoriz);
  }

  // 6) 速度更新
  const acceleration = totalForce.clone();
  playerVelocity.add(acceleration.multiplyScalar(delta));

  // 7) Y方向（垂直）のスイング減衰
  // if (isGrappleLeft || isGrappleRight || isInertiaMode) {
  //   playerVelocity.y *= swingDamping;
  // }

  if (isGrappleLeft || isGrappleRight) {
    playerVelocity.y *= swingDamping;
  }



  // 8) 水平速度制限
  const horiz = new THREE.Vector3(playerVelocity.x, 0, playerVelocity.z);
  const currentMaxSpeed = maxSwingSpeed * currentSpeedMult;
  if (dashGraceTimer <= 0) {
    if (horiz.lengthSq() > currentMaxSpeed * currentMaxSpeed) {
      const scale = currentMaxSpeed / horiz.length();
      playerVelocity.x *= scale;
      playerVelocity.z *= scale;
    }
  }

  // (C) 位置更新＆着地判定：
  //   • ワイヤー中 … 全成分（x,y,z） velocity 適用
  //   • 慣性中 … 空中で重力＋減衰による自由落下 → 床着地したらスライディング移行
  //   • スライディング中 … 垂直成分をゼロにして床に張り付け、水平成分だけ慣性継続
  //   • 通常移動 … handleMovement() による位置更新
  // ──────────────────────────────────────────────────

  const groundY = PLAYER_HEIGHT;
  if (playerPos.y - 1 <= groundY) {
    slideJumped = false; // ジャンプフェーズ終了
    // isSliding は true のまま ← 再びスライドフェーズ継続
  }


  if (isGrappleLeft || isGrappleRight) {
    // 【ワイヤー中】
    // 地面チェックなしで位置更新（トンネリング防止にXZをサブステップで解決）
    moveXZWithCollisions(playerPos, playerVelocity.x, playerVelocity.z, delta, colliders);
    playerPos.y += playerVelocity.y * delta;
  }
  else if (isInertiaMode) {
    // 【慣性中】
    const nextY = playerPos.y + playerVelocity.y * delta;
    if (nextY < groundY) {
      // “着地した瞬間” → 垂直速度を止め、水平速度だけスライディングに移行
      playerPos.y = groundY;
      playerVelocity.y = 0;
      // 着地時に水平速度を軽減
      // （元: 低減なし。戻す場合は次の2行を削除 or landingSpeedMultiplier を 1.0 に）
      playerVelocity.x *= landingSpeedMultiplier;
      playerVelocity.z *= landingSpeedMultiplier;
      isInertiaMode = false;
      isSliding = true;    // ここからスライディングフェーズへ
    } else {
      // 空中：自由落下（垂直＋水平）で位置更新
      moveXZWithCollisions(playerPos, playerVelocity.x, playerVelocity.z, delta, colliders);
      playerPos.y += playerVelocity.y * delta;
    }
  }
  else if (isSliding) {
    // 【新スライディング】1) まず handleMovement で WASD/ジャンプ を反映
    console.log("isSliding")

    handleMovementHorizontalOnly(controls);
    playerPos.copy(controls.getObject().position);

    // 2) 垂直は必ず groundY に固定（地面に張り付け）
    // playerPos.y = groundY;

    // 3) そこに「水平慣性分」を追加する
    moveXZWithCollisions(playerPos, playerVelocity.x, playerVelocity.z, delta, colliders);

    // 4) 摩擦的減衰（フリクション）を水平速度にかける
    playerVelocity.x *= slideFriction;
    playerVelocity.z *= slideFriction;


    if (slideJumped) {
      // playerVelocity.y += -gravity.y * 0.05;
      // playerPos.y += playerVelocity.y * delta;
      // もし計算順序上ここで重力を追加したい場合は
      // playerVelocity.add(gravitySmall.clone().multiplyScalar(delta));
      // を入れてください。
      // ────────────

      // 着地判定：「飛び上がったあとの落下中に地面を下回るなら再びスライドへ」

    }



    // 5) 水平速度が閾値未満になったらスライディング終了
    if (Math.abs(playerVelocity.x) < slideStopThreshold && Math.abs(playerVelocity.z) < slideStopThreshold) {
      isSliding = false;
      console.log("isSliding OFF")
      // スライド終了と同時に、controls.getObject().position を playerPos に合わせておく
      controls.getObject().position.copy(playerPos);
    } else {
      // スライド中は、controls の位置も playerPos と同期しておく
      controls.getObject().position.copy(playerPos);
    }
  }

  // 通常移動モードでは handleMovement(controls) が playerPos を更新している

  // 敵の移動更新（単純な回避・バウンス）
  updateEnemies(delta);
  // 弾幕更新
  updateBullets(delta);

  // 棒のアニメ更新
  updatePlayerStick(delta);
  // 比率に応じた棒の位置更新（FOVやウィンドウサイズ変更にも追従）
  updateStickPlacement();

  // ──────────────────────────────────────────────────
  // (D) 地面スナップ ＆ 着地判定
  // ──────────────────────────────────────────────────

  if (playerPos.y < groundY) {
    playerPos.y = groundY;
    playerVelocity.y = 0;
    // 着地したら慣性モードを終了
    if (isInertiaMode) {
      isInertiaMode = false;
    }
  }

  // ──────────────────────────────────────────────────
  // (D2) 衝突判定（木＝直方体と衝突）
  // ──────────────────────────────────────────────────
  resolveCollisions2D(playerPos, PLAYER_RADIUS, colliders);

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
  // ダッシュ猶予の減衰
  if (dashGraceTimer > 0) dashGraceTimer -= delta;

  visiblePos.y = Math.max(visiblePos.y, groundY);

  camera.position.copy(visiblePos);
  // 物理の実体は playerPos にスナップ（可視はカメラのみスムージング）
  controls.getObject().position.copy(playerPos);

  // HUD 更新
  if (hudEl) {
    const groundY = PLAYER_HEIGHT;
    const airborne = (playerPos.y > groundY + 0.01) || isGrappleLeft || isGrappleRight;
    hudEl.textContent = `Enemies:${enemies.length}/${ENEMY_TOTAL}  |  Dash:${dashAvailable ? 'READY' : '—'}  Air:${airborne ? 'YES' : 'NO'}  L:${isGrappleLeft?'1':'0'} R:${isGrappleRight?'1':'0'}`;
  }




  // ──────────────────────────────────────────────────
  // (F) レンダリング
  // ──────────────────────────────────────────────────
  renderer.render(scene, camera);
}

















// ──────────────────────────────────────────────────
// 9.「スコープ切り替え」＆「射撃」イベントリスナーを追加
// ──────────────────────────────────────────────────

// 2つの状態を管理するフラグとパラメータ
let isScoped = false;
const normalFov = camera.fov;       // デフォルトの画角
const zoomedFov = normalFov / 2;    // スコープ時の画角（好みで調整してください）
const scopeOverlay = document.getElementById('scopeOverlay');

// マウス右クリックでスコープON → コンテキストメニューを無効化
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();  // 右クリックメニューを抑止
  if (!gameStarted) return; // 開始前は無効
  // スコープON（近接キルは左クリックに移行）
  if (!isScoped) {
    isScoped = true;
    camera.fov = zoomedFov;
    camera.updateProjectionMatrix();
    scopeOverlay.style.display = 'block';
  }
});

window.addEventListener('mouseup', (e) => {
  if (!gameStarted) return;
  if (e.button === 2 && isScoped) {
    isScoped = false;
    camera.fov = normalFov;
    camera.updateProjectionMatrix();
    scopeOverlay.style.display = 'none';
  }
});

// ──────────────────────────────────────────────────
// 10.「左クリックで射撃（Raycast）」を実装
// ──────────────────────────────────────────────────

// ヒットマーカー用のメッシュを用意しておく（簡易的に小さな球を衝突点に表示する例）
const hitMarkerGeometry = new THREE.SphereGeometry(0.2, 8, 8);
const hitMarkerMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 });
let tempHitMarker = null;  // 直前のヒットマーカーを保持する

window.addEventListener('mousedown', (e) => {
  if (!gameStarted) {
    // クリックで開始（PointerLockは既存のcontrolsが担当）
    gameStarted = true;
    if (startOverlayEl) startOverlayEl.style.display = 'none';
    return;
  }
  if (e.button === 0) {
    // 左クリック：ヘッドショット（近距離シューター）→ 棒を振る
    tryHeadshot();
    swingTimer = swingDuration;
  }
});

// ──────────────────────────────────────────────────
// 11. 衝突解決関数（XZ平面のAABBに対する円の押し戻し）
// ──────────────────────────────────────────────────
function resolveCollisions2D(pos, radius, aabbs) {
  for (const c of aabbs) {
    // プレイヤーの高さが建物の高さ以下にあるとみなし、XZのみチェック
    if (
      pos.x > c.minX - radius && pos.x < c.maxX + radius &&
      pos.z > c.minZ - radius && pos.z < c.maxZ + radius
    ) {
      const pushLeft = pos.x - (c.minX - radius);
      const pushRight = (c.maxX + radius) - pos.x;
      const pushTop = pos.z - (c.minZ - radius);
      const pushBottom = (c.maxZ + radius) - pos.z;

      const minPush = Math.min(pushLeft, pushRight, pushTop, pushBottom);
      if (minPush === pushLeft) pos.x = c.minX - radius;
      else if (minPush === pushRight) pos.x = c.maxX + radius;
      else if (minPush === pushTop) pos.z = c.minZ - radius;
      else pos.z = c.maxZ + radius;
    }
  }
}

// 近接ヘッドショット（右クリック）で敵を撃破
const SHOOT_RANGE = 25.0; // 一定範囲内のみ射撃（ヘッドショット）
function tryHeadshot() {
  if (gameOver) return false;
  const ray = new THREE.Raycaster();
  const origin = camera.getWorldPosition(new THREE.Vector3());
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
  ray.set(origin, dir);
  const hits = ray.intersectObjects(sceneObjects);
  if (!hits || hits.length === 0) return false;

  // 最初にヒットしたheadを拾う（距離制限あり、木遮蔽あり）
  const headHit = hits.find(h => h.object && h.object.userData && h.object.userData.enemy && h.object.userData.part === 'head');
  if (!headHit) return false;

  const dist = origin.distanceTo(headHit.point);
  if (dist > SHOOT_RANGE) return false;
  // 木で遮られていたらNG
  if (!lineOfSight(origin, headHit.point, colliders)) return false;

  const grp = headHit.object.parent;
  const removed = [];
  grp.traverse((n) => { if (n.isMesh) removed.push(n); });
  for (const m of removed) {
    const idx = sceneObjects.indexOf(m);
    if (idx >= 0) sceneObjects.splice(idx, 1);
  }
  for (let i = enemies.length - 1; i >= 0; i--) {
    if (enemies[i].group === grp) enemies.splice(i, 1);
  }
  scene.remove(grp);
  console.log('Enemy down (headshot)');
  showToast('ENEMY DOWN');
  return true;
}

function triggerGameOver() {
  if (gameOver) return;
  gameOver = true;
  // 止める
  playerVelocity.set(0, 0, 0);
  // HUD/Overlay
  if (gameOverEl) {
    gameOverEl.innerHTML = 'GAME OVER<br>Rキーでリスタート';
    gameOverEl.style.display = 'flex';
  }
}

// Rキーでリスタート
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyR' && gameOver) {
    resetGame();
  }
});

function resetGame() {
  // オーバーレイ非表示
  if (gameOverEl) gameOverEl.style.display = 'none';
  gameOver = false;

  // スコープ解除
  if (isScoped) {
    isScoped = false;
    camera.fov = normalFov;
    camera.updateProjectionMatrix();
    scopeOverlay.style.display = 'none';
  }

  // 弾を全消去
  if (typeof bullets !== 'undefined') {
    for (let i = bullets.length - 1; i >= 0; i--) {
      removeBulletAt(i);
    }
  }

  // 敵を全消去
  if (typeof enemies !== 'undefined') {
    for (let i = enemies.length - 1; i >= 0; i--) {
      const grp = enemies[i].group;
      scene.remove(grp);
    }
    enemies.length = 0;
  }
  // sceneObjects から敵メッシュを除外
  for (let i = sceneObjects.length - 1; i >= 0; i--) {
    const o = sceneObjects[i];
    if (o.userData && o.userData.enemy) sceneObjects.splice(i, 1);
  }
  // 敵を再スポーン
  const newEnemies = spawnEnemies(ENEMY_COUNT);
  // 参照を更新
  enemies.push(...newEnemies);

  // ワイヤー解除
  isGrappleLeft = false; isGrappleRight = false;
  leftAnchorTarget = null; leftAnchorLocal = null;
  rightAnchorTarget = null; rightAnchorLocal = null;
  if (leftRope) { scene.remove(leftRope); leftRope.geometry.dispose(); leftRope.material.dispose(); leftRope = null; }
  if (rightRope) { scene.remove(rightRope); rightRope.geometry.dispose(); rightRope.material.dispose(); rightRope = null; }

  // プレイヤーを初期化
  playerPos.set(0, PLAYER_HEIGHT, 0);
  playerVelocity.set(0, 0, 0);
  isInertiaMode = false; isSliding = false; slideJumped = false;
  controls.getObject().position.copy(playerPos);
  camera.position.copy(playerPos);
  visiblePos.copy(playerPos);

  // ダッシュ・HUD等
  dashAvailable = false; dashGraceTimer = 0;
  swingTimer = 0; if (stickMesh) { stickMesh.rotation.set(0, 0, 0); }
  updateStickPlacement();

  // ループ再開
  animate();
}

function initPlayerStick() {
  // カメラに追随させる
  stickGroup = new THREE.Group();
  // もっと縦に、かつ自分側（手前）に寄せて持ち手を見せる
  stickGroup.position.set(0.44, -0.10, -0.28);
  stickGroup.rotation.set(-0.15, 0.06, 0);
  camera.add(stickGroup);
  // 新モデルで再構築して旧処理はスキップ
  buildStickModel();
  stickGroup.rotation.set(-0.35, 0.12, 0.04);
  updateStickPlacement();
  return;

  // 縦棒: 上半分（色強め）、下半分（黒）
  const halfLen = 0.50;            // さらに短く
  const width = 0.02, depth = 0.02; // さらに細く
  const geomUpper = new THREE.BoxGeometry(width, halfLen, depth);
  const geomLower = new THREE.BoxGeometry(width, halfLen, depth);
  const matUpper = new THREE.MeshBasicMaterial({ color: 0xffcc33 }); // 視認性の高い黄
  const matLower = new THREE.MeshBasicMaterial({ color: 0x111111 }); // 黒

  const upper = new THREE.Mesh(geomUpper, matUpper);
  const lower = new THREE.Mesh(geomLower, matLower);

  for (const m of [upper, lower]) {
    m.renderOrder = 999; m.material.depthTest = false; m.castShadow = false; m.receiveShadow = false;
  }

  // カメラ座標系でYが上。上半分を上へ、下半分を下へ配置して1本の棒に見せる。
  upper.position.set(0, halfLen * 0.5, 0);
  lower.position.set(0, -halfLen * 0.5, 0);

  const stick = new THREE.Group();
  stick.add(upper);
  stick.add(lower);
  // 手元の握り位置を少し下げて右に寄せる
  // グリップ位置をわずかに手前・内側に（配置は updateStickPlacement が管理）
  stick.position.set(0.02, -0.08, 0.0);
  stickGroup.add(stick);
  stickMesh = stick; // 参照保持
  // 全体スケールを控えめに（全体的に小さく表示）
  stickGroup.scale.setScalar(0.85);
}

function updatePlayerStick(delta) {
  if (!stickGroup) return;
  if (swingTimer > 0) {
    swingTimer = Math.max(0, swingTimer - delta);
    const t = 1 - (swingTimer / swingDuration); // 0→1
    // マイクラ風: 上から下へ強く振り下ろす（グループごと回す）
    const ease = t < 0.6 ? (t / 0.6) : 1 - (t - 0.6) / 0.4 * 0.2;
    const angleDown = -0.15 - ease * 2.55; // -0.15 → およそ -2.7rad まで下げる
    stickGroup.rotation.x = angleDown;
    stickGroup.rotation.y = 0.1; // わずかに外へ
  } else {
    // 待機姿勢に戻す（少し傾けた縦構え）
    stickGroup.rotation.x = THREE.MathUtils.lerp(stickGroup.rotation.x, -0.35, 0.25);
    stickGroup.rotation.y = THREE.MathUtils.lerp(stickGroup.rotation.y, 0.12, 0.25);
  }
}

// 新しい棒モデル（短い黒い取っ手＋短い木のシャフト＋明色の先端）
function buildStickModel() {
  if (!stickGroup) return;
  // 既存の子を除去
  while (stickGroup.children.length) {
    const c = stickGroup.children.pop();
    c.traverse && c.traverse(n => {
      if (n.isMesh) { n.geometry && n.geometry.dispose && n.geometry.dispose(); }
    });
  }
  const width = 0.012, depth = 0.012;
  const gripLen = 0.05, shaftLen = 0.16;
  const matGrip = new THREE.MeshBasicMaterial({ color: 0x111111 });
  const matShaft = new THREE.MeshBasicMaterial({ color: 0xffcc33 });
  // 先端パーツは不要
  const meshGrip = new THREE.Mesh(new THREE.BoxGeometry(width, gripLen, depth), matGrip);
  const meshShaft = new THREE.Mesh(new THREE.BoxGeometry(width, shaftLen, depth), matShaft);
  for (const m of [meshGrip, meshShaft]) { m.renderOrder = 999; m.material.depthTest = false; }
  // 縦方向に配置（Y上）
  meshGrip.position.set(0, -(gripLen * 0.5), 0);
  // 取っ手の上端とシャフトの下端がピッタリ合うように
  meshShaft.position.set(0, (shaftLen * 0.5), 0);
  const stick = new THREE.Group();
  stick.add(meshGrip); stick.add(meshShaft);
  stick.position.set(0.01, -0.02, 0.0);
  stickGroup.add(stick);
  stickMesh = stick; // 参照保持（未使用）
}

function showToast(msg) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.style.opacity = '1';
  setTimeout(() => { toastEl.style.opacity = '0'; }, 900);
}

function refreshAnchors() {
  if (leftAnchorTarget && leftAnchorLocal) {
    if (!leftAnchorTarget.parent) {
      // ターゲットが消えたら解除
      isGrappleLeft = false;
      leftAnchorTarget = null; leftAnchorLocal = null;
      if (leftRope) { scene.remove(leftRope); leftRope.geometry.dispose(); leftRope.material.dispose(); leftRope = null; }
    } else {
      const wp = leftAnchorTarget.localToWorld(leftAnchorLocal.clone());
      leftAnchor.copy(wp);
    }
  }
  if (rightAnchorTarget && rightAnchorLocal) {
    if (!rightAnchorTarget.parent) {
      isGrappleRight = false;
      rightAnchorTarget = null; rightAnchorLocal = null;
      if (rightRope) { scene.remove(rightRope); rightRope.geometry.dispose(); rightRope.material.dispose(); rightRope = null; }
    } else {
      const wp = rightAnchorTarget.localToWorld(rightAnchorLocal.clone());
      rightAnchor.copy(wp);
    }
  }
}

// ダッシュ実行ロジック
function tryDash() {
  // 条件: チャージあり、かつ（ワイヤー接続中 or 空中）、かつ地上/スライドではない
  const groundY = PLAYER_HEIGHT;
  const airborne = (playerPos.y > groundY + 0.01) || isGrappleLeft || isGrappleRight;
  if (!dashAvailable || !airborne || isSliding) {
    console.log('Dash unavailable');
    return;
  }

  // 右ワイヤーのみ解除（ブーストは付与しない）
  if (isGrappleRight) {
    isGrappleRight = false;
    isInertiaMode = true;
    if (rightRope) {
      scene.remove(rightRope);
      rightRope.geometry.dispose();
      rightRope.material.dispose();
      rightRope = null;
    }
    console.log('Right wire released by dash');
  }

  // 見ている方向にクイッと上書きダッシュ（慣性リセット）
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
  playerVelocity.copy(dir.multiplyScalar(dashSpeed));
  // 物理統治に移行（通常移動で上書きされないように）
  isInertiaMode = true;
  dashGraceTimer = dashGraceTime;
  dashAvailable = false; // 消費
  console.log('Dash override!');
}

// XZ 平面の移動をサブステップで行い、各サブステップでコリジョン解決してトンネリングを防ぐ
function moveXZWithCollisions(pos, vx, vz, delta, aabbs) {
  const horizSpeed = Math.hypot(vx, vz);
  // 1ステップあたりの許容移動距離を 1.5 に設定（薄い木も抜けにくく）
  const maxStep = 1.5;
  const steps = Math.max(1, Math.ceil((horizSpeed * delta) / maxStep));
  const dt = delta / steps;
  for (let i = 0; i < steps; i++) {
    pos.x += vx * dt;
    pos.z += vz * dt;
    resolveCollisions2D(pos, PLAYER_RADIUS, aabbs);
  }
}

// 敵の更新（シンプルな回避: 次位置が当たるなら回頭して進路変更）
function updateEnemies(delta) {
  const bounds = 300;
  for (const e of enemies) {
    // 腕をプレイヤー方向に向ける（一定距離内のとき）
    const toPlayer = new THREE.Vector3().subVectors(playerPos, e.group.position);
    const dist = toPlayer.length();
    if (dist < ENEMY_SIGHT_RANGE) {
      const target = playerPos.clone();
      e.shoulderL.lookAt(target);
      e.shoulderR.lookAt(target);
    }

    // ランダムなふらつき
    if (Math.random() < 0.02) e.dir += (Math.random() - 0.5) * 0.5;

    const step = e.speed * delta;
    let nx = e.group.position.x + Math.cos(e.dir) * step;
    let nz = e.group.position.z + Math.sin(e.dir) * step;

    let turns = 0;
    while ((aabbHit(nx, nz, ENEMY_RADIUS, colliders) || Math.abs(nx) > bounds || Math.abs(nz) > bounds) && turns < 12) {
      e.dir += (Math.random() < 0.5 ? 1 : -1) * ENEMY_TURN;
      nx = e.group.position.x + Math.cos(e.dir) * step;
      nz = e.group.position.z + Math.sin(e.dir) * step;
      turns++;
    }

    // サブステップで滑らかに進む＆すり抜け回避
    const parts = Math.max(1, Math.ceil(step / 1.0));
    for (let i = 0; i < parts; i++) {
      const sx = e.group.position.x + Math.cos(e.dir) * (step / parts);
      const sz = e.group.position.z + Math.sin(e.dir) * (step / parts);
      if (!aabbHit(sx, sz, ENEMY_RADIUS, colliders) && Math.abs(sx) <= bounds && Math.abs(sz) <= bounds) {
        e.group.position.x = sx;
        e.group.position.z = sz;
      } else {
        // 衝突したら軽く回頭
        e.dir += ENEMY_TURN * 0.5;
        break;
      }
    }

    // 攻撃（距離内なら弾幕発射）
    e.fireCooldown -= delta;
    if (dist < ENEMY_SIGHT_RANGE && e.fireCooldown <= 0) {
      fireVolley(e);
      e.fireCooldown = ENEMY_FIRE_INTERVAL;
    }
  }
}

// ──────────────────────────────────────────────────
// 弾幕（弾プール）
// ──────────────────────────────────────────────────
const bulletGeo = new THREE.SphereGeometry(ENEMY_BULLET_RADIUS, 8, 8);
const bulletMat = new THREE.MeshBasicMaterial({ color: 0xff5533 });
const bullets = [];
const MAX_BULLETS = 1500;

function spawnBullet(pos, vel) {
  if (bullets.length >= MAX_BULLETS) return;
  const m = new THREE.Mesh(bulletGeo, bulletMat);
  m.position.copy(pos);
  scene.add(m);
  bullets.push({ mesh: m, vel: vel.clone(), alive: true });
}

function fireVolley(e) {
  // 直進単発弾のみ。LOS（木に遮られていない）と距離条件を満たす肩から撃つ。
  const originL = e.shoulderL.localToWorld(new THREE.Vector3(0, 0, 0));
  const originR = e.shoulderR.localToWorld(new THREE.Vector3(0, 0, 0));
  const distL = originL.distanceTo(playerPos);
  const distR = originR.distanceTo(playerPos);
  if (distL < ENEMY_SIGHT_RANGE && lineOfSight(originL, playerPos, colliders)) {
    const dir = new THREE.Vector3().subVectors(playerPos, originL).normalize().multiplyScalar(ENEMY_BULLET_SPEED);
    spawnBullet(originL, dir);
  }
  if (distR < ENEMY_SIGHT_RANGE && lineOfSight(originR, playerPos, colliders)) {
    const dir = new THREE.Vector3().subVectors(playerPos, originR).normalize().multiplyScalar(ENEMY_BULLET_SPEED);
    spawnBullet(originR, dir);
  }
}

function updateBullets(delta) {
  const groundY = PLAYER_HEIGHT;
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    if (!b.alive) { removeBulletAt(i); continue; }

    // サブステップで移動＋衝突
    const stepLen = 1.0;
    const speed = b.vel.length();
    const steps = Math.max(1, Math.ceil((speed * delta) / stepLen));
    const dt = delta / steps;
    let pos = b.mesh.position.clone();
    let alive = true;
    for (let s = 0; s < steps; s++) {
      pos.addScaledVector(b.vel, dt);
      // 木のAABB衝突（高さ内のみ）
      if (bulletHitColliders(pos, ENEMY_BULLET_RADIUS, colliders)) { alive = false; break; }
      // プレイヤー当たり
      const toPlayer = pos.clone().sub(playerPos);
      if (toPlayer.length() <= (PLAYER_RADIUS + ENEMY_BULLET_RADIUS) && playerPos.y >= groundY - 0.01) {
        triggerGameOver();
        alive = false; break;
      }
      // 領域外
      if (Math.abs(pos.x) > 400 || Math.abs(pos.z) > 400 || pos.y < 0 || pos.y > 200) { alive = false; break; }
    }
    if (!alive) { removeBulletAt(i); continue; }
    b.mesh.position.copy(pos);
  }
}

// origin→target の直線が木AABBに遮られているかをチェック
function lineOfSight(origin, target, aabbs) {
  const dir = new THREE.Vector3().subVectors(target, origin);
  const dist = dir.length();
  if (dist === 0) return true;
  dir.multiplyScalar(1 / dist);
  const step = 1.0; // 1m刻みでサンプル
  const steps = Math.max(1, Math.ceil(dist / step));
  for (let i = 1; i <= steps; i++) { // origin直近は除外
    const p = origin.clone().addScaledVector(dir, i * (dist / steps));
    for (const c of aabbs) {
      // 高さ条件：弾の高さがAABB上面より上なら遮らない
      if (p.y > c.maxY + ENEMY_BULLET_RADIUS) continue;
      if (p.x >= c.minX - ENEMY_BULLET_RADIUS && p.x <= c.maxX + ENEMY_BULLET_RADIUS &&
          p.z >= c.minZ - ENEMY_BULLET_RADIUS && p.z <= c.maxZ + ENEMY_BULLET_RADIUS) {
        return false; // 遮られた
      }
    }
  }
  return true;
}

function bulletHitColliders(p, r, aabbs) {
  for (const c of aabbs) {
    if (p.y > c.maxY + r) continue; // 高さを超えていれば無視
    if (p.x > c.minX - r && p.x < c.maxX + r && p.z > c.minZ - r && p.z < c.maxZ + r) return true;
  }
  return false;
}

function removeBulletAt(i) {
  const b = bullets[i];
  scene.remove(b.mesh);
  b.mesh.geometry.dispose(); // 共有でも小サイズなのでOK
  b.mesh.material.dispose();
  bullets.splice(i, 1);
}

// start the loop after all declarations are loaded
animate();
