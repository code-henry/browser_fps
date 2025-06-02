import * as THREE from './three.module.js';
import { createScene } from './scene.js';
import { setupControls, handleMovement } from './controls.js';

const { scene, camera, renderer } = createScene();

// controls を setupControls から取得する
const controls = setupControls(camera);

function animate() {
  requestAnimationFrame(animate);
  handleMovement(controls);
  renderer.render(scene, camera);
}

animate();
