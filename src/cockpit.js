// cockpit.js — first-person cockpit interior.
//
// Built in code rather than reused from the exported airframe. The external
// model is designed to be seen from outside: its canopy is a closed shell and
// its "interior" is a seat block and a coaming placed to read at chase-camera
// distance. Sitting a camera inside it would put you behind opaque geometry
// with nothing sensibly framed. A purpose-built interior is also what real
// flight games ship, for exactly this reason.
//
// The whole assembly is parented to the CAMERA, not the aircraft. In the
// cockpit the pilot and the airframe move as one, so anything attached to the
// camera is automatically correct — including under camera shake, where a
// cockpit rigidly fixed to the jet would visibly slide against the view.
import * as THREE from 'three';

/** Where the pilot's eye sits in the aircraft's local frame (forward = +Z). */
export const EYE_OFFSET = new THREE.Vector3(0, 1.02, 1.45);

function frameMat(color, rough = 0.62, metal = 0.35) {
  return new THREE.MeshStandardMaterial({
    color, roughness: rough, metalness: metal, side: THREE.DoubleSide,
  });
}

/**
 * Build the interior. Dimensions are in camera-local units at the near end of
 * the view, so everything is small — it sits roughly 0.35–1.2 units in front of
 * the eye, well clear of the 2.0 near plane once scaled.
 */
export function createCockpit() {
  const root = new THREE.Group();
  root.name = 'CockpitInterior';

  const dark = frameMat(0x1b2027, 0.7, 0.25);
  const panel = frameMat(0x12161b, 0.85, 0.1);
  const trim = frameMat(0x2a323c, 0.55, 0.5);
  const glassTint = new THREE.MeshStandardMaterial({
    color: 0x8fd8ff, transparent: true, opacity: 0.05,
    roughness: 0.06, metalness: 0.0, side: THREE.DoubleSide, depthWrite: false,
  });

  // ---- Coaming: the dark shroud along the bottom of the view --------------
  // A shallow curved shelf. This is the single most important piece — it gives
  // the eye a foreground reference, without which a first-person view reads as
  // a floating camera rather than a cockpit.
  const coamShape = new THREE.Shape();
  coamShape.moveTo(-1.30, 0);
  coamShape.quadraticCurveTo(0, 0.30, 1.30, 0);
  coamShape.lineTo(1.30, -0.55);
  coamShape.lineTo(-1.30, -0.55);
  coamShape.closePath();
  const coaming = new THREE.Mesh(
    new THREE.ExtrudeGeometry(coamShape, { depth: 0.30, bevelEnabled: true,
      bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 2 }),
    dark);
  coaming.position.set(0, -0.46, -1.28);
  root.add(coaming);

  // Glare shield lip catching the sun
  const lip = new THREE.Mesh(new THREE.BoxGeometry(2.62, 0.045, 0.16), trim);
  lip.position.set(0, -0.30, -1.20);
  lip.rotation.x = -0.22;
  root.add(lip);

  // ---- Instrument panel, angled back toward the pilot --------------------
  const ip = new THREE.Mesh(new THREE.BoxGeometry(2.10, 0.78, 0.06), panel);
  ip.position.set(0, -0.86, -1.12);
  ip.rotation.x = 0.38;
  root.add(ip);

  // MFD bezels — three screens, faintly self-lit so they read in shadow.
  const mfdGlass = new THREE.MeshStandardMaterial({
    color: 0x0a1a18, emissive: 0x0d3a33, emissiveIntensity: 0.55,
    roughness: 0.35, metalness: 0.1,
  });
  for (const [x, w, h] of [[-0.62, 0.44, 0.40], [0, 0.50, 0.44], [0.62, 0.44, 0.40]]) {
    const bezel = new THREE.Mesh(new THREE.BoxGeometry(w + 0.06, h + 0.06, 0.03), trim);
    bezel.position.set(x, -0.84, -1.10);
    bezel.rotation.x = 0.38;
    root.add(bezel);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mfdGlass);
    screen.position.set(x, -0.833, -1.086);
    screen.rotation.x = 0.38;
    root.add(screen);
  }

  // ---- Canopy frame ------------------------------------------------------
  // Windscreen bow plus two rails. Kept thin: the frame should say "cockpit"
  // at the edge of vision without eating the part of the screen you fight in.
  const bowGeo = new THREE.TorusGeometry(1.26, 0.032, 8, 40, Math.PI);
  const bow = new THREE.Mesh(bowGeo, dark);
  bow.position.set(0, -0.16, -1.34);
  bow.rotation.x = 0.10;
  root.add(bow);

  // Centre post of the windscreen, foreshortened so it doesn't split the HUD.
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.30, 0.05), dark);
  post.position.set(0, 0.92, -1.33);
  root.add(post);

  for (const sx of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.055, 1.5), dark);
    rail.position.set(sx * 1.14, -0.10, -0.62);
    rail.rotation.y = sx * 0.10;
    rail.rotation.z = sx * -0.06;
    root.add(rail);

    // Side console tops, just in peripheral vision.
    const console_ = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.06, 1.1), panel);
    console_.position.set(sx * 1.02, -0.72, -0.60);
    console_.rotation.z = sx * 0.16;
    root.add(console_);
  }

  // Canopy glass — a faint tint so the sun grazes it, no more.
  const glass = new THREE.Mesh(new THREE.SphereGeometry(1.34, 20, 14,
    0, Math.PI * 2, 0, Math.PI * 0.55), glassTint);
  glass.position.set(0, -0.20, -0.55);
  glass.rotation.x = Math.PI;
  root.add(glass);

  root.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  // Drawn after the world so it always occludes correctly at the near plane.
  root.renderOrder = 2;
  return root;
}
