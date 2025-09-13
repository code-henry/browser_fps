// main.js

import * as THREE from './three.module.js';
import { createScene } from './scene.js';
import { setupControls, handleMovement, handleMovementHorizontalOnly } from './controls.js';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from './config.js';

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
const leftAnchor = new THREE.Vector3();
const rightAnchor = new THREE.Vector3();

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

  const hitPoint = intersects[0].point.clone();

  if (isLeft) {
    leftAnchor.copy(hitPoint);
    isGrappleLeft = true;

    // (3) 最初にラインを作成
    leftRope = createRopeLine('left', leftAnchor);

    // （ここで即座に updateRopeLine を呼んで、同じフレーム内で「playerPos→アンカー」に上書きする）
    updateRopeLine(leftRope, leftAnchor);

    console.log('Left wire deployed to building at:', leftAnchor);
  } else {
    rightAnchor.copy(hitPoint);
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


function animate() {
  requestAnimationFrame(animate);

  const time = performance.now();
  const delta = (time - prevTime) / 1000;
  prevTime = time;



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

animate();
















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
  e.preventDefault();  // ブラウザ標準の右クリックメニューを抑止
  if (!isScoped) {
    // スコープON
    isScoped = true;
    camera.fov = zoomedFov;
    camera.updateProjectionMatrix();
    scopeOverlay.style.display = 'block';
  }
});

// 右ボタンを離すとスコープOFF
window.addEventListener('mouseup', (e) => {
  if (e.button === 2 && isScoped) {
    // スコープOFF
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
  if (e.button === 0) { // 左ボタン（射撃）
    // ① カメラから前方にレイを飛ばす
    const shootRaycaster = new THREE.Raycaster();
    const shootOrigin = camera.getWorldPosition(new THREE.Vector3());
    const shootDirection = new THREE.Vector3(0, 0, -1)
      .applyQuaternion(camera.quaternion)
      .normalize();
    shootRaycaster.set(shootOrigin, shootDirection);

    // ② sceneObjects（BoxGeometry etc.）との当たり判定を行う
    const shootIntersects = shootRaycaster.intersectObjects(sceneObjects);
    if (shootIntersects.length > 0) {
      // 一番近いヒット情報
      const hitInfo = shootIntersects[0];
      const hitPoint = hitInfo.point;
      const hitNormal = hitInfo.face.normal;

      console.log('Shoot hit at', hitPoint, 'on object', hitInfo.object);

      // ③ 既存のヒットマーカーを削除
      if (tempHitMarker) {
        scene.remove(tempHitMarker);
        tempHitMarker.geometry.dispose();
        tempHitMarker.material.dispose();
        tempHitMarker = null;
      }

      // ④ 新たにヒットマーカーを配置
      tempHitMarker = new THREE.Mesh(hitMarkerGeometry, hitMarkerMaterial);
      // ヒットポイントに少しオフセットを加えて表示（法線方向に沿って0.1だけ浮かせる）
      const offsetPos = hitPoint.clone().add(hitNormal.clone().multiplyScalar(0.1));
      tempHitMarker.position.copy(offsetPos);
      scene.add(tempHitMarker);

      // ⑤（オプション）ヒットしたオブジェクトを少し変色させる例
      if (hitInfo.object.material) {
        hitInfo.object.material.color.set(0xffff00); // 黄色に変更
        // 0.2秒後に元に戻す（setTimeout でデモ的にリセット）
        setTimeout(() => {
          hitInfo.object.material.color.set(0x808080); // 元の色（空灰色）に戻す
        }, 200);
      }
    } else {
      console.log('Shoot missed (no hit)');
    }
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
