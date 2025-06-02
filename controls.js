import * as THREE from './three.module.js';
import { PointerLockControls } from './PointerLockControls.js';

let move = { forward: false, backward: false, left: false, right: false };
let velocity = new THREE.Vector3();  // 速度ベクトル
let canJump = false;

export function setupControls(camera) {
  const controls = new PointerLockControls(camera, document.body);
  document.body.addEventListener('click', () => controls.lock());

  document.addEventListener('keydown', e => {
    if (e.code === 'KeyW') move.forward = true;
    if (e.code === 'KeyS') move.backward = true;
    if (e.code === 'KeyA') move.left = true;
    if (e.code === 'KeyD') move.right = true;
    if (e.code === 'Space' && canJump) {
      velocity.y += 1.3;  // ジャンプ力
      canJump = false;
    }
  });

  document.addEventListener('keyup', e => {
    if (e.code === 'KeyW') move.forward = false;
    if (e.code === 'KeyS') move.backward = false;
    if (e.code === 'KeyA') move.left = false;
    if (e.code === 'KeyD') move.right = false;
  });

  return controls;
}
export function handleMovement(controls) {
  const delta = 0.016; // 時間の刻み（仮）
  const speed = 5.0;
  const damping = 10.0;

  velocity.x -= velocity.x * damping * delta;
  velocity.z -= velocity.z * damping * delta;
  velocity.y -= 4.8 * delta; // 重力

  if (move.forward) velocity.z += speed * delta;
  if (move.backward) velocity.z -= speed * delta;
  if (move.left) velocity.x -= speed * delta;
  if (move.right) velocity.x += speed * delta;

  controls.moveRight(velocity.x);
  controls.moveForward(velocity.z);

  const object = controls.getObject();
  object.position.y += velocity.y;

  // 地面で止まる処理
  if (object.position.y < 5) {
    velocity.y = 0;
    object.position.y = 5;
    canJump = true;
  }
}



