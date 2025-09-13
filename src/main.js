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
const ENEMY_COUNT = 5;
const ENEMY_SPEED = 7.0;
const ENEMY_TURN = Math.PI * 0.35; // 障害物ヒット時の回頭角
const ENEMY_RADIUS = 3.5;          // 当たり半径（AABBとの判定用）
const ENEMY_SIGHT_RANGE = 140.0;   // 視認/攻撃範囲
const ENEMY_FIRE_INTERVAL = 0.35;  // 連射間隔（秒）
const ENEMY_BURST_COUNT = 18;      // 1度に撃つ弾数（扇形）
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
    hudEl.textContent = `Dash:${dashAvailable ? 'READY' : '—'}  Air:${airborne ? 'YES' : 'NO'}  L:${isGrappleLeft?'1':'0'} R:${isGrappleRight?'1':'0'}`;
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
  // まず至近距離キル判定
  if (tryCloseKill()) return;
  // 近接キルでなければスコープON
  if (!isScoped) {
    isScoped = true;
    camera.fov = zoomedFov;
    camera.updateProjectionMatrix();
    scopeOverlay.style.display = 'block';
  }
});

window.addEventListener('mouseup', (e) => {
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
  if (e.button === 0 && SHOOT_ENABLED) {
    // 左クリックのシュート機能は一時無効（フラグでONにできる）
    // ...（元の実装は保持）
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
function tryCloseKill() {
  const ray = new THREE.Raycaster();
  const origin = camera.getWorldPosition(new THREE.Vector3());
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
  ray.set(origin, dir);
  const hits = ray.intersectObjects(sceneObjects);
  if (hits.length === 0) return false;

  const hit = hits[0];
  const obj = hit.object;
  const dist = origin.distanceTo(hit.point);
  const CLOSE = 3.0;
  if (!gameOver && obj.userData && obj.userData.enemy && obj.userData.part === 'head' && dist <= CLOSE) {
    // enemies 配列から該当グループを探して破棄
    const grp = obj.parent; // headはグループ直下
    // sceneObjects からも除外
    const removed = [];
    grp.traverse((n) => {
      if (n.isMesh) removed.push(n);
    });
    for (const m of removed) {
      const idx = sceneObjects.indexOf(m);
      if (idx >= 0) sceneObjects.splice(idx, 1);
    }
    // enemies から消す
    for (let i = enemies.length - 1; i >= 0; i--) {
      if (enemies[i].group === grp) enemies.splice(i, 1);
    }
    scene.remove(grp);
    console.log('Enemy down');
    return true;
  }
  return false;
}

function triggerGameOver() {
  if (gameOver) return;
  gameOver = true;
  // 止める
  playerVelocity.set(0, 0, 0);
  // HUD/Overlay
  const el = document.getElementById('gameOver');
  if (el) el.style.display = 'flex';
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
  const originL = e.shoulderL.localToWorld(new THREE.Vector3(0, 0, 0));
  const originR = e.shoulderR.localToWorld(new THREE.Vector3(0, 0, 0));
  const aimL = new THREE.Vector3().subVectors(playerPos, originL).normalize();
  const aimR = new THREE.Vector3().subVectors(playerPos, originR).normalize();

  // 扇状にばら撒く
  const spread = Math.PI / 3; // 60度
  for (let i = 0; i < ENEMY_BURST_COUNT; i++) {
    const t = (i / (ENEMY_BURST_COUNT - 1)) - 0.5; // -0.5..0.5
    const angle = t * spread;
    // Lから
    const dirL = aimL.clone();
    yawPitch(dirL, angle * 0.7, angle * 0.2);
    dirL.normalize().multiplyScalar(ENEMY_BULLET_SPEED);
    spawnBullet(originL, dirL);
    // Rから
    const dirR = aimR.clone();
    yawPitch(dirR, angle * 0.7, -angle * 0.2);
    dirR.normalize().multiplyScalar(ENEMY_BULLET_SPEED);
    spawnBullet(originR, dirR);
  }
}

function yawPitch(vec, yaw, pitch) {
  // vec を基準にヨー/ピッチずらす（近似）。
  const m = new THREE.Euler(pitch, yaw, 0, 'YXZ');
  vec.applyEuler(m);
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
