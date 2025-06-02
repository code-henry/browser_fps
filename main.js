import * as THREE from './three.module.js';
import { PointerLockControls } from './PointerLockControls.js';

// シーン・カメラ・レンダラー
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xffffff);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.y = 5;

const renderer = new THREE.WebGLRenderer();
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

// 光源
const light = new THREE.DirectionalLight(0xffffff, 1);
light.position.set(10, 20, 10);
scene.add(light);

// 地面
const groundGeometry = new THREE.PlaneGeometry(1000, 1000);
const groundMaterial = new THREE.MeshStandardMaterial({ color: 0xeeeeee });
const ground = new THREE.Mesh(groundGeometry, groundMaterial);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

// ビル群を配置
const buildingMaterial = new THREE.MeshStandardMaterial({ color: 0xcccccc });

for (let x = -100; x <= 100; x += 20) {
  for (let z = -100; z <= 100; z += 20) {
    const height = 20 + Math.random() * 60;
    const geometry = new THREE.BoxGeometry(10, height, 10);
    const building = new THREE.Mesh(geometry, buildingMaterial);
    building.position.set(x, height / 2, z);
    scene.add(building);
  }
}

// PointerLockControls で移動
const controls = new PointerLockControls(camera, document.body);
scene.add(controls.getObject());

document.body.addEventListener('click', () => {
  controls.lock();
});

// 移動制御
const keys = {};
document.addEventListener('keydown', e => keys[e.code] = true);
document.addEventListener('keyup', e => keys[e.code] = false);

function animate() {
  requestAnimationFrame(animate);

  const speed = 0.2;
  if (keys["KeyW"]) controls.moveForward(speed);
  if (keys["KeyS"]) controls.moveForward(-speed);
  if (keys["KeyA"]) controls.moveRight(-speed);
  if (keys["KeyD"]) controls.moveRight(speed);

  renderer.render(scene, camera);
}

animate();
